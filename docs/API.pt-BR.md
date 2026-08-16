# Referência da API

> Languages: [English](./API.md) • [Português](./API.pt-BR.md)

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

Classe principal que orquestra fila, rate limiting, retries, AIMD, sync e estimator.

### Constructor

```typescript
new AiRequestQueue(options: AiRequestQueueOptions)
```

### AiRequestQueueOptions

| Propriedade | Tipo | Obrigatório | Default | Descrição |
|---|---|---|---|---|
| `provider` | `ProviderClient` | ✅ | — | Cliente HTTP que implementa `call()`. |
| `rateLimiter` | `RateLimit` | ❌ | `CompositeRateLimiter(500, 90_000)` com `safetyMargin` | Rate limiter customizado. Se omitido, cria default aplicando `withSafetyMargin`. |
| `concurrency` | `number` | ❌ | `1` | Concorrência inicial do `p-queue`. |
| `adaptiveConcurrency` | `boolean` | ❌ | `false` | Ativa AIMD. |
| `maxConcurrency` | `number` | ❌ | `max(8, concurrency)` | Teto AIMD. |
| `minConcurrency` | `number` | ❌ | `1` | Piso AIMD. |
| `safetyMargin` | `number` | ❌ | `0.8` | Margem no bucket default (0.01–1.0). Ignorado se `rateLimiter` for passado. |
| `backoff` | `BackoffOptions` | ❌ | `{ maxRetries: 8, baseBackoffMs: 1000, maxBackoffMs: 60_000 }` | Configuração do backoff. |
| `delayResolver` | `RetryDelayResolver` | ❌ | `exponentialBackoffWithJitter` | Função de delay customizada. |
| `tokenEstimator` | `TokenEstimatorOptions` | ❌ | `{ alpha: 0.3, initialEstimate: 1000 }` | Configuração do EWMA. |
| `maxAutoPauseMs` | `number` | ❌ | `60_000` | Teto de auto-pausa em `Retry-After`. |
| `onEvent` | `(e: QueueEvent) => void` | ❌ | `() => {}` | Callback de telemetria. |

### Métodos

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

Classifica:
- `429` / `5xx` → `retryable: true`
- `4xx (≠429)` → `retryable: false`
- Erro de rede → `retryable: true`
- Parseia `Retry-After` (segundos ou HTTP-date).

---

## Config

```typescript
loadConfig(): AppConfig
```

Lê todas as variáveis de ambiente definidas em `.env.example`.

---

## Tipos re-exportados

- `ProviderRequest { path, method?, headers?, body?, estimatedTokens? }`
- `ProviderResponse<T> { status, headers, body: T }`
- `RateBudget { remaining, capacity }`
- `RateResult { waitedMs, ok: true, consumed }`