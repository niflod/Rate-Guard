export interface RateBudget {
  /** Available amount at check time, already discounting what was consumed. */
  readonly remaining: number;
  /** Maximum capacity reached after full regeneration. */
  readonly capacity: number;
}

export interface RateResult {
  /** Time effectively waited (ms). 0 when there was enough immediate budget. */
  readonly waitedMs: number;
  /** Always true in a normal implementation. */
  readonly ok: true;
  /** Tokens consumed. */
  readonly consumed: number;
}

export interface RateLimit {
  acquire(cost: number): Promise<RateResult>;
  available(): RateBudget;
  /**
   * Generic sync hook. Implementations that don't support multi-axis
   * synchronization (e.g. `CompositeRateLimiter` which has separate RPM and
   * TPM) can leave this as a noop; the queue tries the cast to
   * `CompositeRateLimiter` to dispatch specifically.
   *
   * Default: noop on the interface.
   */
  sync?(remaining: number, capacity: number): void;
}

function nowMs(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic (leaky/continuous) bucket that regenerates `capacity` tokens every interval.
 *
 * `intervalMs` is the reference period (e.g. 60_000ms). The bucket regenerates
 * tokens continuously, proportional to elapsed time, smoothing the limit.
 */
abstract class ContinuousBucket implements RateLimit {
  private tokens: number;
  private lastRefill: number;
  protected capacity: number;
  private readonly intervalMs: number;

  constructor(capacity: number, intervalMs: number) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
    if (intervalMs <= 0) throw new Error("intervalMs must be > 0");
    this.capacity = capacity;
    this.intervalMs = intervalMs;
    this.tokens = capacity;
    this.lastRefill = nowMs();
  }

  public abstract get kind(): string;

  available(): RateBudget {
    this.refill();
    return { remaining: this.tokens, capacity: this.capacity };
  }

  async acquire(cost: number): Promise<RateResult> {
    if (cost < 0) throw new Error("cost must be >= 0");
    let waited = 0;

    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return { ok: true, waitedMs: waited, consumed: cost };
      }
      const deficit = cost - this.tokens;
      const refillRatePerMs = this.capacity / this.intervalMs;
      const msToRefill = deficit / refillRatePerMs;
      const roundedMs = Math.ceil(msToRefill) + 1;
      await sleep(roundedMs);
      waited += roundedMs;
    }
  }

  /**
   * Syncs the bucket with the provider's reality. Re-adjusts `capacity`,
   * sets `tokens` to `remaining` (clamped to `[0, capacity]`) and resets the
   * regeneration clock to avoid inflating the balance on the next `refill`.
   *
   * Ignores calls with `capacity <= 0` or `remaining < 0`.
   */
  sync(remaining: number, capacity: number): void {
    if (capacity <= 0) return;
    if (remaining < 0) return;
    this.capacity = capacity;
    this.tokens = Math.min(capacity, Math.max(0, remaining));
    this.lastRefill = nowMs();
  }

  private refill(): void {
    const current = nowMs();
    const elapsed = current - this.lastRefill;
    if (elapsed <= 0) return;
    const refillRatePerMs = this.capacity / this.intervalMs;
    const added = elapsed * refillRatePerMs;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = current;
  }
}

/** Rate limiter for Requests per Minute (RPM). */
export class RequestRateLimiter extends ContinuousBucket {
  constructor(rpm: number) {
    super(rpm, 60_000);
  }
  public get kind(): string {
    return "RPM";
  }
}

/** Rate limiter for Tokens per Minute (TPM). */
export class TokenRateLimiter extends ContinuousBucket {
  constructor(tpm: number) {
    super(tpm, 60_000);
  }
  public get kind(): string {
    return "TPM";
  }
}

/**
 * Composition of the two limiters (RPM and TPM). Sequential acquisition only
 * discounts from the second after the first releases; the wait time is
 * summed.
 */
export class CompositeRateLimiter implements RateLimit {
  private readonly rpm: RequestRateLimiter;
  private readonly tpm: TokenRateLimiter;

  constructor(rpm: number, tpm: number) {
    this.rpm = new RequestRateLimiter(rpm);
    this.tpm = new TokenRateLimiter(tpm);
  }

  get kind(): string {
    return "Composite(RPM,TPM)";
  }

  available(): RateBudget {
    const rpmNow = this.rpm.available();
    const tpmNow = this.tpm.available();
    const ratio = Math.min(
      rpmNow.remaining / rpmNow.capacity,
      tpmNow.remaining / tpmNow.capacity,
    );
    return { remaining: ratio, capacity: 1 };
  }

  async acquire(cost: number): Promise<RateResult> {
    const rRpm = await this.rpm.acquire(1);
    const rTpm = await this.tpm.acquire(cost);
    return {
      ok: true,
      waitedMs: rRpm.waitedMs + rTpm.waitedMs,
      consumed: cost,
    };
  }

  /**
   * Generic sync via `RateLimit.sync` is a noop: `CompositeRateLimiter`
   * has two independent axes (RPM/TPM), so a single `(remaining, capacity)`
   * pair can't be attributed to both. Use the specific `syncRpmTpm`.
   */
  sync(_remaining: number, _capacity: number): void {
    //noop
  }

  /**
   * Dispatches synchronization to the internal buckets. `undefined` params
   * leave the corresponding bucket unchanged (preserves current state).
   */
  syncRpmTpm(
    rpm: { remaining: number; capacity: number } | undefined,
    tpm: { remaining: number; capacity: number } | undefined,
  ): void {
    if (rpm) this.rpm.sync(rpm.remaining, rpm.capacity);
    if (tpm) this.tpm.sync(tpm.remaining, tpm.capacity);
  }
}

/**
 * Applies a safety margin (0 < margin <= 1) over the limits announced by the
 * provider. Operating at 80% of the ceiling (default) accommodates peak
 * windows without rejecting requests — the provider is subject to internal
 * variation.
 *
 * Typical use:
 *   const { rpm, tpm } = withSafetyMargin(500, 90_000, 0.8);
 *   new CompositeRateLimiter(rpm, tpm);
 *
 * Doesn't change `remaining` in the queue: the bucket starts full at the
 * reduced capacity. When the header sync arrives, if the provider announces
 * more capacity, the bucket can expand — sync is the source of truth.
 */
export function withSafetyMargin(
  rpm: number,
  tpm: number,
  margin = 0.8,
): { rpm: number; tpm: number } {
  if (!(margin > 0 && margin <= 1)) {
    throw new Error("margin must be in (0, 1]");
  }
  return {
    rpm: Math.max(1, Math.floor(rpm * margin)),
    tpm: Math.max(1, Math.floor(tpm * margin)),
  };
}
