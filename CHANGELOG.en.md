# Changelog

> Languages: [Português](./CHANGELOG.md) • [English](./CHANGELOG.en.md)

All notable changes to the `rate-guard` project will be documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-13

Initial release. In-memory queue engine combining 5 mechanisms to eliminate
`429 Too Many Requests` errors from AI providers — without Redis, without
BullMQ, without a mandatory build step (consumer runs via `tsx` or compiles).

### Added

- **Continuous Token Bucket (RPM + TPM, together)** — `ContinuousBucket` in
  the `rate-limiter/token-bucket.ts` module. Regenerates tokens
  proportionally to elapsed time, smoothing the limit. `CompositeRateLimiter`
  acquires RPM = 1 and TPM = `cost` in sequence, respecting the most
  restrictive axis.

- **#1 — Bucket synchronization via provider headers on success** — the
  queue reads `x-ratelimit-*` headers (OpenAI convention) and
  `anthropic-ratelimit-*` headers (Anthropic convention) on every success
  response and realigns the `CompositeRateLimiter` via
  `syncRpmTpm(rpm, tpm)`. Eliminates accumulated drift between our estimate
  and the provider's real limit at runtime (quota upgrade, peak window,
  etc.).

- **#2 — Whole-queue automatic pause on `Retry-After`** — when a 429 arrives
  with `Retry-After: <seconds>`, every queued item waits (not just the one
  that failed), because firing the next request immediately would result in
  another 429. Implemented with `queue.pause()` + `setTimeout` (`unref`'d).
  Manual pause via `pause()` blocks the auto-resume. The `maxAutoPauseMs`
  ceiling (default 60s) protects against malformed headers.

- **#3 — Token-estimate calibration via EWMA** — `TokenEstimator`
  (`rate-limiter/token-estimator.ts` module) learns from
  `usage.total_tokens` / `prompt_tokens + completion_tokens` on success
  responses. The default estimate becomes the calibrated moving average,
  not a fixed number. The `predicted-over-limit` event is emitted before
  `acquire` when the estimate exceeds the remaining TPM — useful for
  SLO/SLA monitoring.

- **#4 — More aggressive backoff** — defaults: `maxRetries: 8`,
  `maxBackoffMs: 60_000` (was 5/30s). Maximum recovery window ~5min
  against prolonged provider outages. Overridable via `opts.backoff` or
  env vars `MAX_RETRIES` / `MAX_BACKOFF_MS`.

- **#5 — Safety margin 0.8× on the default bucket** — when the queue builds
  the default `CompositeRateLimiter`, it applies
  `withSafetyMargin(500, 90_000, 0.8)` → 400 RPM / 72 k TPM. Operating at
  80% of the ceiling absorbs provider peak windows without rejecting your
  requests. Configurable via `opts.safetyMargin` or the `SAFETY_MARGIN` env
  var (0.01–1.0).

- **#6 — Adaptive concurrency (AIMD)** — `opts.adaptiveConcurrency: true`
  (default false) activates Additive Increase / Multiplicative Decrease. On
  429/5xx: `concurrency = max(min, floor(c / 2))`; on success:
  `concurrency = min(max, c + 1)`. Limits via `maxConcurrency` /
  `minConcurrency`. A `concurrency-changed` event with `{ reason, from, to }`
  is emitted on every change.

- **`DefaultProviderClient`** — `fetch` wrapper that classifies 429/5xx as
  retryable, 4xx (other than 429) as non-retryable, and parses the
  `Retry-After` header (in seconds or HTTP-date). Network/DNS error =
  retryable.

- **`RetryExecutor`** — generic executor with exponential backoff + jitter
  ("equal jitter" as default, "full jitter" available). Respects
  `Retry-After` when provided. Typed errors:
  `NonRetryableError`, `MaxRetriesExceededError`.

- **`loadConfig()`** — loads all parameters via `process.env` with sensible
  defaults (see `.env.example`).

- **26 tests** covering every module in isolation and in integration (49
  tests in total considering variations; run under Node 20+ with
  `node --test` + `tsx`). All passing on local CI.

- **6 telemetry events** emitted via `onEvent`: `enqueued`,
  `rate-acquired`, `retry`, `success`, `failed`, `idle`, `paused`,
  `resumed`, `predicted-over-limit`, `concurrency-changed`.

- **2 examples**: `examples/basic-usage.ts` (mock fetch, no cost) and
  `examples/openai-integration.ts` (real, costs credits).

- **Professional documentation**: README, `docs/ARCHITECTURE.md`,
  `docs/API.md`, `docs/RECIPES.md`, `docs/MIGRATION.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.

- **CI** via GitHub Actions (Node 20/22 matrix: typecheck + lint + test).

### Fixes (incidental, made while extracting the module)

- ESLint flat config (ESLint 9) — migrated from CommonJS to ESM flat config;
  `@eslint/js` is now explicitly declared in `devDependencies`.
- `provider-client.ts` — removed dead `text` variables in the 429 and 5xx
  branches (they were reading the body without using it).
- `token-bucket.test.ts` — flake fix: the assert
  `(remaining <= 59.0001)` was fragile because the bucket regenerates
  continuously; now uses a 58-60 margin reflecting the async regeneration
  reality.

### Notes

- No hard-coded absolute paths. No coupling to the consumer's architecture.
  No Redis/BullMQ dependency.
- Only external runtime dependency: `p-queue@^8`.
- Compiles with TypeScript 5.7 strict, `noImplicitAny`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- Project state: 0 known regressions. 49/49 tests on local CI.
