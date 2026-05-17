# Deep Dive: Scheduler

> Extends PDF §B.2. The PDF gives the algorithm; this doc proves it has
> the properties the PDF claims and walks through how the constants were
> chosen.

---

## The five properties the scheduler must have

1. **Capacity bound.** At most 4 requests in flight globally.
2. **Per-MFE bound.** At most 3 requests in flight per MFE.
3. **Priority.** User-priority requests preferred over background.
4. **Fairness across MFEs.** No MFE can dominate the agent.
5. **No starvation.** A request submitted at time T is dispatched by some
   bounded time T + f(load).

WDRR with priority aging gives us all five. Let me show why.

---

## Property 1: capacity bound

Trivially enforced. The scheduler increments `in_flight` on dispatch and
decrements on completion (success, error, or cancellation). `pump()` is
gated on `in_flight < 4`. There is no path that bypasses this check.

The bound is honored even under crash-recovery race conditions: if a
worker crashes mid-dispatch, the slot is freed when `WorkerLost` is
processed, not when the underlying request was cancelled — so we never
"leak" a slot.

---

## Property 2: per-MFE bound

Implemented in `pump()` as a candidate filter: `candidates = [q for q in
queues if mfe_count(q.mfe) < 3]`. If an MFE is at 3 in-flight, its
queues are simply skipped when picking next.

**Edge case.** Two MFEs at 3 in-flight each = 6 slots used, but our cap
is 4. Can this happen?

No. The system-wide cap of 4 is enforced FIRST (capacity bound), then
the per-MFE cap acts as a filter on which queue to pick from. Per-MFE
caps can only restrict, never increase, parallelism.

---

## Property 3: priority

User-priority queues have a base weight of 1.0; background queues have
0.25. In WDRR, queues with higher weights are picked proportionally more
often.

Worked example with two MFEs, each submitting user and background:

```
Queue                    Base weight    Submissions
DocQA/user               1.0            5 requests
DocQA/background         0.25           5 requests
Meeting/user             1.0            5 requests
Meeting/background       0.25           5 requests
                         ────           ──────────
Total                    2.5            20 requests
```

WDRR allocates slot quanta proportionally:

- DocQA/user gets 1.0/2.5 = 40% of dispatches
- DocQA/background gets 0.25/2.5 = 10% of dispatches
- Meeting/user gets 40%
- Meeting/background gets 10%

So under load, user-priority requests get 4x the throughput of
background-priority requests. This is the desired behavior.

---

## Property 4: fairness across MFEs

Same base weights across MFEs (1.0 for all user; 0.25 for all background).
Combined with the per-MFE cap, this means:

- 4 MFEs each submitting user requests get equal share (≈1 slot each on
  average).
- An MFE that has many requests can't accumulate more than 3 in-flight
  while another MFE is waiting.

The interesting case: 1 MFE with 100 requests vs another MFE with 1
request. WDRR's deficit accounting means the second MFE's lone request
is picked on its turn, not starved.

**Subtle point.** WDRR with equal weights degrades to standard round-
robin across non-empty queues. So in the equal-priority case, fairness
is exact: each MFE's queue is serviced in turn.

---

## Property 5: no starvation

This is where aging matters. Without it, a continuous stream of fresh
user requests would starve a single background request indefinitely.

Aging adds 1 to the effective weight every 5 seconds queued. After T
seconds queued, a request's effective weight is:

```
effective_weight = base_weight + floor(T / 5)
```

For a background request (base 0.25):
- T=0:  weight 0.25
- T=5:  weight 1.25  — now ahead of fresh user requests
- T=20: weight 4.25  — ahead of 4 freshly-arrived user requests

Why "5 seconds per +1"? Because:

- A user is likely to abandon a stalled UI after ~10-15 seconds.
- We want background requests to "win" before the user's other requests
  start abandoning, so the system doesn't end up dispatching background
  work to a user who's no longer waiting.
- 5 seconds gives the aging curve roughly 3 ticks of slack before
  starvation becomes user-visible.

This number is tuned, not derived. Different deployments may want
different constants. The PDF flags this as an open question.

---

## Pseudocode walked through

```
on enqueue(request, mfe, priority):
    q = subqueue[(mfe, priority)]
    request.enqueued_at = now()
    q.push(request)
    pump()

on slot_released():
    pump()

pump():
    while in_flight < 4 and any_queue_nonempty():
        for r in all_queue_heads():
            r.effective_weight = base_weight(r) + floor((now - r.enqueued_at) / 5000)
        candidates = [q for q in queues if mfe_count(q.mfe) < 3 and not empty(q)]
        if candidates is empty:
            return
        q = argmax(candidates, key=lambda q: q.deficit_counter)
        r = q.pop()
        q.deficit_counter -= r.cost_estimate
        dispatch(r)
        in_flight += 1
```

**`cost_estimate`** is a simplification. In practice it's max_tokens *
expected_ms_per_token, but we use a fixed value (256 tokens × 20ms = 5120)
for the initial implementation. Replacing this with a learned predictor
is future work.

**`deficit_counter`** starts at the queue's `effective_weight` and
decreases each time the queue is selected. When all candidates have
negative counters, we add `effective_weight` back to each (the "round
boundary"). This is standard WDRR.

---

## Cancellation semantics, formally

The contract is "cancellation is idempotent and O(1) if queued, O(network
roundtrip) if dispatched."

Implementation:

```
on cancel(request):
    if request.state == 'queued':
        request.queue.remove(request)   // O(1) with doubly-linked list
        emit_event('cancelled', by: 'client')
    elif request.state == 'running':
        abort(request.fetch)            // closes TCP; agent observes RST
        // agent will eventually emit InferenceDone with finish_reason=CANCELLED
        // upon which we emit_event('cancelled', by: 'client')
    elif request.state == 'done' or 'error' or 'cancelled':
        // no-op; cancellation is idempotent
```

The interesting case is "request in transition between queued and
running." This can happen if the scheduler has called `pop()` but not yet
`dispatch()`. Resolved by holding the request in a transient
`dispatching` state during the gap — cancel during `dispatching` waits
synchronously until either `dispatch()` returns (transition to running,
then cancel-as-running) or `dispatch()` fails (transition to error).

---

## What WDRR is NOT good at

- **Latency-sensitive single-request workloads.** WDRR is throughput-fair
  but doesn't optimize for any single request's latency. A latency-bound
  scheduler would pick differently. We don't have a latency SLA, so this
  doesn't matter for us.

- **Variable request sizes.** WDRR with constant `cost_estimate` over-
  rewards short requests. If we ever have wildly variable max_tokens,
  the cost estimate should be max_tokens-aware.

- **Predicting completion.** WDRR can't tell you when YOUR request will
  run. The `eta_ms` we emit in `queued` events is a separate calculation
  (sum of expected remaining time of in-flight + estimated time of
  queued-ahead-of-you). It's an estimate, not a promise.
