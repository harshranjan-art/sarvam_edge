# Edge Cases — Exhaustive Catalog

> The PDF documents the failure modes that matter for the headline design.
> This doc is the rest of them — the ones a reviewer might check whether
> the design has actually thought about.
>
> Each entry follows the form **Scenario** → **Detection** → **Handling** →
> **Open question**. If a scenario has no open question, the handling is
> considered settled.

---

## A. Process lifecycle

### A.1 Supervisor crashes

**Detection.** External: launchd (macOS) / Service Control Manager (Windows)
notices the process died. Internal: API Server's heartbeat to the Supervisor
times out (3 missed pings × 500 ms = 1.5 s).

**Handling.** The whole agent is considered down. The watchdog restarts
the Supervisor, which respawns the API Server and Worker pool from scratch.
In-flight client requests fail with `WORKER_UNAVAILABLE` and `Retry-After: 5`.

**Open question.** Should the API Server attempt to survive a Supervisor
restart (it has its own TCP listener), and resync via a new Supervisor?
The current design says no — simpler is safer, and Supervisor crashes are
rare. But it's worth revisiting if real-world data shows the 5-second
outage is user-visible.

---

### A.2 API Server crashes but Supervisor lives

**Detection.** Supervisor's heartbeat to API Server times out, OR the
Supervisor's `waitpid` returns. (Both paths exist; whichever fires first wins.)

**Handling.** Supervisor respawns the API Server with the same listening
socket FD (passed via `SCM_RIGHTS` on macOS / `WSADuplicateSocket` on Windows).
Clients with open TCP connections see them RST'd and reconnect transparently.
Backoff: 1-2-4-8 s capped at 30 s. After 5 consecutive crashes within 60 s,
the Supervisor marks the agent `UNHEALTHY` and surfaces a notification.

**Open question.** Holding the listening socket across restarts means a buggy
API Server could thrash and clients wouldn't notice anything other than
slowness. Is that the right call? Probably yes — better than tearing every
client off — but it requires the API Server to be defensive about state it
might have left behind in shared memory.

---

### A.3 Worker pool exhaustion (warm worker also dies during recovery)

**Detection.** Within 1 s of `WorkerLost` for the active worker, the warm
worker also emits `WorkerLost` (or fails its first heartbeat after promotion).

**Handling.** Treated as a cascading-crash scenario:

1. Mark all in-flight requests as `WORKER_CRASHED_MID_STREAM` (clients can
   resume with `resume_token` if they have idempotency keys).
2. Set agent state to `UNHEALTHY`; all new requests get `503` + `Retry-After`.
3. Cold-spawn a new worker with **exponential backoff** (1-2-4-8-16 s,
   capped). No warm partner is spawned until the active one is `WORKER_READY`.
4. Once stable, re-establish the warm pool.

**Open question.** A cascading crash usually indicates a deterministic bug
(bad model weights, corrupted KV-cache file, OS-level driver issue). At what
point should the agent give up and prompt the user to reinstall? The current
threshold is "5 cold-start failures within 60 s" → notification to user; no
automatic retry beyond that point.

---

### A.4 Worker spawns but never sends `WorkerReady`

**Detection.** Supervisor's startup timer for the new worker fires (30 s
budget, generous to account for cold disk).

**Handling.** Kill the orphan worker, write a special crash dump labeled
`STARTUP_TIMEOUT`, and try once more. Two consecutive startup timeouts →
mark backend `UNAVAILABLE` and try the next one in the fallback ladder.

**Why two attempts.** Disk page-cache can be cold on first boot of the day.
A single failure isn't enough evidence to give up on a backend.

---

### A.5 Worker is alive but the inference call hangs

**Detection.** Worker has not emitted a token batch for `runTimeoutMs`
(default 60 s), AND the heartbeat is still passing.

**Handling.** API Server sends `InferenceCancel` IPC frame. If the worker
doesn't acknowledge within 2 s, the Supervisor escalates: `SIGTERM`,
then `SIGKILL` after another 2 s. Worker is treated as crashed from that
point.

**Open question.** This is the hardest case to design well — a worker that
deadlocks inside a driver call may not be killable cleanly. If the kill
hangs, the Supervisor needs an escape hatch (probably "spawn a replacement
and orphan the zombie"). Implementing that requires careful memory
accounting so we don't double-charge VRAM.

---

## B. Hardware / drivers

### B.1 NPU driver returns success but produces gibberish

**Detection.** The probe-graph runs after each driver reload as part of
HALF-OPEN → CLOSED transition. It expects a known fixed-output tensor; if
the output differs, the breaker stays OPEN and we log a "zombie driver"
event.

**Handling.** Permanent fallback to CPU for the session; user notification
suggests a driver update.

**Why this matters.** This actually happens — there's a documented Qualcomm
Hexagon issue (rare, but real) where after sleep/wake the device responds
to `QnnGraph_execute` with success codes but garbage outputs.

---

### B.2 NPU goes down during a streaming request

**Detection.** Worker's QnnGraph call returns `ERROR_DEVICE_REMOVED` while
the request has already emitted some tokens.

**Handling.**

1. Emit `degraded` SSE event with `to_backend: cpu-onnxrt`.
2. Re-prefill on CPU starting from `original_prompt + tokens_emitted_so_far`.
3. Continue streaming from where we left off.

Critical detail: the **re-prefill is on a longer prompt**, so the time-to-
next-token after the degraded event is roughly the prefill latency at that
new length. Clients see a noticeable pause; this is unavoidable and is
why the `expected_latency_factor` field exists.

---

### B.3 ANE works for prefill but fails on a specific decoder op

**Detection.** First N tokens decode fine on ANE; token N+1 returns
`kCMErrorUnsupportedOperation` because that decoder step hit an op the
ANE compiler didn't support for this input shape (this can happen with
dynamic shapes).

**Handling.** Mark the op as ANE-incompatible **for this model**, fall
back to Metal for the remaining decoder steps of THIS request, and emit
`degraded`. Other requests on the same agent continue to try ANE for
prefill — the failure is op-and-shape-specific, not session-wide.

**Open question.** Should we maintain a learned blocklist of (op, shape)
tuples that have failed before, to skip ANE upfront on subsequent requests?
Pro: faster average latency. Con: cache invalidation on driver/OS updates
is hard. Current design says no; revisit with telemetry.

---

### B.4 macOS thermal pressure mid-stream

**Detection.** `[NSProcessInfo thermalState] == .critical`, AND we're
on battery, AND charge < 30%.

**Handling.** Future-tense decision: should already-running streams be
asked to yield to a cheaper backend? Current design says **no** — the
streaming-no-yield invariant from §B.3 of the PDF holds even under thermal
pressure, because mid-stream backend swaps lose KV-cache. Instead, the
scheduler refuses to dispatch new requests to ANE until thermal state
drops back to `.fair`.

---

### B.5 User disconnects external GPU during inference (Mac Pro / eGPU)

**Detection.** `MTLDeviceWasRemovedNotification`.

**Handling.** If the device was actively serving a request, treat as
mid-stream crash with a special error code `EXTERNAL_GPU_REMOVED`. Otherwise,
recompute the backend ladder and continue normally.

---

## C. Client / network

### C.1 Client closes the TCP connection mid-stream

**Detection.** `recv()` on the SSE socket returns 0 (clean close) or `ECONNRESET`.

**Handling.** API Server sends `InferenceCancel` to the worker, frees the
slot, emits no further SSE events (the client isn't listening). Supervisor
is unaffected. The cancelled request appears as `cancelled` in the agent's
local request log.

---

### C.2 Client connects but never sends a request

**Detection.** TCP connection idle for 30 s without `POST`.

**Handling.** Close the connection. This is a defensive measure against
trivial connection-leak bugs in the SDK or in MFE code.

---

### C.3 Client sends a request with a stale auth token

**Detection.** Token signature is valid but the agent's session ID has
rotated (typical after an agent restart).

**Handling.** Return `401 BAD_TOKEN` with `recoverable: true`. The SDK
re-fetches via the native helper and retries. This adds ~50 ms to the
first request after an agent restart; subsequent requests are normal.

---

### C.4 Origin header is missing

**Detection.** No `Origin` header on a request that isn't from an Electron
shell (Electron sets `Origin: file://...` which we validate by bundle ID).

**Handling.** `403 ORIGIN_NOT_ALLOWED`. We never serve a request without a
verifiable origin claim; this is the only line of defense between a
malicious local app and the agent.

---

### C.5 Two MFEs send requests with the same `X-Idempotency-Key`

**Detection.** Idempotency key is currently in flight from a different MFE.

**Handling.** `409 DUPLICATE_IDEMPOTENCY_KEY`. The keys are scoped to the
agent globally, not per-MFE — easier to reason about, and prevents one
MFE from accidentally "joining" another MFE's request.

---

## D. Scheduler

### D.1 An MFE submits 100 background requests at once

**Detection.** MFE's per-MFE queue length hits the cap (32).

**Handling.** Subsequent submissions get `QUEUE_FULL` immediately. The MFE
must implement its own back-pressure. The SDK exposes the queue depth so
MFEs can self-limit without trial-and-error.

---

### D.2 A background request ages into priority above a fresh user request

**Detection.** Aging boost (1 weight per 5 s queued) accumulates on a
background request; meanwhile a user request from the same MFE arrives.

**Handling.** WDRR picks based on effective weight. After 20 s queued, a
background request's weight is `0.25 + 4 = 4.25`, exceeding a fresh user
request's `1.0`. The background request runs first.

**Is this surprising?** Yes, intentionally so. Without aging, background
work starves indefinitely. With it, a *very* old background request can
overtake a *new* user request. The 5-second-per-+1 rate is tuned so this
flip happens around 15-20 seconds, which is roughly when the user would
otherwise abandon the page anyway.

---

### D.3 An MFE cancels a queued request between dispatch decision and dispatch

**Detection.** Race condition: scheduler has picked the request and is about
to call `dispatch()`, the `AbortController` fires, request is removed from
queue.

**Handling.** The scheduler's dispatch path is `pop() → state.set("running")
→ fetch()`. The `pop()` is atomic; if it succeeded, the request is committed
to running. If the abort fires AFTER `pop()`, the in-flight cancel path
applies (close fetch → agent sees TCP RST → frees slot). No window exists
where a request is "popped but not dispatched."

---

### D.4 The agent goes from 4 in-flight to 0 in-flight in one tick

**Detection.** All 4 active requests complete (or are cancelled) in the same
event loop tick.

**Handling.** The scheduler's `pump()` is called once per slot release. With
4 simultaneous releases, `pump()` runs 4 times in sequence, dispatching the
top 4 queued requests in WDRR order. Re-entrancy is fine because `pump()`
is synchronous.

---

## E. Storage / disk

### E.1 Disk fills up due to crash-dump accumulation

**Detection.** `statvfs()` shows the agent's data dir has < 100 MB free.

**Handling.**

1. LRU-prune the `crashes/` directory until under the budget.
2. If still under, rate-limit new crash dumps to 1 per 10 min.
3. If still under, refuse to write crash dumps and log a single warning
   per minute.

We never refuse to run inference because of disk fill — losing crash dumps
is acceptable, losing user-facing functionality is not.

---

### E.2 Antivirus quarantines the worker binary between launches

**Detection.** Supervisor's `posix_spawn` / `CreateProcessW` returns
`ENOENT` / `ERROR_FILE_NOT_FOUND` for a binary that existed at install.

**Handling.** Surface `WORKER_BINARY_MISSING` to the API Server. API Server
returns it to clients with a special hint in the error message ("check
your antivirus quarantine"). Agent state goes to `UNHEALTHY` until the
binary returns or the user reinstalls.

---

### E.3 Model weights file is corrupted on disk

**Detection.** Worker's mmap succeeds but the integrity hash (computed
lazily on first page-in of the magic-bytes section) doesn't match.

**Handling.** Worker emits `MODEL_WEIGHTS_CORRUPT`, exits cleanly. Supervisor
does NOT respawn — this is a fatal install-level error. User is prompted to
reinstall.

---

## F. OS-level

### F.1 macOS App Nap freezes the agent

**Detection.** Heartbeat between Supervisor and API Server / Worker exceeds
500 ms wall clock but only ~10 ms CPU time.

**Handling.** The agent registers as a `Background` activity with
`NSProcessInfo beginActivityWithOptions:` to opt out of App Nap. This is
done at Supervisor startup; verify it's still active on every heartbeat
miss before assuming the child is hung.

---

### F.2 Windows fast-startup leaves the agent in a half-resumed state

**Detection.** Process exists; pipe handles are open; but the worker's
NPU context is stale.

**Handling.** Probe-graph runs after every system resume (detected via
`WM_POWERBROADCAST` / `PBT_APMRESUMEAUTOMATIC`). If probe fails, the entire
worker pool is rebuilt — cheaper than trying to recover individual pieces.

---

### F.3 User logs out without quitting the shell

**Detection.** Agent receives `SIGTERM` (mac) / Windows session-end notification.

**Handling.** Graceful drain: stop accepting new requests, wait up to 5 s for
in-flight to complete, then `SIGKILL` workers and exit. Clients see the
connection close cleanly; the SDK reports this as a session-end, not an error.

---

## G. Security

### G.1 Local malware tries to connect to the loopback port

**Detection.** Connection comes in without a valid bearer token, or with
a stale one.

**Handling.** Return `401 BAD_TOKEN`. We do not log the attempt at INFO
level — that's how a malware could test if the agent is running. At DEBUG
level only, behind an opt-in.

---

### G.2 An MFE attempts to spoof another MFE's `X-MFE-Id`

**Detection.** Out of scope for the agent — `X-MFE-Id` is informational
only. The shell SDK assigns it based on MFE bundle origin and signs the
mapping with a short-lived HMAC the agent verifies. Spoofing is therefore a
shell-side concern, not an agent-side one.

**Why.** Making `X-MFE-Id` a security boundary would mean the agent has to
re-implement origin verification per request, doubling the work the shell
already does. Treat it as informational and put the boundary where it
belongs.

---

### G.3 Prompt-injection attempts via a malicious document being summarized

**Out of scope for the runtime.** The agent does not interpret prompts; it
streams tokens. Prompt-injection defense is the responsibility of the
calling MFE (input sanitization) and the model itself (instruction-tuning).
The runtime's only role is to not exfiltrate the prompt — which it doesn't,
unless Cloud fallback is admin-enabled.

---

## H. Things explicitly out of scope

These came up while designing but were deferred:

- **Multi-tenant**. The agent serves one OS user session at a time. Multi-
  user concurrent inference on a single workstation is not supported.
- **Model swap at runtime**. A second model would require either reload-and-
  restart or a second worker pool. Neither is in scope.
- **Cross-device sync**. If the user has two machines, each runs its own
  agent independently.
- **Telemetry pipeline**. The agent writes logs and crash dumps locally; how
  Sarvam collects them is a separate system.
- **Update mechanism**. The agent binary updates via the regular enterprise
  software distribution channel; the agent has no self-update logic.
