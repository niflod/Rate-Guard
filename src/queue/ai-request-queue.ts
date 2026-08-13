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
   * Tempo máximo (ms) que a fila pode ficar pausada automaticamente por um
   * `Retry-After` do provedor. Evita que um header mal-formado (ex.: "3600")
   * trave a fila por tempo excessivo. Default: 60_000.
   */
  readonly maxAutoPauseMs?: number;
  /**
   * Fator de segurança aplicado **apenas** ao rateLimiter default construído
   * internamente (quando `rateLimiter` não é fornecido). Default: `0.8`
   * (= 80% do RPM/TPM anunciado). Ignorado se `rateLimiter` for fornecido.
   *
   * Operar abaixo do teto absorve janelas de pico do provedor e reduz
   * 429s sem sacrificar muito throughput. Use `1.0` para desativar.
   */
  readonly safetyMargin?: number;
  /**
   * Configuração do `TokenEstimator` (EWMA). Quando ausente, usa defaults
   * (alpha=0.3, initialEstimate=1000).
   */
  readonly tokenEstimator?: TokenEstimatorOptions;
  /**
   * Ativa concorrência adaptativa (AIMD — Additive Increase / Multiplicative
   * Decrease). Em 429/5xx, dobra baixo (Math.floor(c/2)); em sucesso,
   * cresce em +1 até o teto. Default: `false` (concorrência fixa).
   */
  readonly adaptiveConcurrency?: boolean;
  /**
   * Teto de concorrência quando adaptativo está ativo. Default: o próprio
   * `concurrency` (ou 8 se `concurrency` for 1).
   */
  readonly maxConcurrency?: number;
  readonly minConcurrency?: number;
  /** Função chamada a cada evento (telemetria, logs). */
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
   * Emitido ANTES de acquire quando a estimativa calibrada de tokens para
   * esta chamada excede o TPM restante estimado do rateLimiter. A fila
   * ainda tentará (acquire vai esperar a regeneração), mas a aplicação
   * pode usar o sinal para logar/alertar ou até cancelar.
   */
  | {
      readonly type: "predicted-over-limit";
      readonly id: string;
      readonly estimatedTokens: number;
      readonly tpmRemaining: number;
      readonly tpmCapacity: number;
    }
  /**
   * Emitido quando a concorrência adaptativa muda o limite do `p-queue`.
   * Inclui motivo (`decrease` em falha 429/5xx, `increase` em sucesso),
   * valor anterior e novo.
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
  /** Override da estimativa de tokens para esta requisição. */
  readonly estimatedTokens?: number;
  /** Prioridade (maior = mais rápida). p-queue suporta priority padrão. */
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
   * Concorrência adaptativa (AIMD). Ativa só se `adaptiveConcurrency` foi
   * pedido — altrimenti `current` segue `opts.concurrency` fixo.
   */
  private readonly adaptive: boolean;
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private currentConcurrency: number;

  /**
   * Controla pausas automáticas disparadas por `Retry-After`.
   *
   * Invariante: `autoPausedUntil === null` ⇒ não há timeout pendente.
   * Quando não-null, há um `setTimeout` agendado para retomar a fila em
   * `autoPausedUntil - Date.now()` ms; esse id está em `autoResumeTimer`.
   */
  private autoPausedUntil: number | null = null;
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Verdadeiro quando a pausa foi pedida manualmente via `pause()`.
   * Nesse caso, a auto-retomada NÃO deve reativar a fila — só `resume()`
   * manual anula.
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

  /** Concorrência atual aplicada ao `p-queue`. */
  get concurrency(): number {
    return this.currentConcurrency;
  }

  /** Verdadeiro quando a fila está pausada (manual ou automaticamente). */
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

  /** Version serializada (JSON-safe) para callbacks simples. */
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  /** Pausa manual da fila. Não pode ser anulada por retentativa auto. */
  pause(): void {
    this.manualPaused = true;
    this.queue.pause();
    this.onEvent({ type: "paused", reason: "manual" });
  }

  /** Retoma a fila (anula pausa manual e eventual auto-pausa pendente). */
  resume(): void {
    this.clearAutoResume();
    this.autoPausedUntil = null;
    this.manualPaused = false;
    this.queue.start();
    this.onEvent({ type: "resumed", reason: "manual" });
  }

  /**
   * Pausa a fila por `ms` milissegundos em resposta a um `Retry-After`.
   *
   * - Ignora se houver pausa manual ativa (o usuário mandou ficar parado).
   * - Se já houver auto-pausa em vigor e o novo prazo for maior, estende;
   *   se for menor, mantém o prazo atual (evita oscilações).
   * - O tempo é clamped por `maxAutoPauseMs` para proteção contra header
   *   mal-formado.
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

    // 1a. Estimativa de tokens: prioriza caller > req > estimator (EWMA).
    //     Se nenhum informou, usa a média calibrada — reflete padrão real.
    const explicitTokens = estimatedTokens ?? req.estimatedTokens;
    const tokens =
      explicitTokens !== undefined ? explicitTokens : this.estimator.current().estimate;

    // 1b. Previsão de over-limit ANTES de tentar acquire: alerta a aplicação
    //     que esta chamada provavelmente espera (rate limiter vai dormir
    //     até regenerar). Não bloqueia — só observa.
    this.maybeEmitPredictedOverLimit(id, tokens);

    // 1c. Respeita o rate limiter ANTES de chamar o provedor.
    const result = await this.rateLimiter.acquire(tokens);
    this.onEvent({ type: "rate-acquired", id, waitedMs: result.waitedMs });

    // 2. Loop de retentativas gerenciado pelo RetryExecutor.
    //    Envolve a operação para observar cada outcome: se vier `retry` com
    //    `retryAfterMs`, pausa a fila inteira por esse período antes de
    //    tentar novamente (alinhamento com Retry-After do provedor).
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
        // AIMD: falha 429/5xx desencadeia multiplicative decrease.
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
      // Alimenta o estimator com o uso real reportado pelo provedor.
      const observed = this.extractUsageTokens(r.value.body);
      if (observed !== undefined) this.estimator.observe(observed);
      // AIMD: sucesso → additive increase.
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
   * AIMD Additive Increase.Em cada sucesso, crescemos +1 até o teto.
   * noop se `adaptive` está desligado.
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
   * AIMD Multiplicative Decrease. Em cada 429/5xx, divide por 2 (floor).
   * Não desce abaixo de `minConcurrency`. noop se `adaptive` desligado.
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
   * Emite `predicted-over-limit` se a estimativa de tokens exceder o TPM
   * restante reportado pelo rateLimiter. Só funciona quando o limiter é um
   * `CompositeRateLimiter` (que tem TPM separado); altrimenti é noop.
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
   * Extrai `usage.total_tokens` (ou `prompt_tokens + completion_tokens`) do
   * corpo da resposta. Suporta OpenAI/Anthropic e estruturas análogas.
   * Retorna `undefined` se o corpo não tiver usage.
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
   * Sincroniza o `rateLimiter` com headers que o provedor envia em respostas
   * de sucesso. Suporta as duas convenções comuns:
   *
   * - OpenAI: `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`,
   *   `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`.
   * - Anthropic: `anthropic-ratelimit-requests-limit`,
   *   `anthropic-ratelimit-requests-remaining`,
   *   `anthropic-ratelimit-tokens-limit`,
   *   `anthropic-ratelimit-tokens-remaining`.
   *
   * Se um bucket não tiver header correspondente, é deixado inalterado. Se o
   * `rateLimiter` não for `CompositeRateLimiter`, tenta `sync` genérico com
   * a soma dos dois limites (fallback razoável mas impreciso).
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
