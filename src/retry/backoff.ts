export interface BackoffOptions {
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

export const defaultBackoffOptions: BackoffOptions = {
  maxRetries: 8,
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NonRetryableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export class MaxRetriesExceededError extends Error {
  constructor(message: string, readonly lastStatus?: number) {
    super(message);
    this.name = "MaxRetriesExceededError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function shouldRetry(
  status: number,
  retryableStatuses?: ReadonlySet<number>,
): boolean {
  if (retryableStatuses !== undefined) {
    return retryableStatuses.has(status);
  }
  return isRetryableStatus(status);
}

export interface RetryContext {
  readonly attempt: number;
  readonly status: number;
  readonly error?: Error;
}

export type RetryDelayResolver = (ctx: RetryContext, opts?: BackoffOptions) => number;

/**
 * Calcula o backoff exponencial com "equal jitter":
 *
 *   delay = cap/2 + random(0, cap/2)
 *
 * onde cap = min(baseBackoffMs * 2^attempt, maxBackoffMs).
 *
 * - dobra a base a cada tentativa (1s, 2s, 4s, 8s, 16s...)
 * - jitter evita thundering herd (retentativas sincronizadas)
 * - cap (maxBackoffMs) limita o teto
 *
 * @see https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export function exponentialBackoffWithJitter(
  ctx: RetryContext,
  opts: BackoffOptions = defaultBackoffOptions,
): number {
  const { baseBackoffMs, maxBackoffMs } = opts;
  const exp = Math.pow(2, ctx.attempt);
  const expDelay = Math.min(baseBackoffMs * exp, maxBackoffMs);
  const half = expDelay / 2;
  const jitter = Math.random() * half;
  return Math.min(maxBackoffMs, Math.round(half + jitter));
}

/** Jitter "full" puro — dispersão uniforme entre 0 e o backoff exponencial. */
export function fullJitterBackoff(
  ctx: RetryContext,
  opts: BackoffOptions = defaultBackoffOptions,
): number {
  const { baseBackoffMs, maxBackoffMs } = opts;
  const exp = Math.pow(2, ctx.attempt);
  const expDelay = Math.min(baseBackoffMs * exp, maxBackoffMs);
  return Math.round(Math.random() * expDelay);
}

export interface RetryExecutorResult<T> {
  readonly value: T;
  readonly attempts: number;
}

export type RetryOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | {
      readonly kind: "retry";
      readonly status?: number;
      readonly reason: string;
      /** Opcional: tirado do header Retry-After do provedor. */
      readonly retryAfterMs?: number;
      readonly retryable?: boolean;
    };

export function success<T>(value: T): RetryOutcome<T> {
  return { kind: "success", value };
}

export function retry(
  reason: string,
  opts?: {
    status?: number;
    retryAfterMs?: number;
    retryable?: boolean;
  },
): RetryOutcome<never> {
  return {
    kind: "retry",
    reason,
    status: opts?.status,
    retryAfterMs: opts?.retryAfterMs,
    retryable: opts?.retryable,
  };
}

export class RetryExecutor {
  constructor(
    private readonly opts: BackoffOptions,
    private readonly resolveDelay: RetryDelayResolver = exponentialBackoffWithJitter,
  ) {}

  async run<T>(
    operation: (attempt: number) => Promise<RetryOutcome<T>>,
  ): Promise<RetryExecutorResult<T>> {
    let attempt = 0;
    for (;;) {
      const outcome = await operation(attempt);
      if (outcome.kind === "success") {
        return { value: outcome.value, attempts: attempt + 1 };
      }
      const status = outcome.status;
      const retryableFlag = outcome.retryable;
      const isRetryable =
        retryableFlag === true || (status !== undefined && isRetryableStatus(status));
      if (!isRetryable) {
        throw new NonRetryableError(
          `Erro não recuperável (status=${status ?? "n/a"}): ${outcome.reason}`,
          status,
        );
      }
      if (attempt >= this.opts.maxRetries) {
        throw new MaxRetriesExceededError(
          `Máximo de retentativas (${this.opts.maxRetries}) excedido (status=${status ?? "n/a"}): ${outcome.reason}`,
          status,
        );
      }
      const delay =
        outcome.retryAfterMs ??
        this.resolveDelay({ attempt, status: status ?? 0 }, this.opts);
      await sleep(delay);
      attempt += 1;
    }
  }
}
