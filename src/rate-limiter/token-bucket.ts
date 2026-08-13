export interface RateBudget {
  /** Quantidade disponível no momento da checagem, já descontando o que foi consumido. */
  readonly remaining: number;
  /** Capacidade máxima atingida após regeneração completa. */
  readonly capacity: number;
}

export interface RateResult {
  /** Tempo efetivamente esperado (ms). 0 quando havia saldo suficiente imediato. */
  readonly waitedMs: number;
  /** Sempre true em implementação normal. */
  readonly ok: true;
  /** Tokens consumidos. */
  readonly consumed: number;
}

export interface RateLimit {
  acquire(cost: number): Promise<RateResult>;
  available(): RateBudget;
  /**
   * Hook de sincronização genérica. Implementações que não suportam
   * sincronização multi-eixo (ex.: `CompositeRateLimiter` que tem RPM e
   * TPM separados) podem deixar este método como noop; a fila tenta o
   * cast para `CompositeRateLimiter` para despachar de forma específica.
   *
   * Default: noop na interface.
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
 * Bucket genérico (leaky/continuo) que regenera `capacity` tokens a cada intervalo.
 *
 * `intervalMs` é o período de referência (ex.: 60_000ms). O bucket regenera tokens
 * de forma contínua, proporcional ao tempo decorrido, suavizando o limite.
 */
abstract class ContinuousBucket implements RateLimit {
  private tokens: number;
  private lastRefill: number;
  protected capacity: number;
  private readonly intervalMs: number;

  constructor(capacity: number, intervalMs: number) {
    if (capacity <= 0) throw new Error("capacity deve ser > 0");
    if (intervalMs <= 0) throw new Error("intervalMs deve ser > 0");
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
    if (cost < 0) throw new Error("cost deve ser >= 0");
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
   * Sincroniza o bucket com a realidade do provedor. Reajusta `capacity`,
   * fixa `tokens` em `remaining` (clamped a `[0, capacity]`) e zera o relógio
   * de regeneração para evitar inflar o saldo no próximo `refill`.
   *
   * Ignora chamadas com `capacity <= 0` ou `remaining < 0`.
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

/** Rate limiter de Requisições por Minuto (RPM). */
export class RequestRateLimiter extends ContinuousBucket {
  constructor(rpm: number) {
    super(rpm, 60_000);
  }
  public get kind(): string {
    return "RPM";
  }
}

/** Rate limiter de Tokens por Minuto (TPM). */
export class TokenRateLimiter extends ContinuousBucket {
  constructor(tpm: number) {
    super(tpm, 60_000);
  }
  public get kind(): string {
    return "TPM";
  }
}

/**
 * Composição dos dois limitadores (RPM e TPM). A aquisição sequencial só desconta
 * do segundo após o primeiro liberar; o tempo de espera é somado.
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
   * Sincronização genérica via `RateLimit.sync` é noop: o `CompositeRateLimiter`
   * tem dois eixos independentes (RPM/TPM), então não há como atribuir um
   * único par `(remaining, capacity)` a ambos. Use `syncRpmTpm` que é
   * específico.
   */
  sync(_remaining: number, _capacity: number): void {
    //noop
  }

  /**
   * Despacha sincronização para os buckets internos. Parâmetros `undefined`
   * deixam o bucket correspondente inalterado (preserva estado atual).
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
 * Aplica margem de segurança (0 < margin <= 1) sobre os limites anunciados
 * pelo provedor. Operar em 80% do teto (default) acomoda janelas de pico
 * sem rejeitar requests — o provedor está sujeito a variações internas.
 *
 * Uso típico:
 *   const { rpm, tpm } = withSafetyMargin(500, 90_000, 0.8);
 *   new CompositeRateLimiter(rpm, tpm);
 *
 * Não altera `remaining` na fila: o bucket começa cheio na capacity reduzida.
 * Quando o sync de headers chegar, se o provedor anunciar mais capacidade, o
 * bucket pode expandir — o sync é a fonte da verdade.
 */
export function withSafetyMargin(
  rpm: number,
  tpm: number,
  margin = 0.8,
): { rpm: number; tpm: number } {
  if (!(margin > 0 && margin <= 1)) {
    throw new Error("margin deve estar em (0, 1]");
  }
  return {
    rpm: Math.max(1, Math.floor(rpm * margin)),
    tpm: Math.max(1, Math.floor(tpm * margin)),
  };
}
