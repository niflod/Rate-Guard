# Exemplos

Exemplos funcionais para começar rápido com `rate-guard`.

## Conteúdo

| Exemplo | Descrição | Pré-requisitos |
|---|---|---|
| [`basic-usage.ts`](./basic-usage.ts) | Mock fetch que simula 429 duas vezes e depois sucesso. Demonstra pausa em `Retry-After`, sync de headers, EWMA estimator, AIMD. | Nenhum — roda isolado com fetch mockado. |
| [`openai-integration.ts`](./openai-integration.ts) | Integração real com a API da OpenAI. Dispara 3 prompts em paralelo, exibe respostas + telemetria final (concurrency, tokens, AIMD). | `OPENAI_API_KEY` no env. **Custa créditos.** |

## Rodar

```bash
# Clone o repo, instale deps:
npm install

# Exemplo isolado (sem custo):
npx tsx examples/basic-usage.ts

# Exemplo OpenAI (custa créditos):
OPENAI_API_KEY=sk-... npx tsx examples/openai-integration.ts
```

## O que observar no output

- `paused` / `resumed`: automação em resposta ao `Retry-After`.
- `sync rpm={...}` / `sync tpm={...}`: bucket realinhado com oprovedor.
- `[estimator]`: EWMA calibrada a partir do `usage.total_tokens`.
- `[concurrency] N→M`: AIMD (decrease em falha, increase em sucesso).
- `predicted-over-limit`: estimativa excede o TPM remanescente — próximo chamado provavelmente vai esperar.
