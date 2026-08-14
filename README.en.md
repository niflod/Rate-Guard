# rate-guard

> Languages: [Português](./README.md) • [English](./README.en.md)

> 🛡️ **rate-guard** — your bodyguard against 429. A smart queue that learns
> the provider's pace, pauses when it asks, and never leaves you hanging.
> Zero Redis, zero drama, just code that works.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)
![Tests](https://img.shields.io/badge/tests-49%20passing-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-1%20runtime%20(p--queue)-orange.svg)
![Redis](https://img.shields.io/badge/Redis-NOT%20required-success.svg)

---

## Table of contents

- [Why use it?](#why-use-it)
- [Quickstart](#quickstart)
- [Architecture](#architecture)
- [Anti-429 mechanisms](#anti-429-mechanisms)
- [Public API](#public-api)
- [Configuration via `.env`](#configuration-via-env)
- [Examples](#examples)
- [Comparison with alternatives](#comparison-with-alternatives)
- [Migration](#migration)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why use it?

AI providers (OpenAI, Anthropic, Gemini) impose rate limits — expressed in
`RPM` (requests/minute) and `TPM` (tokens/minute). Hitting the ceiling
means receiving `429 Too Many Requests`, which:

- Delays the user's response.
- Breaks production pipelines.
- Persists to "close the window" — without treatment, it tends to worsen.

`rate-guard` is a **combination of 5 mechanisms that work together** to
avoid 429 and recover when it happens:

1. **Pre-acquire token bucket** — waits before calling the provider.
2. **Automatic pause on `Retry-After`** — the whole queue respects the
   provider's reset.
3. **Header sync** — bucket realigned with limits announced at runtime.
4. **EWMA calibration** — learns real token cost via `usage.total_tokens`.
5. **AIMD** — adaptive concurrency (drops on failures, rises on success).

No Redis, no BullMQ, no mandatory build step. Only runtime dependency:
[`p-queue@^8`](https://github.com/sindresorhus/p-queue).

## Quickstart

```bash
# 1. Install deps (only `p-queue` as a runtime dependency):
npm install p-queue

# 2. Copy the `src/` folder of this repo into your project.

# 3. Use:
```

```ts
import { AiRequestQueue } from "./src/index.js";
import { DefaultProviderClient, CompositeRateLimiter } from "./src/index.js";

const queue = new AiRequestQueue({
  provider: new DefaultProviderClient({
    baseUrl: process.env.PROVIDER_BASE_URL!,
    apiKey: process.env.PROVIDER_API_KEY!,
  }),
  rateLimiter: new CompositeRateLimiter(500, 90_000), // RPM, TPM
  concurrency: 1,
  onEvent: (e) => console.log(e.type),
});

const result = await queue.enqueue({
  path: "/chat/completions",
  body: JSON.stringify({ model: "gpt-4o-mini", messages: [...] }),
  estimatedTokens: 500,
});
```

## Architecture

```
user action → enqueue → [p-queue (concurrency)] → RateLimiter (RPM + TPM) → ProviderClient → fetch
        │                                              │                          ↓
        │                                              ↑   syncFromHeaders on 200  │
        │                                              │   └── x-ratelimit-* headers
        │                                              │                          ↓
        │                                              ↑   ┌───────── retry loop ───┐
        │                                              │   │ backoff + jitter      │
        │                                              │   │ + Retry-After (provider)
        │                                              │   │   ↓                    │
        │                                              │   │ if retryAfterMs > 0:  │
        │                                              │   │   queue.pause(ms)    │
        │                                              │   │   setTimeout(...) resume
        │                                              │   │ if status=429/5xx:    │
        │                                              │   │   decreaseConcurrency│
        │                                              │   │ else on success:     │
        │                                              │   │   increaseConcurrency│
        │                                              └── stimulus → ─────────┘
        │
        └── on every success:
            • syncFromHeaders(headers) → CompositeRateLimiter.syncRpmTpm(...)
            • extractUsageTokens(body) → TokenEstimator.observe(...)
            • increaseConcurrency (if AIMD is on)
```

## Anti-429 mechanisms

### #0 Pre-acquire token bucket (RPM + TPM)

`ContinuousBucket` regenerates `capacity` tokens every `intervalMs` (60s)
**continuously**, proportional to elapsed time. `CompositeRateLimiter`
acquires 1 RPM unit + `cost` TPM units in sequence, respecting the most
restrictive axis. Expected behavior: the queue **waits** before calling
the provider, instead of firing and dealing with 429 afterwards.

### #1 Bucket sync via provider headers

Supported headers (read on **success** responses):

| Provider  | Headers |
|-----------|---------|
| OpenAI    | `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` |
| Anthropic | `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-tokens-limit`, `anthropic-ratelimit-tokens-remaining` |

`syncRpmTpm(rpm, tpm)` realigns `capacity` and `tokens` of the internal
buckets, resetting the regeneration clock. Eliminates accumulated drift
after long usage.

### #2 Automatic pause on `Retry-After`

When a 429 arrives with `Retry-After: <seconds>`, **all queue items wait** —
not just the one that failed — because firing the next request immediately
would result in another 429. Implemented with `queue.pause()` +
`setTimeout` (`unref`'d). A manual pause via `pause()` **blocks** the
auto-resume. The `maxAutoPauseMs` ceiling (default 60s) protects against
malformed headers.

`paused`/`resumed` events go to `onEvent` with `reason: "auto"|"manual"`.

### #3 Token-estimate calibration (EWMA)

`TokenEstimator` learns from `usage.total_tokens` (or `prompt_tokens +
completion_tokens`) on success responses, using EWMA
(`alpha=0.3` default — reacts in 3-5 samples). The default estimate
becomes the calibrated moving average, not a fixed 1000 number.

The `predicted-over-limit` event is emitted **before** `acquire` when the
estimate exceeds the remaining TPM — the queue still tries (acquire
sleeps), but the application can log/alert.

### #4 Exponential backoff + jitter (more aggressive)

Defaults:

- `maxRetries: 8` (was 5).
- `maxBackoffMs: 60_000` (was 30s).

Maximum recovery window: ~5min against prolonged provider outages.
Overridable via `opts.backoff` or env vars.

Equal jitter: `delay = cap/2 + random(0, cap/2)` — disperses retries and
avoids the thundering herd. The provider's `Retry-After` takes precedence.

### #5 Safety margin 0.8× (default)

When the queue builds the default `CompositeRateLimiter` (without an
explicit `opts.rateLimiter`), it applies
`withSafetyMargin(500, 90_000, 0.8)` → 400 RPM / 72 k TPM. Operating at
80% of the ceiling absorbs provider peak windows without rejecting your
requests.

Configurable via `opts.safetyMargin` or the `SAFETY_MARGIN` env var
(0.01–1.0). Use `1.0` to disable.

### #6 Adaptive concurrency (AIMD)

`opts.adaptiveConcurrency: true` (default false) activates Additive Increase
/ Multiplicative Decrease:

- On 429/5xx: `concurrency = max(min, floor(c / 2))`.
- On success: `concurrency = min(max, c + 1)`.

Trajectory after a 429 burst: 8 → 4 → 2 → 1; then gradually rises up to the
ceiling with consecutive successes. Limits via `maxConcurrency` /
`minConcurrency`. A `concurrency-changed` event with `{ reason, from, to }`
is emitted on every change.

## Public API

See [`docs/API.en.md`](./docs/API.en.md) for the full reference. Summary:

| Export | Function |
|---|---|
| `AiRequestQueue` | Main class: queue + rate limiting + retry + AIMD + sync + estimator |
| `CompositeRateLimiter` | Dual bucket (RPM + TPM) with `acquire`, `syncRpmTpm` |
| `RequestRateLimiter`, `TokenRateLimiter` | Individual buckets |
| `withSafetyMargin(rpm, tpm, margin)` | Applies a factor |
| `TokenEstimator` | EWMA with `observe`/`current` |
| `DefaultProviderClient` | `fetch` wrapper that classifies 429/5xx/4xx |
| `RetryExecutor`, `exponentialBackoffWithJitter`, `fullJitterBackoff` | Retry |
| `NonRetryableError`, `MaxRetriesExceededError` | Typed errors |
| `loadConfig` | Loads params via `process.env` |
| `AiRequestQueueOptions`, `QueueEvent`, `ProviderRequest`, `ProviderResponse` | Types |

## Configuration via `.env`

See `.env.example`. Supported variables:

| Variable | Default | Description |
|---|---|---|
| `PROVIDER_BASE_URL` | `https://api.openai.com/v1` | Base URL |
| `PROVIDER_API_KEY` | empty | Provider API key |
| `RPM_LIMIT` | 500 | Requests/minute |
| `TPM_LIMIT` | 90000 | Tokens/minute |
| `QUEUE_CONCURRENCY` | 1 | Initial concurrency |
| `ADAPTIVE_CONCURRENCY` | false | Enables AIMD (via env — string "true") |
| `MAX_CONCURRENCY` | 8 | AIMD ceiling |
| `MIN_CONCURRENCY` | 1 | AIMD floor |
| `SAFETY_MARGIN` | 0.8 | Margin applied to the default bucket (`0 < margin <= 1`) |
| `MAX_RETRIES` | 8 | Maximum retries |
| `BASE_BACKOFF_MS` | 1000 | Base backoff |
| `MAX_BACKOFF_MS` | 60000 | Backoff ceiling |
| `MAX_AUTO_PAUSE_MS` | 60000 | Auto-pause ceiling on `Retry-After` |

## Examples

- [`examples/basic-usage.ts`](./examples/basic-usage.ts) — mock fetch that
  simulates 429 + 200. Isolated, no cost. Demonstrates pause, sync, EWMA, AIMD.
- [`examples/openai-integration.ts`](./examples/openai-integration.ts) —
  real integration with OpenAI. **Costs credits**.

## Comparison with alternatives

| Criterion | rate-guard | BullMQ | Bottleneck | p-limit |
|---|---|---|---|---|
| Redis | no | **yes** | no | no |
| Token bucket | yes (RPM + TPM) | no | yes | no |
| Backoff + Retry-After | yes | yes | no | no |
| Runtime header sync | yes | no | no | no |
| EWMA calibration | yes | no | no | no |
| AIMD concurrency | yes | manual | no | no |
| Predicted-over-limit event | yes | no | no | no |
| Runtime dependencies | 1 (p-queue) | Redis + ioredis | 0 | 0 |
| Multi-process | no (in-memory) | yes | no | no |
| Bundle size | ~20KB | ~200KB | ~10KB | ~5KB |

Use `rate-guard` when you need smart self-regulation in a single process.
Use BullMQ when you need persistence/multi-process.

## Migration

See [`docs/MIGRATION.en.md`](./docs/MIGRATION.en.md) for migrating from
BullMQ, Bottleneck, p-limit, or a homegrown implementation.

## Roadmap

- [ ] Idempotent response cache (body hash) — structural volume reduction.
- [ ] In-flight call deduplication.
- [ ] Multi-process via shared state (without Redis, via SQLite WAL).
- [ ] Adapter for Anthropic SDK Python-style (prompt cache).
- [ ] Prometheus metrics ready.

## Contributing

See [`CONTRIBUTING.en.md`](./CONTRIBUTING.en.md) and our
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). In short: open an issue before
large PRs, write tests, keep everything green.

## License

[MIT](./LICENSE) — © 2026 rate-guard contributors.
