# Architecture

> Languages: [Português](./ARCHITECTURE.md) • [English](./ARCHITECTURE.en.md)

This document explains in depth the decisions behind `rate-guard`.
For the API reference, see [`API.md`](./API.en.md).

## System overview

```
                          ┌──────────────────────────────────────────────────┐
                          │                  AiRequestQueue                 │
                          │                                                  │
user action ──enqueue──➤  │  ┌─────────┐   ┌──────────┐   ┌──────────────┐  │
                          │  │ p-queue  ➤ │ acquire  ➤ │ RetryExecutor │  │
                          │  │         │  │ tokens   │  │   + backoff │  │
                          │  │         │  │ +        │  │   + Retry-  │  │  ──provider.call(POST /chat) ──➤
                          │  │         │  │ syncHea- │  │   After     │  │                                  │
                          │  │         │  │ ders     │  │   + AIMD    │  │  ◀── response 200/429/5xx ◀────  │
                          │  │         │  │ + predi- │  │             │  │                                  │
                          │  │         │  │ ct-over- │  │             │  │                                  │
                          │  │         │  │ limit    │  │             │  │                                  │
                          │  │         │  │ + pause  │  │             │  │                                  │
                          │  └─────────┘   └──────────┘   └──────────────┘  │
                          │                                                  │
                          │  onEvent ─➤ { enqueued, retry, success, paused, │
                          │                resumed, predicted-over-limit,  │
                          │                concurrency-changed, ... }        │
                          └──────────────────────────────────────────────────┘
```

## Internal dependency graph

```
src/index.ts (barrel)
├── src/config/index.ts        (autonomous: reads process.env)
├── src/queue/ai-request-queue.ts
│   ├── p-queue (npm)
│   ├── src/provider/provider-client.ts
│   │   └── src/retry/backoff.ts   (RetryOutcome, retry(), success())
│   ├── src/rate-limiter/token-bucket.ts
│   │   └── (stdlib)
│   ├── src/rate-limiter/token-estimator.ts
│   │   └── (stdlib)
│   └── src/retry/backoff.ts
│       └── (stdlib)
└── (re-exports of the modules above + ProviderClient/Request/Response)
```

Cycle: no circular dependencies. `provider-client` only knows types from
`retry/backoff`; `rate-limiter/*` knows nothing but the stdlib.

## Mechanisms in depth

### #0 Continuous token bucket (RPM + TPM)

`ContinuousBucket` is a "leaky bucket", not a "fixed window". It regenerates
tokens **continuously**, proportional to elapsed time:

```typescript
refillRatePerMs = capacity / intervalMs
added = elapsed * refillRatePerMs
tokens = min(capacity, tokens + added)
```

Benefits:

- Smooths bursts (e.g. allows 60 requests in 1s up front, then regenerates
  1 req/1s if `capacity` is 60/min).
- No `setInterval` — only computes at `acquire`/`available` time.

`CompositeRateLimiter.acquire(cost)` does:

```
rRpm = await rpm.acquire(1)
rTpm = await tpm.acquire(cost)
waitedMs = rRpm.waitedMs + rTpm.waitedMs
```

It acquires RPM first (cheaper), then TPM. If both `waited`, it sums them.

### #1 Header sync at runtime

After a success, headers are parsed and `syncRpmTpm(rpm, tpm)` is called:
```typescript
sync(remaining, capacity) {
  this.capacity = capacity;  // readjusts
  this.tokens = min(capacity, max(0, remaining));
  this.lastRefill = now();    // resets regeneration — don't inflate on next tick
}
```

Why this matters:

- The provider announces what's actually left — we don't have to guess.
- If `capacity` changed (promoted account), the bucket follows the new ceiling.
- Resetting the clock avoids adding regeneration "for time that didn't exist".

### #2 Automatic pause on Retry-After

`autoPauseFor(ms)`:

1. Ignores if `manualPaused` (user asked to pause).
2. `clearTimeout(autoResumeTimer)` for scale (don't accumulate timers).
3. `queue.pause()` — all items (in flight + waiting) stop.
4. `setTimeout(()=>queue.start(), ms)` with `.unref()` (doesn't hold the
   Node process on shutdown).
5. Emits `paused { reason: "auto", untilMs, durationMs }`.

Invariant: `autoPausedUntil !== null` implies there is 1 pending timer.

Why pause the **whole** queue?

- Request X just got 429. Y is in flight? Probably already failing too
  (provider rates per second).
- What's waiting in the queue — if the queue ignored that and fired X'
  immediately, you'd virtually guarantee another 429 — another `Retry-After`
  — and so it cascades.
- Pausing **everything** for the exact time in `Retry-After` is the literal
  interpretation of what the provider asked.

### #3 EWMA calibration (TokenEstimator)

`next = alpha * sample + (1 - alpha) * previous`, with `alpha = 0.3` default.

- First real sample replaces the initial 1000 — no smoothing against a
  synthetic marker.
- Rejects 0/negative/NaN/Infinity (invalid samples).
- Clamps to `maxEstimate = 1_000_000` to avoid runaway.

Why EWMA and not a simple average?

- O(1) memory (no history kept).
- Reacts in 3-5 samples to a pattern change.
- Resistant to outliers (single spike doesn't dominate).

When to emit `predicted-over-limit`: **before** `acquire`. The queue still
tries, but the consumer can alert — useful for SLO/SLA "long-jam prediction".

### #4 Exponential backoff + jitter

`exponentialBackoffWithJitter` (equal jitter — AWS strategy):

```
cap = min(baseBackoffMs * 2^attempt, maxBackoffMs)
delay = cap/2 + random(0, cap/2)
```

- `2^attempt` doubles every retry (1s, 2s, 4s, 8s, 16s, 32s, then capped at 60s).
- `cap/2` as base + `random(0, cap/2)` as jitter disperses retries.
- `Retry-After` from the provider takes precedence when provided.

New defaults: `maxRetries: 8`, `maxBackoffMs: 60_000`.

Maximum total backoff: `1+2+4+8+16+32+60+60 = 183s` ≈ 3 minutes. This covers
prolonged provider-out windows (1-3 min) that the previous defaults (5/30s =
~63s max) didn't cover.

### #5 Safety margin 0.8× (default)

`withSafetyMargin(rpm, tpm, margin)` applies `Math.floor(rpm * margin)` with
clamp `>= 1`.

Why operate at 80% of the ceiling?

- The provider is subject to internal variation (noisy-neighbor spikes,
  competing quotas within the account).
- Keeping a 20% margin absorbs these fluctuations without rejecting your
  requests — at the cost of marginal throughput (~5% in steady state).
- `safetyMargin = 1.0` disables it (operator wants the full limit).

### #6 AIMD (Additive Increase / Multiplicative Decrease)

Classic TCP algorithm. Adapted for request concurrency:

- **Decrease (on 429/5xx)**: `concurrency = max(min, floor(c / 2))`.
  - Halves — recovers quickly from a capacity drop.
  - Several 429s in a row: 8 → 4 → 2 → 1 in 3 failures.
- **Increase (on success)**: `concurrency = min(max, c + 1)`.
  - Adds 1 — ramps up slowly, avoids offending the provider again.
  - In steady state, it takes `max - min` successes to reach the ceiling.
- Limits: `minConcurrency = 1` (default), `maxConcurrency = 8` (default).

Why not just backoff?

- Backoff handles 1 call. AIMD handles the **volume** that's offending the
  provider. They are complementary: AIMD shrinks the window, backoff handles
  the failed call.

Why is AIMD opt-in?

- For many loads, the bucket already solves it — AIMD is overhead.
- For loads where the provider limits by concurrency (not by RPM/TPM), AIMD
  is essential.

## State invariant

The combination of mechanisms offers these properties together:

1. **Doesn't fire-and-then-handle** — pre-acquire bucket at the queue (vs. try and wait for 429).
2. **Aligns with the provider at runtime** — sync + Retry-After + AIMD.
3. **Learns from real usage** — EWMA token calibration.
4. **Escapes unstable situations** — backoff + AIMD + Retry-After pause.
5. **Observable** — 9 event types via `onEvent`.

## Cost/benefit analysis

| Mechanism | CPU overhead | Added latency | Expected 429 reduction |
|---|---|---|---|
| #0 token bucket | trivial (1 mult + 1 min per req) | 0 when there's budget | high |
| #1 header sync | trivial (parse headers) | 0 | medium-high |
| #2 pause | 1 setTimeout + 1 clearTimeout | retryAfterMs (~ms-s) | high |
| #3 EWMA | 1 mult + 1 sum per success | 0 | medium |
| #4 backoff | only on failure | backoff (seconds) | high on failure |
| #5 margin 0.8× | 0 | 0 | medium |
| #6 AIMD | 1 arithmetic per outcome | 0 | high on concurrency |

Total overhead on the success path: < 1ms per req. Benefit: virtual
elimination of avoidable 429s under realistic patterns.
