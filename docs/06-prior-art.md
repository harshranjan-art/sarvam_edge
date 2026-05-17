# Prior Art

> What this design borrows from, in roughly the order the borrowings matter.
> None of these systems solve the exact problem; the value is in knowing what
> they got right and where each one's lessons stop applying.

---

## Chromium — site isolation and the renderer process model

**Borrowed.** The three-process model in §A of the PDF is descended from
Chrome's Browser-Renderer-GPU split. Browser process = our Supervisor (one
per agent, holds state, never renders); Renderer = our Inference Worker (the
"unsafe" process where most code runs, expected to fail); GPU = the
specialized backend process.

**What's the same.**

- A "supervisor" process owns the socket and passes file descriptors to
  child processes that hold connections.
- Child processes that may crash are spawned with restart policy and
  separate-address-space isolation.
- Heartbeat-based liveness detection, with the renderer being expected to
  fault under adversarial input.

**What's different.**

- Chrome's renderers handle untrusted content; our Worker handles trusted
  user prompts. We have a simpler threat model and can use plain protobuf
  IPC instead of Chrome's Mojo.
- Chrome has a renderer-per-tab; we have a singleton inference worker with
  internal concurrency. The reason: model weights are 4 GB and we cannot
  afford multiple copies. Chrome's per-tab model is the *opposite* of ours.
- We have a warm-pool (1+1). Chrome doesn't, because page navigation cost
  is dominated by network and JS, not by process spawn.

**Source.** "Site Isolation: Process Separation for Web Sites within the
Browser" (Reis et al., USENIX Security 2019). Also the Chromium design docs
on Browser/Renderer architecture.

---

## VS Code — the extension host model

**Borrowed.** The shell-owned SDK in §B.1 is structurally identical to
VS Code's extension host pattern. The VS Code main process talks to one
extension host process, which loads many extensions. Extensions never talk
to the system directly; they go through the extension host's API.

**What's the same.**

- Single multiplexed connection between client and "extension host"
  (our agent).
- Multiple consumers (extensions / MFEs) share one connection through a
  central mediator (our shell SDK / VS Code's main process).
- The mediator owns fairness, rate-limiting, and lifecycle.

**What's different.**

- VS Code allows extensions to register their own commands and contribute
  UI; our MFEs only consume inference. The SDK surface is narrower.
- VS Code's extension host is one process; we have one agent process with
  internal worker pool. Different units of isolation.
- VS Code's extension API has hundreds of methods; ours has effectively
  one (`inference.submit`). The complexity is on the agent side, not the
  SDK side.

**Source.** VS Code's documentation on "Extension Host" and the Language
Server Protocol architecture (which is closely related and was a strong
influence on the API contract in §B.1).

---

## Ollama / llama.cpp — local LLM serving

**Borrowed.** The single-binary, single-model, HTTP-on-loopback shape is
straight out of Ollama's playbook. Their `OLLAMA_HOST=127.0.0.1:11434`
default and their decision to expose an HTTP API even for local use
validated our architectural choice.

**What's the same.**

- HTTP on loopback as the API surface.
- One model loaded into one worker process for the duration of the agent's
  lifetime.
- Token streaming over HTTP (Ollama uses NDJSON; we use SSE — see "What's
  different").

**What's different.**

- Ollama has no process isolation; the inference happens in the same process
  as the HTTP server. A crash takes down the whole binary, and they accept
  that. We can't, because our requirement is "the agent stays up across
  worker crashes."
- Ollama uses NDJSON streaming (one JSON object per line). We chose SSE
  because it has typed event names (`event: token` vs `event: degraded`)
  that map cleanly onto our union-type event catalog. NDJSON would force
  us to put a discriminator field inside every JSON object.
- Ollama doesn't have a circuit breaker for hardware fallback — if the
  GPU is unavailable they just use CPU, and they don't try to recover the
  GPU during the session. Our circuit breaker exists because Sarvam's
  per-device SLO depends on actually using the NPU when possible.

**Source.** Ollama's source code (`server/routes.go`), llama.cpp's server
example.

---

## NGINX worker process model

**Borrowed.** The Supervisor pattern of "master process spawns and supervises
workers; workers handle the actual work" is NGINX's master/worker model
applied to our domain.

**What's the same.**

- Master process never serves requests; it spawns and restarts workers.
- Workers are restartable without dropping the listening socket.
- Hot config reload via a `SIGHUP`-style mechanism (in our case, model
  swap is out of scope, but the spawn-and-promote machinery is the same).

**What's different.**

- NGINX has N workers (typically core-count) serving the same listening
  socket via `accept()` contention. We have one active worker and one
  warm; the warm doesn't serve any traffic, it's a hot spare.
- NGINX workers are stateless across requests; ours holds a KV-cache and
  is *very* stateful within a request.

---

## gRPC client-side load balancing

**Borrowed (and rejected).** I considered using a gRPC channel with
client-side load balancing as the in-agent IPC, and the scheduler as a
gRPC interceptor. Rejected because:

- gRPC's HTTP/2 framing adds ~10 KB resident per connection — fine for
  external services, wasteful for two processes on the same machine.
- gRPC's reflection and streaming machinery is overkill for our schema.
- The named-pipe + length-prefixed-protobuf pattern is well-understood
  and used by Mojo (Chromium), iOS's XPC, and Windows COM. Choosing it
  over gRPC is the lower-risk default.

What we kept from gRPC's design: the idea of a single typed IPC schema
(our `ipc.proto`) rather than ad-hoc per-message handling.

---

## SSE vs WebSocket vs gRPC-Web for the client transport

This was the most contested decision in the design. Three options:

| Option | Why considered | Why not chosen |
|---|---|---|
| WebSocket | Bidirectional, low-overhead | We don't need bidirectional; control fits in HTTP headers. Adds connection upgrade complexity for no benefit. |
| gRPC-Web | Strong typing, generated clients | Requires a proxy (Envoy) in the loop because browsers can't speak HTTP/2 over loopback to a process that didn't negotiate ALPN. Possible but architecturally heavy. |
| **SSE** | Built into the browser; unidirectional fits streaming | Limited by the browser's 6-connections-per-origin rule — but we only ever have one connection (shell-owned singleton SDK), so this doesn't bite us. |

**Why SSE wins for THIS design specifically.** Because the shell SDK is the
only client of the agent, we don't have to worry about connection limits,
multiplexing, or proxying. SSE gives us typed event names, native browser
support, and one-line cancellation via `AbortController`. WebSocket would
work but adds protocol-upgrade machinery for zero benefit.

**Source.** "WebSockets vs Server-Sent Events: choosing between them"
(Smashing Magazine, 2021); MDN's documentation on EventSource.

---

## Erlang/OTP — supervision trees

**Borrowed (philosophically).** The "let it crash" mantra and the
supervision-tree pattern are why §A of this design exists at all. The
worker process is allowed to crash, and the Supervisor's job is to make
that boring.

**What's the same.**

- Failure isolation by process boundary, not by language exception.
- A supervisor whose only job is to restart its children.
- "Restart policy" as a first-class concept (we have warm-vs-cold;
  Erlang has one-for-one / one-for-all / rest-for-one).

**What's different.**

- Erlang processes are green threads, cheap to spawn. Our processes are
  OS processes with ~4 GB of resident memory. We cannot spawn-and-forget;
  we must warm-pool.
- Erlang's "let it crash" is enabled by immutable data and message-passing.
  Our worker has mutable state (KV-cache) that's lost on crash. The
  resume-token machinery in §A.2 exists to bridge this gap.

---

## What's genuinely novel here

Nothing, really, and that's the point. Every component of this design
descends from a system someone has shipped at scale. The work was choosing
the right combination of patterns for *this* problem:

- A local-only HTTP service (Ollama)
- With supervised worker processes (NGINX, Erlang)
- And hardware-fallback circuit breakers (Hystrix, sort of)
- Streaming over SSE (modern web standard)
- Coordinated by a shell-owned mediator (VS Code, Language Server Protocol)
- With proto-based IPC (Mojo, gRPC's underlying design)

If something in this design is genuinely novel, it's probably wrong.
