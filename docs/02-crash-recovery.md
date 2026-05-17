# Deep Dive: Crash Recovery

> Extends PDF §A.2. Focuses on the IPC handoff sequence and the race
> conditions that almost made me pick a different design.

---

## The handoff sequence, with the gotchas

The PDF's Figure 3 shows the happy path. Here's what can go wrong and how
the design handles it.

```
T+0       Worker A crashes (SIGSEGV or access violation)
T+20      Supervisor detects exit, captures exit code
T+30      Supervisor sends WorkerLost(worker_id, in_flight_ids) to API
T+50      Supervisor sends WorkerPromote to API for Worker B
T+70      API Server consults retry policy for each in-flight request
T+80      API Server reissues InferenceJob to Worker B for replayable jobs
T+150     Worker B accepts the job; begins prefill
T+280     First token emits from Worker B
T+500     Supervisor's posix_spawn of replacement warm worker returns
T+~3s     Replacement warm worker emits WorkerReady
```

---

## Gotcha #1 — what if the API Server hasn't yet seen `WorkerPromote` when a new client request arrives?

**Window.** T+30 to T+50 — Supervisor knows the worker is gone, API
Server hasn't been told yet.

**Risk.** API Server happily tries to dispatch to the dead worker, gets
an EPIPE, then has to figure out what to do.

**Handling.** The API Server's worker handle is a tagged union:
`ACTIVE(handle) | TRANSITIONING | UNAVAILABLE`. Any IPC write that returns
EPIPE / ECONNRESET flips the state to `TRANSITIONING` and queues the
request in a small in-memory buffer (max 64 requests). When
`WorkerPromote` arrives, the buffer flushes onto the new worker.

If `WorkerPromote` doesn't arrive within 2 s, the buffered requests fail
with `WORKER_UNAVAILABLE`. This shouldn't happen in practice — Supervisor
sends `WorkerPromote` ~20 ms after `WorkerLost` — but the timeout exists
so the API Server never wedges.

---

## Gotcha #2 — what if Worker A crashes AFTER its tokens are in flight but BEFORE the API has flushed them to the client?

**Window.** Worker B has emitted tokens to the API Server's IPC read
buffer, then crashed before the API Server's event loop pulled them out.

**Risk.** Tokens are technically already "emitted" from the worker's POV,
but the API never sent them. Replaying the request would generate
different tokens (different RNG state).

**Handling.** Tokens are emitted via SSE only after the API Server has
flushed its IPC read buffer for that request. The worker's crash means
those buffered tokens are lost AS IF they were never generated. The
client only sees tokens that made it to the wire.

If `tokens_so_far` is empty when the worker dies, we replay the prompt.
If it's non-empty, we emit `WORKER_CRASHED_MID_STREAM` with a
`resume_token` and the client decides what to do.

**Subtle point.** Some token might have been "emitted" by the worker in
the sense that its sampling decision was made, but the bytes were lost
in the crashed worker's IPC buffer. From the system's outside view, that
token never existed. This is the right boundary because it's the only
one observable to clients.

---

## Gotcha #3 — what if the warm worker fails its first real job?

**Window.** Right after `WorkerPromote`, on the first replayed
`InferenceJob`.

**Risk.** Cascading crash: Worker A died, Worker B also dies during
takeover. Naive handling would loop forever.

**Handling.** The Supervisor tracks a `consecutive_crash_count` per
worker pool. If two workers crash within 1 s of each other, the pool is
marked `UNHEALTHY` for 10 s. During the unhealthy window:

- New clients get `503 WORKER_UNAVAILABLE` with `Retry-After: 5`.
- In-flight requests get terminal errors.
- The Supervisor cold-spawns a new worker (no warm partner) with
  exponential backoff between attempts.

After the unhealthy window, if a worker has been stable for 30 s, the
warm pool is rebuilt.

---

## Gotcha #4 — what if the user closes their laptop during recovery?

**Window.** Anywhere in the recovery sequence.

**Risk.** OS sleep is a stop-the-world that suspends our processes for
arbitrary duration. The heartbeat-based liveness check would falsely
flag everyone as crashed.

**Handling.** Every process has a thread that listens for OS power
notifications (`NSWorkspaceWillSleepNotification` on mac;
`WM_POWERBROADCAST + PBT_APMSUSPEND` on Windows). On sleep:

1. The current heartbeat cycle is suspended.
2. All in-flight requests are marked `SLEEP_PAUSED`.
3. Workers complete any tokens already in their decode buffer, then idle.

On resume:

1. Heartbeat resumes.
2. NPU/ANE probe-graph runs (in case the driver got confused; this is
   common on Windows fast-startup).
3. If probe passes, in-flight requests resume.
4. If probe fails, fallback ladder kicks in.

This is the one place the design genuinely needs the OS to cooperate.
Without the power notification, a 5-minute sleep would look like a
catastrophic agent failure.

---

## Why we don't checkpoint the KV-cache

Tempting idea: every N tokens, snapshot the KV-cache to disk, so a crash
can resume from that snapshot rather than re-prefilling.

Rejected for three reasons:

1. **Cost during normal operation.** KV-cache is GB-scale. Even an
   incremental snapshot (only the new entries since last) costs ~10-20%
   of throughput. The tax is paid on every request, but the benefit only
   applies to the rare ones that crash.

2. **Disk space.** With 4 concurrent streams each generating snapshots,
   we'd burn through tens of GB of disk per session. We have a 50 MB
   budget.

3. **Restore complexity.** Loading a checkpoint onto a fresh worker
   requires the new worker to be on a backend that produces bit-
   compatible cache layouts. If the original ran on NPU and the new
   worker fell back to CPU, the cache is incompatible. We'd need to
   re-prefill anyway.

The honest answer is: crashes are rare; the cost should sit on the
crashing path, not on the well-behaved one. The resume-token machinery
in §A.2 is the right compromise — clients pay for the recovery, but
only when they actually need it.

---

## What "successful recovery" means, precisely

The PDF says "the client connection is never closed." Let me be more
precise:

| Request type | Outcome on Worker A crash |
|---|---|
| Non-streaming, idempotency key set | Transparently retried. Latency budget +280 ms. Client sees no error. |
| Non-streaming, no idempotency key | Returns `WORKER_CRASHED_RETRY` with `recoverable: true`. SDK does NOT auto-retry (no idempotency guarantee). Caller decides. |
| Streaming, 0 tokens emitted | Replayed on new worker. Client receives a single `retry` SSE event then normal token stream. |
| Streaming, ≥1 token emitted | `WORKER_CRASHED_MID_STREAM` with `resume_token`. Client may call `/v1/inference/resume`. |

The "never closed" promise is about the TCP connection to the API Server,
not about the request semantics. The TCP connection survives any single
worker crash; what happens *over* that connection depends on the request
type.
