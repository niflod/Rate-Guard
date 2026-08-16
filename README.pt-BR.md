# rate-guard

> Languages: [English](./README.md) • [Português](./README.pt-BR.md)

> 🛡️ **rate-guard** — seu guarda-costas contra 429. Fila inteligente que aprende o ritmo do provedor, pausa quando ele pede, e nunca te deixa na mão. Zero Redis, zero drama, só código que funciona.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)
![Tests](https://img.shields.io/badge/tests-49%20passing-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-1%20runtime%20(p--queue)-orange.svg)
![Redis](https://img.shields.io/badge/Redis-NOT%20required-success.svg)

---

## Sumário

- [Por que usar?](#por-que-usar)
- [Quickstart](#quickstart)
- [Arquitetura](#arquitetura)
- [Mecanismos anti-429](#mecanismos-anti-429)
- [API pública](#api-pública)
- [Configuração via `.env`](#configuração-via-env)
- [Exemplos](#exemplos)
- [Comparação com alternativas](#comparação-com-alternativas)
- [Migração](#migração)
- [Roadmap](#roadmap)
- [Contribuindo](#contribuindo)
- [Licença](#licença)

---

## Por que usar?

Provedores de IA (OpenAI, Anthropic, Gemini) impõem limites de taxa —
expressos em `RPM` (requests/minuto) e `TPM` (tokens/minuto). Estourar
significa receber `429 Too Many Requests`, que:

- Atrasa a resposta do usuário.
- Quebra pipelines em produção.
- Persiste para "fechar a janela" — sem tratamento, tende a piorar.

`rate-guard`é uma **combinação de 5 mecanismos que trabalham juntos** para
evitar 429 e se recuperar quando ele ocorre:

1. **Token bucket pré-acquire** — espera antes de chamar o provedor.
2. **Pausa automática em `Retry-After`** — fila inteira respeita o reset do provedor.
3. **Sync de headers** — bucket realinhado com os limites anunciados em runtime.
4. **EWMA calibration** — aprende custo real de tokens via `usage.total_tokens`.
5. **AIMD** — concorrência adaptativa (cai em falhas, sobe em sucesso).

Sem Redis, sem BullMQ, sem build step obrigatório. Única dependência:
[`p-queue@^8`](https://github.com/sindresorhus/p-queue).

## Quickstart

```bash
# 1. Instale deps (apenas `p-queue` como dependência runtime):
npm install p-queue

# 2. Copie a pasta `src/` deste repo para seu projeto.

# 3. Use:
```

```ts
import { AiRequestQueue } from "./src/index.js";
import { DefaultProviderClient, CompositeRateLimiter } from "./src/index.js";

const queue = new AiRequestQueue({
  provider: new DefaultProviderClient({
    baseUrl: process.env.PROVIDER_BASE_URL!,
    apiKey: process.env.PROVIDER_API_KEY!,
  }),
  rateLimiter: new CompositeRateLimiter(500, 90_000), // RPM, TPM
  concurrency: 1,
  onEvent: (e) => console.log(e.type),
});

const result = await queue.enqueue({
  path: "/chat/completions",
  body: JSON.stringify({ model: "gpt-4o-mini", messages: [...] }),
  estimatedTokens: 500,
});
```

## Arquitetura

```
user action → enqueue → [p-queue (concurrencia)] → RateLimiter (RPM + TPM) → ProviderClient → fetch
        │                                              │                          ↓
        │                                              ↑   syncFromHeaders em 200  │
        │                                              │   └── headers x-ratelimit-*
        │                                              │                          ↓
        │                                              ↑   ┌───────── retry loop ───┐
        │                                              │   │ backoff + jitter      │
        │                                              │   │ + Retry-After (provedor)
        │                                              │   │   ↓                    │
        │                                              │   │ if retryAfterMs > 0:  │
        │                                              │   │   queue.pause(ms)    │
        │                                              │   │   setTimeout(...) resume
        │                                              │   │ if status=429/5xx:    │
        │                                              │   │   decreaseConcurrency│
        │                                              │   │ else on success:     │
        │                                              │   │   increaseConcurrency│
        │                                              └── estímulo → ─────────┘
        │
        └── em cada sucesso:
            • syncFromHeaders(headers) → CompositeRateLimiter.syncRpmTpm(...)
            • extractUsageTokens(body) → TokenEstimator.observe(...)
            • increaseConcurrency (se AIMD ativo)
```

## Mecanismos anti-429

### #0 Token bucket pré-acquire (RPM + TPM)

`ContinuousBucket` regenera `capacity` tokens a cada `intervalMs` (60s) de
forma **contínua** proporcional ao tempo decorrido. `CompositeRateLimiter`
adquire 1 unidade de RPM + `cost` unidades de TPM em sequência, respeitando o
eixo mais restritivo. Resposta esperada: a fila **espera** antes de chamar o
provedor, em vez de disparar para tratar 429 depois.

### #1 Sync de bucket via headers do provedor

Headers suportados (lidos em respostas de **sucesso**):

| Provedor  | Headers |
|-----------|---------|
| OpenAI    | `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` |
| Anthropic | `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-tokens-limit`, `anthropic-ratelimit-tokens-remaining` |

`syncRpmTpm(rpm, tpm)` realinha `capacity` e `tokens` dos buckets internos,
zerando o relógio de regeneração. Elimina drift acumulado após longo uso.

### #2 Pausa automática em `Retry-After`

Quando um 429 chega com `Retry-After: <segundos>`, **todos os itens da fila
esperam** — não apenas o que falhou — porque disparar a próxima request
imediatamente resultaria em outro 429. Implementado com `queue.pause()` +
`setTimeout` (`unref`'d). Pausa manual via `pause()` **bloqueia** a
auto-retomada. Teto `maxAutoPauseMs` (default 60s) protege contra header
mal-formado.

Eventos `paused`/`resumed` vão para `onEvent` com `reason: "auto"|"manual"`.

### #3 Calibração da estimativa de tokens (EWMA)

`TokenEstimator` aprende com `usage.total_tokens` (ou `prompt_tokens +
completion_tokens`) das respostas de sucesso usando EWMA
(`alpha=0.3` default — reage em 3-5 samples). Estimativa default passa a
ser a média calibrada, não um número fixo 1000.

Evento `predicted-over-limit` é emitido **antes** de `acquire` quando a
estimativa excede o TPM remanescente — a fila ainda tenta (acquire dorme),
mas a aplicação pode logar/alertar.

### #4 Backoff exponencial + jitter (mais agressivo)

Defaults:

- `maxRetries: 8` (era 5).
- `maxBackoffMs: 60_000` (era 30s).

Janela de recuperação máxima: ~5min contra quedas prolongadas do provedor.
Overridável via `opts.backoff` ou env vars.

Equal jitter: `delay = cap/2 + random(0, cap/2)` — dispersa retentativas e
evita thundering herd. `Retry-After` do provedor tem precedência.

### #5 Margem de segurança 0.8× (default)

Quando a fila constrói o `CompositeRateLimiter` default (sem
`opts.rateLimiter` explícito), aplica `withSafetyMargin(500, 90_000, 0.8)` →
400 RPM / 72 k TPM. Operar em 80% do teto absorve janelas de pico do provedor
sem rejeitar suas requests.

Configurável via `opts.safetyMargin` ou `SAFETY_MARGIN` env (0.01–1.0). Use
`1.0` para desativar.

### #6 Concorrência adaptativa (AIMD)

`opts.adaptiveConcurrency: true` (default false) ativa Additive Increase /
Multiplicative Decrease:

- Em 429/5xx: `concurrency = max(min, floor(c / 2))`.
- Em sucesso: `concurrency = min(max, c + 1)`.

Trajetória após burst de 429: 8 → 4 → 2 → 1; em seguida sobe gradualmente até
o teto com sucessos consecutivos. Limites via `maxConcurrency` /
`minConcurrency`. Evento `concurrency-changed` com `{ reason, from, to }` em
toda mudança.

## API pública

Veja [`docs/API.pt-BR.md`](./docs/API.pt-BR.md) para referência completa. Resumo:

| Export | Função |
|---|---|
| `AiRequestQueue` | Classe principal: fila + rate limiting + retry + AIMD + sync + estimator |
| `CompositeRateLimiter` | Bucket duplo (RPM + TPM) com `acquire`, `syncRpmTpm` |
| `RequestRateLimiter`, `TokenRateLimiter` | Buckets individuais |
| `withSafetyMargin(rpm, tpm, margin)` | Aplica fator |
| `TokenEstimator` | EWMA com `observe`/`current` |
| `DefaultProviderClient` | Wrapper `fetch` que classifica 429/5xx/4xx |
| `RetryExecutor`, `exponentialBackoffWithJitter`, `fullJitterBackoff` | Retentativas |
| `NonRetryableError`, `MaxRetriesExceededError` | Erros tipados |
| `loadConfig` | Carrega params via `process.env` |
| `AiRequestQueueOptions`, `QueueEvent`, `ProviderRequest`, `ProviderResponse` | Tipos |

## Configuração via `.env`

Veja `.env.example`. Variáveis suportadas:

| Variável | Default | Descrição |
|---|---|---|
| `PROVIDER_BASE_URL` | `https://api.openai.com/v1` | URL base |
| `PROVIDER_API_KEY` | vazio | API key do provedor |
| `RPM_LIMIT` | 500 | Requisições/minuto |
| `TPM_LIMIT` | 90000 | Tokens/minuto |
| `QUEUE_CONCURRENCY` | 1 | Concorrência inicial |
| `ADAPTIVE_CONCURRENCY` | false | Ativa AIMD (via env — string "true") |
| `MAX_CONCURRENCY` | 8 | Teto AIMD |
| `MIN_CONCURRENCY` | 1 | Piso AIMD |
| `SAFETY_MARGIN` | 0.8 | Margem aplicada ao bucket default (`0 < margin <= 1`) |
| `MAX_RETRIES` | 8 | Máximo de retentativas |
| `BASE_BACKOFF_MS` | 1000 | Backoff base |
| `MAX_BACKOFF_MS` | 60000 | Teto do backoff |
| `MAX_AUTO_PAUSE_MS` | 60000 | Teto do auto-pause em `Retry-After` |

## Exemplos

- [`examples/basic-usage.ts`](./examples/basic-usage.ts) — mock fetch que
  simula 429 + 200. Isolado, sem custo. Demonstra pausa, sync, EWMA, AIMD.
- [`examples/openai-integration.ts`](./examples/openai-integration.ts) —
  integração real com OpenAI. **Custa créditos**.

## Comparação com alternativas

| Critério | rate-guard | BullMQ | Bottleneck | p-limit |
|---|---|---|---|---|
| Redis | não | **sim** | não | não |
| Token bucket | sim (RPM + TPM) | não | sim | não |
| Backoff + Retry-After | sim | sim | não | não |
| Sync de headers em runtime | sim | não | não | não |
| EWMA calibration | sim | não | não | não |
| AIMD concorrência | sim | manual | não | não |
| Predicted-over-limit event | sim | não | não | não |
| Dependências runtime | 1 (p-queue) | Redis + ioredis | 0 | 0 |
| Multi-processo | não (in-memory) | sim | não | não |
| Bundle size | ~20KB | ~200KB | ~10KB | ~5KB |

Use `rate-guard` quando você precisa de **auto-regulação inteligente** em
processo único. Use BullMQ quando você precisa de persistência/multi-processo.

## Migração

Veja [`docs/MIGRATION.pt-BR.md`](./docs/MIGRATION.pt-BR.md) para migração de BullMQ,
Bottleneck, p-limit, ou implementação caseira.

## Roadmap

- [ ] Cache idempotente de respostas (hash do body) — reduz volume estrutural.
- [ ] Desduplicação de chamadas em voo (in-flight dedup).
- [ ] Multi-processo via shared state (sem Redis, via SQLite WAL).
- [ ] Adaptador para Anthropic SDK python-style (cache de prompts).
- [ ] Métricas Prometheus prontas.

## Contribuindo

Veja [`CONTRIBUTING.pt-BR.md`](./CONTRIBUTING.pt-BR.md). Em resumo: abra uma issue antes
de PRs grandes, escreva testes, mantenha tudo verde.

## Licença

[MIT](./LICENSE) — © 2026 rate-guard contributors.
