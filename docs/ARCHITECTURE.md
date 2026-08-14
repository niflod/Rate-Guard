# Arquitetura

> Languages: [Português](./ARCHITECTURE.md) • [English](./ARCHITECTURE.en.md)

Este documento explica em profundidade as decisões por trás do `rate-guard`.
Para a referência de API, veja [`API.md`](./API.md).

## Visão de sistema

```
                          ┌──────────────────────────────────────────────────┐
                          │                  AiRequestQueue                 │
                          │                                                  │
user action ──enqueue──➤  │  ┌─────────┐   ┌──────────┐   ┌──────────────┐  │
                          │  │ p-queue  ➤ │ acquire  ➤ │ RetryExecutor │  │
                          │  │         │  │ tokens   │  │   + backoff │  │
                          │  │         │  │ +        │  │   + Retry-  │  │  ──provider.call(POST /chat) ──➤
                          │  │         │  │ syncHea- │  │   After     │  │                                  │
                          │  │         │  │ ders     │  │   + AIMD    │  │  ◀── resposta 200/429/5xx ◀────  │
                          │  │         │  │ + predi- │  │             │  │                                  │
                          │  │         │  │ ct-over- │  │             │  │                                  │
                          │  │         │  │ limit    │  │             │  │                                  │
                          │  │         │  │ + pause  │  │             │  │                                  │
                          │  └─────────┘   └──────────┘   └──────────────┘  │
                          │                                                  │
                          │  onEvent ─➤ { enqueued, retry, success, paused, │
                          │                resumed, predicted-over-limit,  │
                          │                concurrency-changed, ... }        │
                          └──────────────────────────────────────────────────┘
```

## Grafo de dependências interna

```
src/index.ts (barrel)
├── src/config/index.ts        (autônomo: lê process.env)
├── src/queue/ai-request-queue.ts
│   ├── p-queue (npm)
│   ├── src/provider/provider-client.ts
│   │   └── src/retry/backoff.ts   (RetryOutcome, retry(), success())
│   ├── src/rate-limiter/token-bucket.ts
│   │   └── (stdlib)
│   ├── src/rate-limiter/token-estimator.ts
│   │   └── (stdlib)
│   └── src/retry/backoff.ts
│       └── (stdlib)
└── (re-exports dos módulos acima + ProviderClient/Request/Response)
```

Ciclo: nenhuma dependência circular. `provider-client` só conhece tipos de
`retry/backoff`; `rate-limiter/*` não conhece nada exceto stdlib.

## Mecanismos em profundidade

### #0 Token bucket contínuo (RPM + TPM)

`ContinuousBucket` é "leaky bucket" e não "fixed window". Regenera tokens
**continuamente** proporcional ao tempo decorrido:

```typescript
refillRatePerMs = capacity / intervalMs
added = elapsed * refillRatePerMs
tokens = min(capacity, tokens + added)
```

Vantagem:

- Suaviza bursts (ex.: permite 60 req em 1s no início, mas depois regenera
  1 req/1s se a `capacity` é 60/minuto).
- Sem `setInterval` — só calcula no momento do `acquire`/`available`.

`CompositeRateLimiter.acquire(cost)` faz:

```
rRpm = await rpm.acquire(1)
rTpm = await tpm.acquire(cost)
waitedMs = rRpm.waitedMs + rTpm.waitedMs
```

Adquire RPM primeiro (mais barato), TPM depois. Se ambos `waited`, soma.

### #1 Sync de headers em runtime

Após um sucesso, lê-se headers e chamamos `syncRpmTpm(rpm, tpm)`:
```typescript
sync(remaining, capacity) {
  this.capacity = capacity;  // reajusta
  this.tokens = min(capacity, max(0, remaining));
  this.lastRefill = now();    // zera regeneração — não inflar no próximo tick
}
```

Por que isso importa?

- O provedor anuncia quando de fato falta — não precisamos adivinhar.
- Se a `capacity` mudou (conta promovida), o bucket segue o novo teto.
- Zerar o relógio evita somar regeneração "de tempo que não existiu".

### #2 Pausa automática em Retry-After

`autoPauseFor(ms)`:

1. Ignora se `manualPaused` (usuário pediu pausar).
2. `clearTimeout(autoResumeTimer)` para escalar (não acumular timers).
3. `queue.pause()` — todos itens (já em voo + aguardando) param.
4. `setTimeout(()=>queue.start(), ms)` com `.unref()` (não segura o processo
   Node em shutdown).
5. Emite `paused { reason: "auto", untilMs, durationMs }`.

Invariante: `autoPausedUntil !== null` implica existe 1 timer pendente.

Por que pausa **toda** a fila?

- A request X acabou de tomar 429. Y está em voo? Provavelmente já falhou
  também (provedor delimita por segundo).
- O que está aguardando na fila — se a fila ignorar e dispara X' imediatamente,
  virtualmente vocês garantem outro 429 — que outro `Retry-After` —- e assim
  entra em cascata.
- Pausar **tudo** pelo tempo exato do `Retry-After` é a interpretação
  literal do que o provedor pediu.

### #3 EWMA calibration (TokenEstimator)

`next = alpha * sample + (1 - alpha) * previous`, com `alpha = 0.3` default.

- Primeiro sample real substitui o initial 1000 — não suaviza contra um
  marcador sintético.
- Rejeita 0/negativo/NaN/Infinity (samples inválidos).
- Clamp a `maxEstimate = 1_000_000` para evitar runaway.

Por que EWMA e não média simples?

- O(1) memória (sem armazenar histórico).
- Reage em 3-5 amostras a uma mudança de padrão.
- Resistente a outliers (single spike não domina).

Quando emitir `predicted-over-limit`: **antes** de `acquire`. A fila ainda
tenta, mas o consumidor pode alertar — útil para SLO/SLA "previsão de jlong".

### #4 Backoff exponencial + jitter

`exponentialBackoffWithJitter` (equal jitter — strategy de AWS):

```
cap = min(baseBackoffMs * 2^attempt, maxBackoffMs)
delay = cap/2 + random(0, cap/2)
```

- `2^attempt` dobra a cada retry (1s, 2s, 4s, 8s, 16s, 32s, then capped em 60s).
- `cap/2` como base + `random(0, cap/2)` como jitter dispersa as retentativas.
- `Retry-After` do provedor tem precedência quando fornecido.

Defaults novos: `maxRetries: 8`, `maxBackoffMs: 60_000`.

Backoff total máximo: `1+2+4+8+16+32+60+60 = 183s` ≈ 3 minutos. Isto cobre
janelas de queda prolongada do provedor (1-3 min) que não eram cobertas
pelos defaults anteriores (5/30s = ~63s máximo).

### #5 Margem de segurança 0.8× (default)

`withSafetyMargin(rpm, tpm, margin)` aplica `Math.floor(rpm * margin)` com
clamp `>= 1`.

Por que operar em 80% do teto?

- O provedor está sujeito a variações internas (picos de vizinhos ruídosos,
  quotas concorrentes dentro da conta).
- Manter 20% margem absorve essas flutuações sem rejeitar suas requests —
  ao custo de throughput marginal (~5% em steady state).
- `safetyMargin = 1.0` desativa (operador quer o limite cheio).

### #6 AIMD (Additive Increase / Multiplicative Decrease)

Algoritmo clássico do TCP. Adaptado para concorrência de requests:

- **Decrease (em 429/5xx)**: `concurrency = max(min, floor(c / 2))`.
  - Divide por 2 — recupera rápido de uma queda de capacidade.
  - Vários 429s em sequência: 8 → 4 → 2 → 1 em 3 falhas.
- **Increase (em sucesso)**: `concurrency = min(max, c + 1)`.
  - Soma 1 — sobe devagar, evita ofender o provedor novamente.
  - Em steady estado, demora `max - min` sucessos para chegar ao teto.
- Limites: `minConcurrency = 1` (default), `maxConcurrency = 8` (default).

Por que não só backoff?

- Backoff trata 1 chamada. AIMD trata o **volume** que está ofendendo o
  provedor. São complementares: AIMD reduz janela, backoff trata a chamada
  que falhou.

Por que AIMD é opt-in?

- Em muitas cargas, o bucket já resolve — AIMD é overhead.
- Em cargas onde o provedor limita por concorrência (não por RPM/TPM), AIMD
  é essencial.

## Invariante de estado

A combinação dos mecanismos oferece estas propriedades juntas:

1. **Não dispara para depois** — bucket pré-acquire na fila (vs. tentar e esperar 429).
2. **Alinha-se ao provedor em runtime** — sync + Retry-After + AIMD.
3. **Aprende com uso real** — EWMA calibration de tokens.
4. **Escapa de situações instáveis** — backoff + AIMD + pausa em Retry-After.
5. **Observável** — 9 tipos de evento via `onEvent`.

## Análise de custo/benefício

| Mecanismo | CPU overhead | Latência adicionada | Redução de 429 esperada |
|---|---|---|---|
| #0 token bucket | trivial (1 mult + 1 min por req) | 0 quando há saldo | alta |
| #1 sync headers | trivial (parse headers) | 0 | média-alta |
| #2 pause | 1 setTimeout + 1 clearTimeout | retryAfterMs (~ms-s) | alta |
| #3 EWMA | 1 mult + 1 soma por sucesso | 0 | média |
| #4 backoff | apenas em falha | backoff (segundos) | alta quando falha |
| #5 margem 0.8× | 0 | 0 | média |
| #6 AIMD | 1 aritmética por resultado | 0 | alta em concorrência |

Total overhead em caminho de sucesso: < 1ms por req. Benefício:
eliminação virtual de 429 evitáveis em padrões realistas.
