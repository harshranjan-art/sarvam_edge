# Deep Dive: Hardware Fallback

> Extends PDF §A.3 and §A.4. The two platforms have surprisingly different
> failure shapes; this doc explains why each got a different circuit-breaker
> design.

---

## The two failure shapes

| Aspect | Qualcomm NPU (Windows ARM64) | Apple Neural Engine (macOS) |
|---|---|---|
| Access model | Dedicated to our process while context is open | Shared across all apps on the system |
| Typical failure | `ERROR_DEVICE_REMOVED` from QnnGraph_execute | `kCMErrorUnsupportedOperation` from Core ML |
| Failure persistence | Sticky for the session (driver-level) | Often transient (other app finishes) |
| Recovery action needed | Driver reload (effectively: agent restart) | Just retry later |

These differences drive the design choices:

- **NPU circuit breaker is `session_scoped: true`** — once we see
  `ERROR_DEVICE_REMOVED`, we don't try the NPU again for the rest of the
  session. The 30s timer for HALF-OPEN is mostly there in case the user
  manually reset something.

- **ANE circuit breaker is `session_scoped: false`** — we use a 5-second
  sliding window because ANE contention typically clears as soon as the
  co-tenant app finishes.

---

## NPU: the failure modes Qualcomm doesn't document well

From scanning Qualcomm developer forums and the QNN SDK release notes:

### `ERROR_DEVICE_REMOVED` after sleep/wake

Happens reliably on some Snapdragon X laptops. The Hexagon DSP is part of
the SoC's power-managed domain; after a deep sleep, the QNN runtime can
return success codes on the first call (so the call appears to work) but
the device is actually unresponsive.

**Our defense.** The probe-graph after every OS resume. It's a 60ms cost
on resume, and it catches this case cleanly.

### Memory pressure causing OOM on the NPU

QnnTensor allocations come from a separate pool (not main system RAM).
Under heavy concurrent use, allocations can fail with `QNN_TENSOR_OOM`.

**Our defense.** Pre-allocate the maximum-size tensors at startup, reuse
across requests. KV-cache pages come from a fixed-size ring buffer. No
runtime allocation on the NPU after startup.

### Driver returns success but produces gibberish

Rare; documented above in `05-edge-cases.md` (entry B.1). The probe-graph
verifies output correctness, not just call success.

---

## NPU: probe-graph design

The probe-graph is a deliberately tiny inference job:

- 8-token prefill of a fixed prompt
- Greedy decode
- Output compared bit-exactly against a known-good tensor stored in the
  binary

The known-good tensor is generated at build time by running the same graph
on a reference implementation (CPU). If the NPU output differs even by
one bit, the breaker treats it as a fail.

**Why bit-exact comparison.** The model is quantized to int8; numerical
fuzz isn't expected. A correctly-functioning NPU produces deterministic
output for a deterministic input. Allowing any tolerance opens the door
to "almost-working" drivers that quietly degrade quality.

**Probe cost.** ~60 ms for the 8-token prefill on NPU. We run this once
per HALF-OPEN attempt, not on every real request, so amortized cost is
nil.

---

## ANE: the failure modes Apple doesn't document well

Apple's Core ML documentation is sparse on error semantics. From
experience and from radar/forum reports:

### `kCMErrorUnsupportedOperation` is overloaded

The same error code is returned for:

1. An op the ANE truly can't run (e.g. a custom layer not in the ANE op set)
2. An op the ANE *can* run but the current input shape isn't compiled in
3. ANE is busy and the op is being declined (rather than queued)

Differentiating these matters because (1) means stop trying ANE for this
model; (2) means recompile; (3) means retry later.

**Our heuristic.**

- If we hit this on the first call after Core ML load → probably (1) or (2).
  Try once with a model rebuild; if it fails again, mark the model
  ANE-incompatible.
- If we hit this on a call N>1 after successful calls earlier → probably
  (3). Use 5-second sliding window; if 3 fails in 5s, fall to Metal.

### Thermal throttling on M1/M2 MacBook Air

The Air has no fan; under sustained ANE load it'll throttle aggressively.
This presents as `kCMErrorUnsupportedOperation` *sometimes* and as ~5x
slowdown other times.

**Our defense.** Monitor `[NSProcessInfo thermalState]`. When it goes to
`.serious` or `.critical`, the scheduler refuses to dispatch new requests
to ANE until it returns to `.fair`. In-flight requests continue (no
mid-stream backend swap).

---

## ANE fallback: why Metal before Accelerate

PDF §A.4 lists the order as Metal → Accelerate → Cloud. Why Metal first?

- **Latency.** Metal is roughly 2-3.5x slower than ANE; Accelerate is
  6-10x slower. For a user-visible request, Metal is the right tradeoff.
- **Battery cost.** Counter-intuitively, Metal can be lower-energy than
  Accelerate *per token* on M-series chips. The GPU is more efficient for
  large matrix multiplies than the CPU vector units.
- **Memory headroom.** Metal needs ~1.5 GB of VRAM. If the user has many
  other apps using the GPU (e.g. a 4K video editor), we may fail to
  allocate and have to fall further to Accelerate.

The order can be overridden per-request via `X-Edge-Backend-Preference`
(not currently in the API; flagged for future) for cases where a client
knows it's running on battery and wants to optimize for energy.

---

## Cloud as last resort: the security boundary

Cloud fallback is intentionally a *separate kind* of fallback from CPU.

| Backend | Where data goes | Default policy |
|---|---|---|
| NPU / ANE / Metal / CPU | Never leaves the device | Enabled |
| Cloud | Sent to Sarvam's API endpoint | **Disabled by default** |

The cloud fallback is gated by three checks, all of which must pass:

1. **MDM policy** allows cloud fallback for this tenant.
2. **Request header** doesn't include `X-Data-Residency: on-device`.
3. **No viable local backend** — CPU has been measured to exceed the
   per-request SLO (typically 60s timeout).

If any of these fails, the request errors out with `507
DEVICE_UNAVAILABLE_DEGRADED` rather than silently going to cloud.

This is a *product* decision masquerading as a *technical* design choice.
The whole point of running inference on-device is data not leaving the
device. Auto-falling to cloud would violate that promise even if it
"helped." The opt-in friction is the feature.

---

## Probe-graph correctness checks: a worked example

Concrete example for NPU. The probe input is:

```
prompt: "अब क"           (3 tokens after tokenization)
expected_next_token: "र"  (token id 2451)
expected_logits_hash: "sha256:7a3c..."   // sha-256 of all-token logit vector
```

The hash is generated at build time by running the same model on CPU and
hashing the output logits with 4 decimal places of precision (the int8
quantization should give us at least that much determinism).

A passing probe:

```
1. QnnGraph_execute → success
2. Output tensor shape matches expected
3. argmax matches expected_next_token
4. sha256(round(logits, 4)) matches expected_logits_hash
5. Latency < 100ms (sanity check; 60ms is typical)
```

If 1-4 pass but 5 fails, it's a "yellow" result — driver is working but
slow; we log it but treat the breaker as passed. If any of 1-4 fail, hard
fail.
