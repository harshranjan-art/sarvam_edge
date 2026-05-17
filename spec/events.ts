/**
 * Sarvam Edge Agent — TypeScript event payload contracts
 *
 * Single source of truth for the shape of every SSE event, error envelope,
 * and SDK return type that crosses the loopback boundary between the agent
 * and the shell SDK (and, by extension, between the SDK and the MFEs).
 *
 * If a payload's shape differs between this file, the OpenAPI spec, and the
 * PDF, this file is wrong and should be fixed. The runtime is what the
 * runtime is.
 */

// =====================================================================
// Identifiers
// =====================================================================

/** `req_` followed by a ULID. Echoed in every event for this request. */
export type RequestId = string;

/** `name@semver` form, e.g. `doc-qa@2.4.0`. Scheduler fairness key. */
export type MFEId = string;

/** Per-process worker identifier, e.g. `w_a91f`. */
export type WorkerId = string;

// =====================================================================
// Request shape
// =====================================================================

export type Priority = "user" | "background";

export type DataResidency = "on-device" | "any";

export interface InferenceRequest {
  model: "sarvam-7b-indic";
  prompt: string;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  seed?: number;
}

export interface RequestOptions {
  mfeId: MFEId;
  priority?: Priority;            // default: "user"
  dataResidency?: DataResidency;  // default: "any"
  idempotencyKey?: string;
  signal?: AbortSignal;
  queueTimeoutMs?: number;        // default: 10_000
  runTimeoutMs?: number;          // default: 60_000
}

// =====================================================================
// Backend identification
// =====================================================================

export type Backend =
  | "qnn-npu"          // Qualcomm Hexagon NPU (Windows ARM64)
  | "ane"              // Apple Neural Engine
  | "metal-gpu"        // Apple Metal Performance Shaders
  | "cpu-onnxrt"       // ONNX Runtime CPU EP (Windows)
  | "cpu-accelerate"   // Apple Accelerate / BNNS
  | "cloud";           // Sarvam cloud API (opt-in only)

// =====================================================================
// SSE event union
// =====================================================================
//
// Every SSE event has the shape `event: <name>\ndata: <json>\n\n`. The
// `event` value maps to the `type` discriminator below. MFEs SHOULD switch
// on `type` exhaustively; the SDK exposes this as a typed callback.

export type EdgeEvent =
  | QueuedEvent
  | PositionUpdateEvent
  | DispatchedEvent
  | TokenEvent
  | DegradedEvent
  | DoneEvent
  | ErrorEvent
  | CancelledEvent;

/**
 * Fired immediately after `POST /v1/inference` if the agent cannot dispatch
 * the request right away (all 4 slots in use). If the agent dispatches
 * synchronously, `dispatched` is fired without a preceding `queued`.
 *
 * - `position` is 0-indexed within this MFE's view of the queue.
 * - `eta_ms` is computed from observed token-rate of in-flight streams
 *   plus average prompt-time of queued requests; not a hard SLA.
 */
export interface QueuedEvent {
  type: "queued";
  request_id: RequestId;
  position: number;
  eta_ms: number;
  slots_in_use: number;
}

/**
 * Sent whenever a request ahead of this one in the queue is dispatched
 * or cancelled. Throttled to at most 1 per 500 ms per request to avoid
 * flooding slow consumers.
 */
export interface PositionUpdateEvent {
  type: "position_update";
  request_id: RequestId;
  position: number;
  eta_ms: number;
}

/**
 * Fired when the agent has accepted the job into a worker slot. From this
 * point on, the SDK starts receiving `token` events.
 */
export interface DispatchedEvent {
  type: "dispatched";
  request_id: RequestId;
  worker_id: WorkerId;
  backend: Backend;
  wait_ms: number;
}

/** Streaming tokens. `index` is monotonically increasing from 0. */
export interface TokenEvent {
  type: "token";
  request_id: RequestId;
  text: string;
  index: number;
  logprob?: number;
}

/**
 * The agent had to swap backends mid-request (or before first token).
 * The stream continues normally; this is informational. The SDK exposes
 * a callback so the MFE can show a "running slower than usual" hint.
 *
 * `session_scoped: true` means the failure is sticky for the remainder of
 * the agent's lifetime (e.g. NPU driver removed). `session_scoped: false`
 * is transient (e.g. ANE thermal throttling); the next request may go back
 * to the preferred backend.
 */
export interface DegradedEvent {
  type: "degraded";
  request_id: RequestId;
  from_backend: Backend;
  to_backend: Backend;
  expected_latency_factor: number;
  reason: string;
  session_scoped: boolean;
}

/** Terminal: success. */
export interface DoneEvent {
  type: "done";
  request_id: RequestId;
  tokens_emitted: number;
  ms_first_token: number;
  ms_total: number;
  finish_reason: "stop" | "length";
}

/** Terminal: error. See `ErrorCode` for possible values. */
export interface ErrorEvent {
  type: "error";
  request_id: RequestId;
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  retry_after_ms?: number;
  resume_token?: string;     // only set when code === "WORKER_CRASHED_MID_STREAM"
}

/** Terminal: cancelled (by client, timeout, or scheduler eviction). */
export interface CancelledEvent {
  type: "cancelled";
  request_id: RequestId;
  by: "client" | "timeout" | "scheduler";
}

// =====================================================================
// Error codes
// =====================================================================

export type ErrorCode =
  | "BAD_TOKEN"
  | "ORIGIN_NOT_ALLOWED"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "AGENT_AT_CAPACITY"
  | "WORKER_UNAVAILABLE"
  | "WORKER_CRASHED_RETRY"           // worker died; SDK auto-retried successfully
  | "WORKER_CRASHED_MID_STREAM"      // worker died after tokens emitted; resume_token provided
  | "DEVICE_UNAVAILABLE_DEGRADED"
  | "QUEUE_TIMEOUT"
  | "RUN_TIMEOUT"
  | "QUEUE_FULL"
  | "WORKER_BINARY_MISSING"
  | "INTERNAL_ERROR";

/**
 * Subset of error codes the SDK considers safe to auto-retry on. Always
 * requires that the caller set `idempotencyKey`. Without that, the SDK
 * surfaces the error to the MFE for explicit handling.
 */
export const AUTO_RETRY_CODES: ReadonlySet<ErrorCode> = new Set([
  "AGENT_AT_CAPACITY",
  "WORKER_UNAVAILABLE",
  "WORKER_CRASHED_RETRY",
]);

// =====================================================================
// SDK return type
// =====================================================================
//
// What the shell SDK gives back to an MFE on `inference.submit(...)`.
// The MFE binds to `state` reactively and listens for events via
// `subscribe()`.

export interface InferenceHandle {
  readonly requestId: RequestId;
  readonly state: InferenceState;
  subscribe(listener: (e: EdgeEvent) => void): () => void;   // returns unsubscribe
  cancel(): void;                                            // idempotent
  /** Resolves on `done`, rejects on `error` (non-recoverable) or `cancelled`. */
  result(): Promise<InferenceResult>;
}

export type InferenceState =
  | "submitted"
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface InferenceResult {
  completion: string;
  backend: Backend;
  ms_total: number;
  tokens_emitted: number;
}

// =====================================================================
// Capabilities response (from GET /v1/capabilities)
// =====================================================================

export interface Capabilities {
  agent_version: string;
  api_version: "1.0";
  model: {
    id: "sarvam-7b-indic";
    context_size: number;
    quantization: string;
  };
  backends: BackendStatus[];
  max_concurrent_requests: 4;
}

export interface BackendStatus {
  name: Backend;
  available: boolean;
  circuit_state: "closed" | "open" | "half_open";
  expected_latency_factor: number;
}
