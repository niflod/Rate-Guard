# Guia de Migração

## De BullMQ / Redis Queue

| Conceito | BullMQ | rate-guard |
|---|---|---|
| Fila | `Queue` + Redis | `AiRequestQueue` (in-memory) |
| Rate limit | Manual / plugins | `CompositeRateLimiter` + auto |
| Retry | `attempts` + backoff | `RetryExecutor` + backoff + jitter |
| Retry-After | Manual | Automático (pausa fila inteira) |
| Concurrency | `concurrency` | `concurrency` + `adaptiveConcurrency` (AIMD) |
| Persistência | Sim (Redis) | Não (in-memory) |
| Multi-processo | Sim | Não (single-process) |

### Passos de migração

1. Substitua `new Queue("name")` por `new AiRequestQueue({ provider, ... })`.
2. Mova lógica de retry do worker para `opts.backoff` / `RetryExecutor`.
3. Remova Redis da infra — a fila roda no mesmo processo.
4. Se precisar persistência, veja roadmap (SQLite WAL planejado).

**Quando NÃO migrar**: se você precisa de persistência entre reinícios, multi-processo, ou mensagens que sobrevivem a crash.

---

## De Bottleneck / p-limit

| Feature | Bottleneck / p-limit | rate-guard |
|---|---|---|
| Token bucket (RPM) | Sim (manual) | Sim (auto + sync) |
| Token bucket (TPM) | Não | Sim |
| Backoff + jitter | Não | Sim |
| Retry-After | Não | Sim (pausa fila) |
| Sync de headers | Não | Sim |
| EWMA calibration | Não | Sim |
| AIMD | Não | Sim |
| Predicted-over-limit | Não | Sim |

### Passos de migração

1. Substitua `limiter.schedule(fn)` por `queue.enqueue(req)`.
2. Se usava `minTime`/`maxConcurrent`, mapeie para `rateLimiter` + `concurrency` / `adaptiveConcurrency`.
3. Ganha: sync de headers, EWMA, AIMD, Retry-After automático.

---

## De implementação caseira (TokenBucket + retry manual)

Se você já tem um token bucket e loop de retry:

1. Remova o bucket manual — use `CompositeRateLimiter`.
2. Remova o loop `while (retry) { try {...} catch {...} sleep(...) }` — use `RetryExecutor`.
3. Remova parse manual de `Retry-After` — `DefaultProviderClient` faz.
4. Adicione `syncFromHeaders` e `TokenEstimator` para ganhar sync + EWMA.

---

## Checklist de validação pós-migração

- [ ] `npm run typecheck` passa.
- [ ] `npm test` passa (rodar suites existentes + adicionar seus casos).
- [ ] `npm run example` roda sem erro.
- [ ] Em produção, monitore eventos `paused` / `predicted-over-limit` / `concurrency-changed`.
- [ ] Ajuste `SAFETY_MARGIN` / `adaptiveConcurrency` / `maxRetries` conforme seu provedor.