# API Reference

> Languages: [Português](./API.md) • [English](./API.en.md)

## Exports

```typescript
import {
  // Queue
  AiRequestQueue,
  AiRequestQueueOptions,
  EnqueueOptions,
  QueueEvent,
  // Rate limiting
  CompositeRateLimiter,
  RequestRateLimiter,
  TokenRateLimiter,
  withSafetyMargin,
  RateBudget,
  RateResult,
  RateLimit,
  // Estimator
  TokenEstimator,
  TokenEstimatorOptions,
  TokenEstimateSnapshot,
  // Retry
  RetryExecutor,
  RetryOutcome,
  BackoffOptions,
  exponentialBackoffWithJitter,
  fullJitterBackoff,
  NonRetryableError,
  MaxRetriesExceededError,
  retry,
  success,
  // Provider
  DefaultProviderClient,
  DefaultProviderClientOptions,
  ProviderClient,
  ProviderRequest,
  ProviderResponse,
  // Config
  AppConfig,
  loadConfig,
} from "rate-guard";
```

---

## AiRequestQueue

Main class orchestrating queue, rate limiting, retries, AIMD, sync and estimator.

### Constructor

```typescript
new AiRequestQueue(options: AiRequestQueueOptions)
```

### AiRequestQueueOptions

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | `ProviderClient` | yes | — | HTTP client implementing `call()`. |
| `rateLimiter` | `RateLimit` | no | `CompositeRateLimiter(500, 90_000)` with `safetyMargin` | Custom rate limiter. If omitted, a default is built applying `withSafetyMargin`. |
| `concurrency` | `number` | no | `1` | Initial `p-queue` concurrency. |
| `adaptiveConcurrency` | `boolean` | no | `false` | Enables AIMD. |
| `maxConcurrency` | `number` | no | `max(8, concurrency)` | AIMD ceiling. |
| `minConcurrency` | `number` | no | `1` | AIMD floor. |
| `safetyMargin` | `number` | no | `0.8` | Margin applied to the default bucket (0.01-1.0). Ignored if `rateLimiter` is supplied. |
| `backoff` | `BackoffOptions` | no | `{ maxRetries: 8, baseBackoffMs: 1000, maxBackoffMs: 60_000 }` | Backoff configuration. |
| `delayResolver` | `RetryDelayResolver` | no | `exponentialBackoffWithJitter` | Custom delay function. |
| `tokenEstimator` | `TokenEstimatorOptions` | no | `{ alpha: 0.3, initialEstimate: 1000 }` | EWMA configuration. |
| `maxAutoPauseMs` | `number` | no | `60_000` | Ceiling for auto-pause on `Retry-After`. |
| `onEvent` | `(e: QueueEvent) => void` | no | `() => {}` | Telemetry callback. |

### Methods

```typescript
enqueue<T>(req: ProviderRequest, opts?: EnqueueOptions): Promise<RetryExecutorResult<ProviderResponse<T>>>
pause(): void
resume(): void
onIdle(): Promise<void>
get pending(): number
get size(): number
get paused(): boolean
get concurrency(): number
```

### QueueEvent

```typescript
type QueueEvent =
  | { type: "enqueued"; id: string; path: string }
  | { type: "rate-acquired"; id: string; waitedMs: number }
  | { type: "retry"; id: string; attempt: number; status?: number; waitMs?: number; reason: string }
  | { type: "success"; id: string; attempts: number; totalMs: number }
  | { type: "failed"; id: string; reason: string; status?: number }
  | { type: "idle" }
  | { type: "paused"; reason: "auto" | "manual"; untilMs?: number; durationMs?: number }
  | { type: "resumed"; reason: "auto" | "manual" }
  | { type: "predicted-over-limit"; id: string; estimatedTokens: number; tpmRemaining: number; tpmCapacity: number }
  | { type: "concurrency-changed"; reason: "increase" | "decrease"; from: number; to: number };
```

---

## Rate Limiters

### CompositeRateLimiter

```typescript
new CompositeRateLimiter(rpm: number, tpm: number)
acquire(cost: number): Promise<RateResult>
available(): RateBudget
sync(rpm?: { remaining: number; capacity: number }, tpm?: { remaining: number; capacity: number }): void
```

### withSafetyMargin

```typescript
withSafetyMargin(rpm: number, tpm: number, margin = 0.8): { rpm: number; tpm: number }
```

### TokenEstimator

```typescript
new TokenEstimator(opts?: TokenEstimatorOptions)
observe(sample: number): void
current(): TokenEstimateSnapshot
get hasRealData(): boolean
```

---

## Retry

### RetryExecutor

```typescript
new RetryExecutor(opts: BackoffOptions, resolveDelay?: RetryDelayResolver)
run<T>(operation: (attempt: number) => Promise<RetryOutcome<T>>): Promise<RetryExecutorResult<T>>
```

### RetryOutcome

```typescript
type RetryOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "retry"; status?: number; reason: string; retryAfterMs?: number; retryable?: boolean };
```

### Helpers

```typescript
exponentialBackoffWithJitter(ctx, opts): number  // equal jitter
fullJitterBackoff(ctx, opts): number             // full jitter
retry(reason, { status, retryAfterMs, retryable }): RetryOutcome<never>
success<T>(value: T): RetryOutcome<T>
```

---

## Provider

### DefaultProviderClient

```typescript
new DefaultProviderClient({ baseUrl: string; apiKey: string; fetchFn?: typeof fetch })
call<T>(req: ProviderRequest): Promise<RetryOutcome<ProviderResponse<T>>>
```

Classifies:
- `429` / `5xx` -> `retryable: true`
- `4xx (other than 429)` -> `retryable: false`
- Network error -> `retryable: true`
- Parses `Retry-After` (seconds or HTTP-date).

---

## Config

```typescript
loadConfig(): AppConfig
```

Reads every environment variable defined in `.env.example`.

---

## Re-exported types

- `ProviderRequest { path, method?, headers?, body?, estimatedTokens? }`
- `ProviderResponse<T> { status, headers, body: T }`
- `RateBudget { remaining, capacity }`
- `RateResult { waitedMs, ok: true, consumed }`
