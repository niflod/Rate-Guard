# Migration Guide

> Languages: [Português](./MIGRATION.md) • [English](./MIGRATION.en.md)

## From BullMQ / Redis Queue

| Concept | BullMQ | rate-guard |
|---|---|---|
| Queue | `Queue` + Redis | `AiRequestQueue` (in-memory) |
| Rate limit | Manual / plugins | `CompositeRateLimiter` + auto |
| Retry | `attempts` + backoff | `RetryExecutor` + backoff + jitter |
| Retry-After | Manual | Automatic (pauses the whole queue) |
| Concurrency | `concurrency` | `concurrency` + `adaptiveConcurrency` (AIMD) |
| Persistence | Yes (Redis) | No (in-memory) |
| Multi-process | Yes | No (single-process) |

### Migration steps

1. Replace `new Queue("name")` with `new AiRequestQueue({ provider, ... })`.
2. Move retry logic from the worker into `opts.backoff` / `RetryExecutor`.
3. Drop Redis from the infra — the queue runs in the same process.
4. If you need persistence, see the roadmap (SQLite WAL planned).

**When NOT to migrate**: if you need persistence across restarts, multi-process, or messages that survive crashes.

---

## From Bottleneck / p-limit

| Feature | Bottleneck / p-limit | rate-guard |
|---|---|---|
| Token bucket (RPM) | Yes (manual) | Yes (auto + sync) |
| Token bucket (TPM) | No | Yes |
| Backoff + jitter | No | Yes |
| Retry-After | No | Yes (pauses queue) |
| Header sync | No | Yes |
| EWMA calibration | No | Yes |
| AIMD | No | Yes |
| Predicted-over-limit | No | Yes |

### Migration steps

1. Replace `limiter.schedule(fn)` with `queue.enqueue(req)`.
2. If you used `minTime`/`maxConcurrent`, map to `rateLimiter` + `concurrency` / `adaptiveConcurrency`.
3. Gain: header sync, EWMA, AIMD, automatic Retry-After.

---

## From a homegrown implementation (TokenBucket + manual retry)

If you already have a token bucket and retry loop:

1. Remove the manual bucket — use `CompositeRateLimiter`.
2. Remove the `while (retry) { try {...} catch {...} sleep(...) }` loop — use `RetryExecutor`.
3. Remove manual `Retry-After` parsing — `DefaultProviderClient` does it.
4. Add `syncFromHeaders` and `TokenEstimator` to gain sync + EWMA.

---

## Post-migration validation checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes (run existing suites + add your own cases).
- [ ] `npm run example` runs without errors.
- [ ] In production, monitor `paused` / `predicted-over-limit` / `concurrency-changed` events.
- [ ] Tune `SAFETY_MARGIN` / `adaptiveConcurrency` / `maxRetries` according to your provider.
