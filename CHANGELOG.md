# Changelog

> Languages: [Português](./CHANGELOG.md) • [English](./CHANGELOG.en.md)

Todos os mudanças notáveis do projeto `rate-guard` serão documentados neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
e este projeto segue [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-13

Initial release. Engine de fila in-memory com 5 mecanismos combinados para
eliminar erros `429 Too Many Requests` provedores de IA — sem Redis, sem
BullMQ, sem build step obrigatório (consumidor roda via `tsx` ou compila).

### Adicionado

- **Token Bucket contínuo (RPM + TPM, juntos)** — `ContinuousBucket` no
  módulo `rate-limiter/token-bucket.ts`. Regenera tokens proporcionalmente
  ao tempo decorrido, suavizando do limite. `CompositeRateLimiter` adquire
  RPM = 1 e TPM = `cost` em sequência, respeitando o eixo mais restritivo.

- **#1 — Sincronização do bucket via headers do provedor em sucesso** — a
  fila lê os headers `x-ratelimit-*` (convenção OpenAI) e
  `anthropic-ratelimit-*` (convenção Anthropic) em cada resposta de sucesso
  e realinha o `CompositeRateLimiter` via `syncRpmTpm(rpm, tpm)`. Elimina o
  drift acumulado entre nossa estimativa e o limite real do provedor em
  runtime (quota upgrade, janela de pico, etc.).

- **#2 — Pausa automática da fila inteira em `Retry-After`** — quando um 429
  chega com `Retry-After: <segundos>`, todos os itens da fila aguardam (não
  apenas o que falhou), porque disparar a próxima request imediatamente
  resultaria em outro 429. Implementado com `queue.pause()` + `setTimeout`
  (`unref`'d). Pausa manual via `pause()` bloqueia a auto-retomada. Teto
  `maxAutoPauseMs` (default 60s) protege contra header mal-formado.

- **#3 — Calibração da estimativa de tokens via EWMA** — `TokenEstimator`
  (módulo `rate-limiter/token-estimator.ts`) aprende com
  `usage.total_tokens`/`prompt_tokens + completion_tokens` das respostas de
  sucesso. Estimativa default passa a ser a média calibrada, não um número
  fixo. Evento `predicted-over-limit` é emitido antes de `acquire` quando a
  estimativa excede o TPM remanescente — útil para SLO/SLA monitoring.

- **#4 — Backoff mais agressivo** — defaults: `maxRetries: 8`,
  `maxBackoffMs: 60_000` (era 5/30s). Janela de recuperação máxima ~5min
  contra quedas prolongadas do provedor. Overridável via `opts.backoff` ou
  env vars `MAX_RETRIES`/`MAX_BACKOFF_MS`.

- **#5 — Margem de segurança 0.8× no bucket default** — quando a fila
  constrói o `CompositeRateLimiter` default, aplica `withSafetyMargin(500,
  90_000, 0.8)` → 400 RPM / 72 k TPM. Operar em 80% do teto absorve
  janelas de pico do provedor sem rejeitar suas requests. Configurável via
  `opts.safetyMargin` ou `SAFETY_MARGIN` env (0.01–1.0).

- **#6 — Concorrência adaptativa (AIMD)** — `opts.adaptiveConcurrency:
  true` (default false) ativa Additive Increase / Multiplicative
  Decrease. Em 429/5xx: `concurrency = max(min, floor(c / 2))`; em sucesso:
  `concurrency = min(max, c + 1)`. Limites via `maxConcurrency` /
  `minConcurrency`. Evento `concurrency-changed` com `{ reason, from, to }`
  em toda mudança.

- **`DefaultProviderClient`** — wrapper de `fetch` que classifica 429/5xx
  como recuperável, 4xx (≠429) como não-recuperável, e parseia cabeçalho
  `Retry-After` (em segundos ou HTTP-date). Erro de rede/DNS =
  recuperável.

- **`RetryExecutor`** —-generic executor com backoff exponencial + jitter
  ("equal jitter" como default, "full jitter" disponível). Respeita
  `Retry-After` quando fornecido. Erros tipados:
  `NonRetryableError`, `MaxRetriesExceededError`.

- **`loadConfig()`** — carrega todos os parâmetros via `process.env` com
  defaults sensatos (ver `.env.example`).

- **26 testes** cobrindo todos os módulos em isolado e em integração
  (49 testes no total considerando variações; rodados sob Node 20+ com
  `node --test` + `tsx`). Todos passando em CI local.

- **6 eventos de telemetria** emitidos via `onEvent`: `enqueued`,
  `rate-acquired`, `retry`, `success`, `failed`, `idle`, `paused`,
  `resumed`, `predicted-over-limit`, `concurrency-changed`.

- **2 exemplos**: `examples/basic-usage.ts` (mock fetch, sem custo) e
  `examples/openai-integration.ts` (real, custa créditos).

- **Documentação profissional**: README, `docs/ARCHITECTURE.md`,
  `docs/API.md`, `docs/RECIPES.md`, `docs/MIGRATION.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.

- **CI** via GitHub Actions (Node 20/22 matrix: typecheck + lint + test).

### Correções (colaterais, feitas durante a extração do módulo)

- eslint flat config (ESLint 9) — migrado de CommonJS para ESM flat config;
  agora `@eslint/js` declarado explicitamente em `devDependencies`.
- `provider-client.ts` — removidas variáveis `text` mortas nos branches 429
  e 5xx (estavam lendo body sem uso).
- `token-bucket.test.ts` — fix de flake: assert `(remaining <= 59.0001)`
  era frágil porque o bucket regenera continuamente; agora usa margem
  58–60 refletindo a realidade de regeneração assíncrona.

### Notas

- Sem paths absolutos hard-coded. Sem acoplamento a arquitetura do
  consumidor. Sem dependência de Redis/BullMQ.
- Única dependência runtime externa: `p-queue@^8`.
- Compila com TypeScript 5.7 strict, `nocImplicitAny`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- Estado do projeto: 0 regressões conhecidas. 49/49 testes em CI local.
