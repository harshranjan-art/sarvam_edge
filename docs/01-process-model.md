# Deep Dive: Process Model

> Extends PDF §A.1. Same conclusion, more detail on the IPC handshake and
> the resource accounting.

---

## Why the worker is a separate process, not a thread

Three concrete reasons:

1. **Crash containment.** A segfault inside ONNX Runtime or QnnGraph kills
   the process. We want the API Server to survive that.

2. **Memory accounting.** The OS can OOM-kill the worker without taking
   down the rest of the agent. With threads, the OOM killer would take
   the whole process.

3. **Driver bug isolation.** Hexagon NPU and Core ML drivers occasionally
   leak handles or corrupt thread-local state. A fresh process gets a
   clean slate; a fresh thread inherits the corruption.

The downside is IPC overhead. At ~50 tokens/sec we have ~20 ms per token
to budget; the IPC roundtrip via named pipes is ~50-100 μs, well under
1% of our budget.

---

## Worker startup sequence (detailed)

```
Supervisor                      Worker (newly spawned)
    │
    ├─ posix_spawn(args)──────▶ start
    │                              │
    │                              ├─ parse args (port, token, model path)
    │                              ├─ create IPC socket
    │                              ├─ connect to supervisor's pipe
    │   ◀─────────WorkerHello──────┤
    │   ───WorkerHelloAck─────────▶│
    │                              │
    │                              ├─ mmap weights file (4 GB)
    │                              │     ▲ DOMINANT COST: 1.5-2.5s
    │                              │     │ disk I/O + TLB faults
    │                              │
    │                              ├─ initialize backend (QNN / Core ML)
    │                              │     ▲ 300-800ms first time;
    │                              │     │ ~80ms with cached graph
    │                              │
    │                              ├─ run smoke test (5-token prefill)
    │                              │     ▲ catches "driver up but broken"
    │                              │
    │   ◀─────WorkerReady──────────┤
    │
    ├─ mark worker as ACTIVE / WARM (depending on slot)
    └─ start heartbeat timer (500ms)
```

The smoke test is what differentiates "process started" from "actually
ready to serve traffic." Without it, we'd hand the API Server a worker
that returns errors on the first real request.

---

## IPC handshake — Windows specifics

The named pipe is created by the Supervisor at startup:

```
\\.\pipe\sarvam-edge-worker-{nonce}
```

Where `{nonce}` is a per-launch random suffix. The Supervisor creates the
server end with `PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED`, and uses
overlapped I/O on a completion port for asynchronous reads.

The worker, on spawn, receives the pipe path as a command-line argument.
It opens the client end with `CreateFile(pipe_name, GENERIC_READ |
GENERIC_WRITE, ...)`. The connection is therefore unauthenticated; access
control is via the pipe's ACL (default: same-user-only).

**Worker discovery.** The Supervisor doesn't pass the pipe to the API
Server directly. Instead, after `WorkerReady`, the Supervisor sends a
`WorkerPromote` message to the API Server with the pipe's nonce. The API
Server opens its own connection to the named pipe by name. This way both
the Supervisor and the API Server have independent connections to the
worker — important for failure isolation (if one connection breaks, the
other still works).

---

## IPC handshake — macOS specifics

Unix domain sockets at:

```
$TMPDIR/sarvam-edge-worker-{nonce}.sock
```

Created by Supervisor with `socket(AF_UNIX, SOCK_STREAM, 0)` + `bind()` +
`listen()`. The socket file has `0600` permissions; the OS enforces user
isolation.

`SCM_RIGHTS` is used to pass the API Server's connected file descriptor
from Supervisor to API Server, so the API Server doesn't have to
reconnect on its own. This is the same trick NGINX uses for hot reload.

**Why not Mach ports.** Mach ports would be more idiomatic on macOS and
would give us per-message priority. They're also significantly more
complex and less well-documented for our case. UDS is the lowest-common-
denominator that works identically to the Windows named-pipe path; that
symmetry is worth the small performance loss.

---

## Resource budget per process

| Process | RSS at idle | RSS peak (steady state) | File handles | Network |
|---|---|---|---|---|
| Supervisor | ~20 MB | ~25 MB | ~10 (pipe, log files) | None |
| API Server | ~40 MB | ~60 MB (with 4 streams) | ~20 (pipes + client conns) | Loopback only |
| Worker (active) | ~6.0 GB | ~7.5 GB (KV-cache full) | ~15 (model files, pipes) | None |
| Worker (warm) | ~5.8 GB | ~5.8 GB (no cache, no clients) | ~12 | None |

Total: roughly 12-13 GB on a system actively serving 4 streams. The warm
worker is the elephant in the room here — we pay 5.8 GB for the privilege
of fast crash recovery. The justification is in PDF §A.2's "why faster
than cold start" callout.

**On 16 GB machines.** Steady-state at 12 GB leaves 4 GB for the OS and
the browser. That's tight. On configurations with less than 16 GB, the
agent could be configured to drop the warm worker and accept slower crash
recovery — but this is an option, not the default.

---

## Why one Worker, not one-per-MFE

The natural intuition is "isolate MFEs from each other by giving each its
own worker." We don't, for two reasons:

1. **Memory.** Each worker is 6 GB. Two MFEs would need 12 GB just for
   workers; four MFEs would need 24 GB. The agent would be unrunnable
   on the assumed hardware.

2. **KV-cache reuse.** A single worker can amortize KV-cache pages across
   concurrent requests with overlapping prompts (common for an MFE with
   a system prompt). Per-MFE workers can't.

Inter-MFE isolation comes from the scheduler's per-MFE caps and from the
fact that the agent never mixes MFE prompts in a single inference call.
That's enough — the threat model is "buggy MFE," not "malicious MFE."
