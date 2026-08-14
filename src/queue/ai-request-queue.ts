import PQueue from "p-queue";
import type { ProviderClient, ProviderRequest, ProviderResponse } from "../provider/provider-client.js";
import type { RateLimit } from "../rate-limiter/token-bucket.js";
import { CompositeRateLimiter, withSafetyMargin } from "../rate-limiter/token-bucket.js";
import { TokenEstimator, type TokenEstimatorOptions } from "../rate-limiter/token-estimator.js";
import {
  type BackoffOptions,
  type RetryDelayResolver,
  type RetryExecutorResult,
  type RetryOutcome,
  exponentialBackoffWithJitter,
  RetryExecutor,
} from "../retry/backoff.js";

export interface AiRequestQueueOptions {
  readonly provider: ProviderClient;
  readonly rateLimiter?: RateLimit;
  readonly concurrency?: number;
  readonly backoff?: BackoffOptions;
  readonly delayResolver?: RetryDelayResolver;
  /**
   * Maximum time (ms) the queue can be auto-paused by a provider
   * `Retry-After`. Prevents a malformed header (e.g. "3600") from freezing
   * the queue for too long. Default: 60_000.
   */
  readonly maxAutoPauseMs?: number;
  /**
   * Safety factor applied **only** to the default rateLimiter built
   * internally (when `rateLimiter` is not provided). Default: `0.8`
   * (= 80% of the announced RPM/TPM). Ignored if `rateLimiter` is provided.
   *
   * Operating below the ceiling absorbs provider peak windows and reduces
   * 429s without sacrificing much throughput. Use `1.0` to disable.
   */
  readonly safetyMargin?: number;
  /**
   * `TokenEstimator` (EWMA) configuration. When absent, uses defaults
   * (alpha=0.3, initialEstimate=1000).
   */
  readonly tokenEstimator?: TokenEstimatorOptions;
  /**
   * Enables adaptive concurrency (AIMD — Additive Increase / Multiplicative
   * Decrease). On 429/5xx, halves down (Math.floor(c/2)); on success, grows
   * by +1 up to the ceiling. Default: `false` (fixed concurrency).
   */
  readonly adaptiveConcurrency?: boolean;
  /**
   * Concurrency ceiling when adaptive is on. Default: the `concurrency`
   * itself (or 8 if `concurrency` is 1).
   */
  readonly maxConcurrency?: number;
  readonly minConcurrency?: number;
  /** Function called on every event (telemetry, logs). */
  readonly onEvent?: (event: QueueEvent) => void;
}

export type QueueEvent =
  | { readonly type: "enqueued"; readonly id: string; readonly path: string }
  | { readonly type: "rate-acquired"; readonly id: string; readonly waitedMs: number }
  | { readonly type: "retry"; readonly id: string; readonly attempt: number; readonly status?: number; readonly waitMs?: number; readonly reason: string }
  | { readonly type: "success"; readonly id: string; readonly attempts: number; readonly totalMs: number }
  | { readonly type: "failed"; readonly id: string; readonly reason: string; readonly status?: number }
  | { readonly type: "idle" }
  | { readonly type: "paused"; readonly reason: "auto" | "manual"; readonly untilMs?: number; readonly durationMs?: number }
  | { readonly type: "resumed"; readonly reason: "auto" | "manual" }
  /**
   * Emitted BEFORE acquire when the calibrated token estimate for this call
   * exceeds the rateLimiter's estimated remaining TPM. The queue still
   * tries (acquire will sleep), but the application can use the signal to
   * log/alert or even cancel.
   */
  | {
      readonly type: "predicted-over-limit";
      readonly id: string;
      readonly estimatedTokens: number;
      readonly tpmRemaining: number;
      readonly tpmCapacity: number;
    }
  /**
   * Emitted when adaptive concurrency changes the `p-queue` limit.
   * Includes the reason (`decrease` on 429/5xx failure, `increase` on
   * success), the previous and new values.
   */
  | {
      readonly type: "concurrency-changed";
      readonly reason: "increase" | "decrease";
      readonly from: number;
      readonly to: number;
    };

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `req-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export interface EnqueueOptions {
  /** Token-estimate override for this request. */
  readonly estimatedTokens?: number;
  /** Priority (higher = faster). p-queue supports standard priority. */
  readonly priority?: number;
}

export class AiRequestQueue {
  private readonly provider: ProviderClient;
  private readonly rateLimiter: RateLimit;
  private readonly queue: PQueue;
  private readonly executor: RetryExecutor;
  private readonly onEvent: (event: QueueEvent) => void;
  private readonly maxAutoPauseMs: number;
  private readonly estimator: TokenEstimator;

  /**
   * Adaptive concurrency (AIMD). Only active if `adaptiveConcurrency` was
   * requested — otherwise `current` follows `opts.concurrency` fixed.
   */
  private readonly adaptive: boolean;
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private currentConcurrency: number;

  /**
   * Controls auto-pauses triggered by `Retry-After`.
   *
   * Invariant: `autoPausedUntil === null` => no pending timer.
   * When non-null, there's a `setTimeout` scheduled to resume the queue in
   * `autoPausedUntil - Date.now()` ms; its id is in `autoResumeTimer`.
   */
  private autoPausedUntil: number | null = null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * True when the pause was requested manually via `pause()`.
   * In that case, auto-resume MUST NOT reactivate the queue — only a manual
   * `resume()` cancels it.
   */
  private manualPaused = false;

  constructor(opts: AiRequestQueueOptions) {
    this.provider = opts.provider;
    if (opts.rateLimiter) {
      this.rateLimiter = opts.rateLimiter;
    } else {
      const margin = opts.safetyMargin ?? 0.8;
      const { rpm, tpm } = withSafetyMargin(500, 90_000, margin);
      this.rateLimiter = new CompositeRateLimiter(rpm, tpm);
    }
    this.queue = new PQueue({ concurrency: opts.concurrency ?? 1 });
    const backoff = opts.backoff;
    this.executor = new RetryExecutor(
      backoff ?? { maxRetries: 8, baseBackoffMs: 1000, maxBackoffMs: 60_000 },
      opts.delayResolver ?? exponentialBackoffWithJitter,
    );
    this.onEvent = opts.onEvent ?? (() => {});
    this.maxAutoPauseMs = opts.maxAutoPauseMs ?? 60_000;
    this.estimator = new TokenEstimator(opts.tokenEstimator ?? {});

    this.adaptive = opts.adaptiveConcurrency === true;
    this.minConcurrency = Math.max(1, opts.minConcurrency ?? 1);
    const startingConcurrency = opts.concurrency ?? 1;
    this.maxConcurrency = Math.max(
      this.minConcurrency,
      opts.maxConcurrency ?? Math.max(8, startingConcurrency),
    );
    this.currentConcurrency = Math.min(
      Math.max(this.minConcurrency, startingConcurrency),
      this.maxConcurrency,
    );
  }

  get pending(): number {
    return this.queue.pending;
  }

  get size(): number {
    return this.queue.size;
  }

  /** Current concurrency applied to the `p-queue`. */
  get concurrency(): number {
    return this.currentConcurrency;
  }

  /** True when the queue is paused (manual or automatic). */
  get paused(): boolean {
    return this.queue.isPaused;
  }

  async enqueue<T>(
    req: ProviderRequest,
    opts?: EnqueueOptions,
  ): Promise<RetryExecutorResult<ProviderResponse<T>>> {
    const id = nextId();
    this.onEvent({ type: "enqueued", id, path: req.path });
    return this.queue.add(
      async () => this.processRequest<T>(id, req, opts?.estimatedTokens),
      opts?.priority !== undefined ? { priority: opts.priority } : undefined,
    ) as Promise<RetryExecutorResult<ProviderResponse<T>>>;
  }

  /** Serialized version (JSON-safe) for simple callbacks. */
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  /** Manual pause of the queue. Cannot be cancelled by an auto-retry. */
  pause(): void {
    this.manualPaused = true;
    this.queue.pause();
    this.onEvent({ type: "paused", reason: "manual" });
  }

  /** Resumes the queue (cancels manual pause and any pending auto-pause). */
  resume(): void {
    this.clearAutoResume();
    this.autoPausedUntil = null;
    this.manualPaused = false;
    this.queue.start();
    this.onEvent({ type: "resumed", reason: "manual" });
  }

  /**
   * Pauses the queue for `ms` milliseconds in response to a `Retry-After`.
   *
   * - Ignores if a manual pause is active (the user told it to stay stopped).
   * - If an auto-pause is already in effect and the new deadline is later,
   *   extends it; if earlier, keeps the current deadline (avoids oscillation).
   * - The time is clamped by `maxAutoPauseMs` for protection against a
   *   malformed header.
   */
  private autoPauseFor(ms: number): void {
    if (this.manualPaused) return;
    if (!Number.isFinite(ms) || ms <= 0) return;
    const duration = Math.min(ms, this.maxAutoPauseMs);
    const until = Date.now() + duration;
    if (this.autoPausedUntil !== null && until <= this.autoPausedUntil) return;

    this.clearAutoResume();
    this.autoPausedUntil = until;
    this.queue.pause();
    this.onEvent({ type: "paused", reason: "auto", untilMs: until, durationMs: duration });

    this.autoResumeTimer = setTimeout(() => {
      this.autoResumeTimer = null;
      this.autoPausedUntil = null;
      if (this.manualPaused) return;
      this.queue.start();
      this.onEvent({ type: "resumed", reason: "auto" });
    }, duration);
    if (this.autoResumeTimer && typeof this.autoResumeTimer === "object" && "unref" in this.autoResumeTimer) {
      (this.autoResumeTimer as { unref(): void }).unref();
    }
  }

  private clearAutoResume(): void {
    if (this.autoResumeTimer !== null) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
  }

  private async processRequest<T>(
    id: string,
    req: ProviderRequest,
    estimatedTokens?: number,
  ): Promise<RetryExecutorResult<ProviderResponse<T>>> {
    const started = Date.now();

    // 1a. Token estimate: prioritize caller > req > estimator (EWMA).
    //     If none informed, uses the calibrated average — reflects real pattern.
    const explicitTokens = estimatedTokens ?? req.estimatedTokens;
    const tokens =
      explicitTokens !== undefined ? explicitTokens : this.estimator.current().estimate;

    // 1b. Predict over-limit BEFORE attempting acquire: alerts the
    //     application this call will likely wait (rate limiter will sleep
    //     until regeneration). Non-blocking — only observes.
    this.maybeEmitPredictedOverLimit(id, tokens);

    // 1c. Respects the rate limiter BEFORE calling the provider.
    const result = await this.rateLimiter.acquire(tokens);
    this.onEvent({ type: "rate-acquired", id, waitedMs: result.waitedMs });

    // 2. Retry loop managed by RetryExecutor.
    //    Wraps the operation to observe each outcome: if a `retry` comes
    //    with `retryAfterMs`, pauses the whole queue for that period before
    //    trying again (aligning with the provider's Retry-After).
    const wrapped = async (attemptNumber: number): Promise<RetryOutcome<ProviderResponse<T>>> => {
      if (attemptNumber === 0) {
        this.onEvent({ type: "enqueued", id, path: req.path });
      } else {
        this.onEvent({ type: "retry", id, attempt: attemptNumber, reason: "previous failed" });
      }
      const outcome = await this.provider.call<T>(req);
      if (outcome.kind === "retry") {
        if (typeof outcome.retryAfterMs === "number" && outcome.retryAfterMs > 0) {
          this.autoPauseFor(outcome.retryAfterMs);
        }
        // AIMD: a 429/5xx failure triggers a multiplicative decrease.
        if (outcome.status === 429 || (typeof outcome.status === "number" && outcome.status >= 500)) {
          this.decreaseConcurrency();
        }
      }
      return outcome;
    };

    const composed = this.executor.run<ProviderResponse<T>>(wrapped);

    try {
      const r = await composed;
      this.syncFromHeaders(r.value.headers);
      // Feeds the estimator with the real usage reported by the provider.
      const observed = this.extractUsageTokens(r.value.body);
      if (observed !== undefined) this.estimator.observe(observed);
      // AIMD: success -> additive increase.
      this.increaseConcurrency();
      this.onEvent({
        type: "success",
        id,
        attempts: r.attempts,
        totalMs: Date.now() - started,
      });
      return r;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number } | undefined)?.status ?? 0;
      this.onEvent({ type: "failed", id, reason, status });
      throw err;
    }
  }

  /**
   * AIMD Additive Increase. On every success, we grow by +1 up to the
   * ceiling. noop if `adaptive` is off.
   */
  private increaseConcurrency(): void {
    if (!this.adaptive) return;
    if (this.currentConcurrency >= this.maxConcurrency) return;
    const from = this.currentConcurrency;
    this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 1);
    this.queue.concurrency = this.currentConcurrency;
    this.onEvent({ type: "concurrency-changed", reason: "increase", from, to: this.currentConcurrency });
  }

  /**
   * AIMD Multiplicative Decrease. On every 429/5xx, halves (floor).
   * Never goes below `minConcurrency`. noop if `adaptive` is off.
   */
  private decreaseConcurrency(): void {
    if (!this.adaptive) return;
    if (this.currentConcurrency <= this.minConcurrency) return;
    const from = this.currentConcurrency;
    this.currentConcurrency = Math.max(this.minConcurrency, Math.floor(this.currentConcurrency / 2));
    if (this.currentConcurrency === from) return;
    this.queue.concurrency = this.currentConcurrency;
    this.onEvent({ type: "concurrency-changed", reason: "decrease", from, to: this.currentConcurrency });
  }

  /**
   * Emits `predicted-over-limit` if the token estimate exceeds the
   * remaining TPM reported by the rateLimiter. Only works when the limiter
   * is a `CompositeRateLimiter` (which has separated TPM); otherwise noop.
   */
  private maybeEmitPredictedOverLimit(id: string, estimatedTokens: number): void {
    if (!(this.rateLimiter instanceof CompositeRateLimiter)) return;
    if (estimatedTokens <= 0) return;
    const tpm = (this.rateLimiter as unknown as {
      tpm: { available(): { remaining: number; capacity: number } };
    }).tpm.available();
    if (estimatedTokens > tpm.remaining) {
      this.onEvent({
        type: "predicted-over-limit",
        id,
        estimatedTokens,
        tpmRemaining: tpm.remaining,
        tpmCapacity: tpm.capacity,
      });
    }
  }

  /**
   * Extracts `usage.total_tokens` (or `prompt_tokens + completion_tokens`)
   * from the response body. Supports OpenAI/Anthropic and analogous
   * structures. Returns `undefined` if the body has no usage.
   */
  private extractUsageTokens(body: unknown): number | undefined {
    if (body === null || typeof body !== "object") return undefined;
    const usage = (body as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (usage === undefined) return undefined;
    if (typeof usage.total_tokens === "number" && usage.total_tokens > 0) {
      return usage.total_tokens;
    }
    const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
    const sum = prompt + completion;
    return sum > 0 ? sum : undefined;
  }

  /**
   * Syncs the `rateLimiter` with headers the provider sends on success
   * responses. Supports the two common conventions:
   *
   * - OpenAI: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`,
   *   `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`.
   * - Anthropic: `anthropic-ratelimit-requests-limit`,
   *   `anthropic-ratelimit-requests-remaining`,
   *   `anthropic-ratelimit-tokens-limit`,
   *   `anthropic-ratelimit-tokens-remaining`.
   *
   * If a bucket has no corresponding header, it's left unchanged. If the
   * `rateLimiter` is not a `CompositeRateLimiter`, tries the generic `sync`
   * with the sum of the two limits (a reasonable but imprecise fallback).
   */
  private syncFromHeaders(headers: Headers): void {
    const rpm = this.readRpmBudget(headers);
    const tpm = this.readTpmBudget(headers);
    if (rpm === undefined && tpm === undefined) return;

    if (this.rateLimiter instanceof CompositeRateLimiter) {
      this.rateLimiter.syncRpmTpm(rpm, tpm);
      return;
    }
    if (rpm) {
      this.rateLimiter.sync?.(rpm.remaining, rpm.capacity);
    } else if (tpm) {
      this.rateLimiter.sync?.(tpm.remaining, tpm.capacity);
    }
  }

  private readRpmBudget(headers: Headers): { remaining: number; capacity: number } | undefined {
    const remaining =
      this.firstFinitePositive(headers, ["x-ratelimit-remaining-requests", "anthropic-ratelimit-requests-remaining"]);
    const capacity =
      this.firstFinitePositive(headers, ["x-ratelimit-limit-requests", "anthropic-ratelimit-requests-limit"]);
    if (remaining === undefined || capacity === undefined) return undefined;
    return { remaining, capacity };
  }

  private readTpmBudget(headers: Headers): { remaining: number; capacity: number } | undefined {
    const remaining =
      this.firstFinitePositive(headers, ["x-ratelimit-remaining-tokens", "anthropic-ratelimit-tokens-remaining"]);
    const capacity =
      this.firstFinitePositive(headers, ["x-ratelimit-limit-tokens", "anthropic-ratelimit-tokens-limit"]);
    if (remaining === undefined || capacity === undefined) return undefined;
    return { remaining, capacity };
  }

  private firstFinitePositive(headers: Headers, names: readonly string[]): number | undefined {
    for (const name of names) {
      const raw = headers.get(name);
      if (raw === null) continue;
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return undefined;
  }
}
