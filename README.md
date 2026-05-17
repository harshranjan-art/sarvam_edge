```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                                      ┃
┃   ▮▮▮  SARVAM AI · EDGE RUNTIME TEAM · SYSTEMS DESIGN SUBMISSION      ┃
┃                                                                      ┃
┃   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   ┃
┃                                                                      ┃
┃           EDGE                                                       ┃
┃           AGENT.            ◀── three artifacts.                     ┃
┃           RUNTIME               one submission.                      ┃
┃                                                                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

# Edge Agent · Runtime Architecture

> **Companion repository to the architecture submission PDF.**
> The PDF stands alone; this repo carries the depth a reviewer might want to
> drill into.

| | |
|---|---|
| **📄 Submission** | [`Edge_Runtime_Architecture.pdf`](./Edge_Runtime_Architecture.pdf) — 12 pages, the headline |
| **🧪 Simulator** | [sarvam-edge-demo.vercel.app](https://sarvam-edge-demo.vercel.app) — click "crash the worker" and watch recovery play out |
| **📚 This repo** | Protocol specs, exhaustive edge-case catalog, TypeScript event types, prior-art lineage |

---

## What this repo is for

The architecture PDF answers Sarvam's Edge Runtime design assignment. It is
deliberately compact — every reviewer's first 5 minutes should fit there.

This repo carries the second-order material:

- **Protocol specifications** that the PDF gestures at but doesn't fully define
- **An exhaustive edge-case catalog** — the things the PDF doesn't have room
  for, but that a backend engineer should have already thought about
- **Type-level contracts** (TypeScript) for every event payload
- **Prior-art notes** — the existing systems whose lessons inform this design

Nothing here changes the headline claims in the PDF. If something here
contradicts the PDF, the PDF wins (and please open an issue).

---

## TL;DR (mirrors the PDF)

The Edge Agent runs as **three processes**:

| Process | Role | Failure model |
|---|---|---|
| **Supervisor** | spawns + monitors workers, holds warm pool | crash-free; if it dies, the whole agent dies |
| **API Server** | HTTP+SSE on `127.0.0.1`, auth, routing | crash-free; supervised restart with backoff |
| **Inference Worker** | model + tokenizer + NPU/ANE calls | the only process expected to crash routinely |

The Supervisor keeps **1 active + 1 warm worker** so crash recovery takes
~280 ms instead of the ~2-3 s a cold start would cost.

Hardware fallback is **per-device circuit-broken**:
`Qualcomm NPU → CPU (DirectML/ONNX-RT)` on Windows;
`Apple Neural Engine → Metal → Accelerate → Cloud` on macOS — Cloud only with
explicit admin opt-in.

On the client, a **shell-owned singleton SDK** mediates all MFE traffic. A
**weighted deficit round-robin scheduler with priority aging** enforces the
4-slot global cap and prevents background prefetches from starving user
requests.

---

## How to navigate

### If you have 5 minutes

Read the PDF. This repo is for after.

### If you have 20 minutes

1. PDF cover-to-cover
2. [`docs/05-edge-cases.md`](./docs/05-edge-cases.md) — skim the headings to
   see what scenarios were considered
3. [`spec/openapi.yaml`](./spec/openapi.yaml) — the actual HTTP surface

### If you want to argue with the design

1. [`docs/02-crash-recovery.md`](./docs/02-crash-recovery.md) — the IPC
   handoff is the trickiest part. The case I'd attack is "what if the warm
   worker is mid-load when the active one crashes?"
2. [`docs/04-scheduler.md`](./docs/04-scheduler.md) — fairness vs priority is
   tunable; the chosen ratios are defensible but not unique
3. [`docs/06-prior-art.md`](./docs/06-prior-art.md) — every claim of
   "this is how it should work" rests on what Chrome, VS Code, and llama.cpp
   did first

### If you want to read code

```
spec/
├── openapi.yaml      complete HTTP API + SSE event schemas
├── ipc.proto         Supervisor↔API↔Worker wire protocol
└── events.ts         TypeScript types for every payload in the system
```

The `events.ts` file is the single source of truth for what shape SSE events
and error envelopes take. The PDF, the OpenAPI, and the proto all agree with
it.

---

## Repository layout

```
.
├── README.md                       you are here
├── Edge_Runtime_Architecture.pdf   the submission
│
├── docs/
│   ├── 01-process-model.md         extends PDF §A.1
│   ├── 02-crash-recovery.md        extends PDF §A.2; IPC handoff details
│   ├── 03-hardware-fallback.md     extends PDF §A.3 + §A.4
│   ├── 04-scheduler.md             extends PDF §B.2; WDRR analysis
│   ├── 05-edge-cases.md            exhaustive failure-mode catalog
│   └── 06-prior-art.md             systems whose lessons this builds on
│
├── spec/
│   ├── openapi.yaml                HTTP + SSE contract
│   ├── ipc.proto                   internal IPC wire format
│   └── events.ts                   TypeScript event payload types
│
└── diagrams/
    ├── system-overview.mmd         Mermaid source for PDF Fig 1
    ├── crash-recovery.mmd          Mermaid source for PDF Fig 3
    ├── circuit-breaker.mmd         Mermaid source for PDF Fig 4
    └── scheduler.mmd               Mermaid source for PDF Fig 6
```

---

## A note on what's not here

This is a design submission, not a working implementation. There is no
`src/` directory; building any of this for real would be several
person-months. What's here is what a backend engineer would write
*before* opening their editor:

- The contracts the team will hold each other to
- The edge cases that need handling before they bite production
- The lineage of decisions, so a future engineer can change one without
  silently breaking another

If you'd like to talk through any of it, my contact details are on the cover
page of the PDF.

---

*Last updated: May 2025. Submitted as part of the Sarvam AI Edge Runtime
backend intern application.*
