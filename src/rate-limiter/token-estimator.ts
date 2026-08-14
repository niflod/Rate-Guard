/**
 * Per-call token estimator using EWMA (exponentially weighted moving
 * average). Learns from `usage.total_tokens` on provider success responses
 * and produces an estimate that:
 *
 * - Reacts quickly to pattern changes (high alpha)
 * - Resistant to outliers (single-sample spike doesn't dominate the mean)
 * - Stores no history (O(1) memory)
 *
 * @see https://en.wikipedia.org/wiki/Moving_average#Exponential_moving_average
 */
export interface TokenEstimatorOptions {
  /**
   * EWMA smoothing factor. 0 < alpha <= 1.
   * - alpha=1: no smoothing, always assumes the last sample.
   * - alpha=0.3 (default): reacts in ~3-5 samples to a pattern change.
   */
  readonly alpha?: number;
  /**
   * Initial estimate used before any real sample. Default: 1000.
   */
  readonly initialEstimate?: number;
  /** Ceiling applied to the estimate (avoids runaway from absurd samples). */
  readonly maxEstimate?: number;
}

export interface TokenEstimateSnapshot {
  /** Current estimate (EWMA). */
  readonly estimate: number;
  /** Number of samples observed. */
  readonly samples: number;
}

export class TokenEstimator {
  private estimate: number;
  private samples = 0;
  private readonly alpha: number;
  private readonly maxEstimate: number;

  constructor(opts: TokenEstimatorOptions = {}) {
    this.estimate = opts.initialEstimate ?? 1000;
    this.maxEstimate = opts.maxEstimate ?? 1_000_000;
    const alpha = opts.alpha ?? 0.3;
    if (!(alpha > 0 && alpha <= 1)) {
      throw new Error("alpha must be in (0, 1]");
    }
    this.alpha = alpha;
  }

  /** Current estimate (heuristic) — always positive and bounded. */
  current(): TokenEstimateSnapshot {
    return { estimate: Math.round(this.estimate), samples: this.samples };
  }

  /** Whether it has observed real samples (vs. initial). */
  get hasRealData(): boolean {
    return this.samples > 0;
  }

  /**
   * Updates the EWMA with a new sample.
   *
   * `next = alpha * sample + (1 - alpha) * previous`
   *
   * Validates: `sample > 0` (discards zero/negative) and clamps to the ceiling.
   */
  observe(sample: number): void {
    if (!Number.isFinite(sample) || sample <= 0) return;
    const clamped = Math.min(sample, this.maxEstimate);
    if (this.samples === 0) {
      // First real sample replaces the initial instead of smoothing against
      // it — avoids prolonged pessimism when initial is low.
      this.estimate = clamped;
    } else {
      this.estimate = this.alpha * clamped + (1 - this.alpha) * this.estimate;
    }
    this.samples += 1;
  }
}
