/**
 * Estimador de tokens por chamada usando EWMA (exponentially weighted moving
 * average). Aprende com `usage.total_tokens` das respostas de sucesso do
 * provedor e produz uma estimativa que:
 *
 * - Reage rápido a mudanças de padrão (alpha alto)
 * - Resistente a outliers (single-sample spike não domina a média)
 * - Sem armazenar histórico (O(1) memória)
 *
 * @see https://en.wikipedia.org/wiki/Moving_average#Exponential_moving_average
 */
export interface TokenEstimatorOptions {
  /**
   * Fator de suavização da EWMA. 0 < alpha <= 1.
   * - alpha=1: sem smoothing, sempre assume o último sample.
   * - alpha=0.3 (default): reage em ~3-5 samples a uma mudança de padrão.
   */
  readonly alpha?: number;
  /**
   * Estimativa inicial usada antes de qualquer sample real. Default: 1000.
   */
  readonly initialEstimate?: number;
  /** Teto aplicado à estimativa (evita runaway de samples absurdos). */
  readonly maxEstimate?: number;
}

export interface TokenEstimateSnapshot {
  /** Estimativa atual (EWMA). */
  readonly estimate: number;
  /** Número de samples observados. */
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
      throw new Error("alpha deve estar em (0, 1]");
    }
    this.alpha = alpha;
  }

  /** Estimativa atual (heuristic) — sempre positiva e limitada. */
  current(): TokenEstimateSnapshot {
    return { estimate: Math.round(this.estimate), samples: this.samples };
  }

  /** Indica se já observou samples reais (vs. initial). */
  get hasRealData(): boolean {
    return this.samples > 0;
  }

  /**
   * Atualiza a EWMA com um novo sample.
   *
   * `next = alpha * sample + (1 - alpha) * previous`
   *
   * Valida: `sample > 0` (descarta zero/negativo) e clamp ao teto.
   */
  observe(sample: number): void {
    if (!Number.isFinite(sample) || sample <= 0) return;
    const clamped = Math.min(sample, this.maxEstimate);
    if (this.samples === 0) {
      // Primeiro sample real: substitui o initial em vez de suavizar contra
      // ele — evita pessimismo prolongado quando initial é baixo.
      this.estimate = clamped;
    } else {
      this.estimate = this.alpha * clamped + (1 - this.alpha) * this.estimate;
    }
    this.samples += 1;
  }
}
