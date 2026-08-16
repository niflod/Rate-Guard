# Examples

> Languages: [English](./README.md) • [Português](./README.pt-BR.md)

Working examples to get started quickly with `rate-guard`.

## Contents

| Example | Description | Prerequisites |
|---|---|---|
| [`basic-usage.ts`](./basic-usage.ts) | Mock fetch that simulates 429 twice and then success. Demonstrates pause on `Retry-After`, header sync, EWMA estimator, AIMD. | None — runs isolated with mocked fetch. |
| [`openai-integration.ts`](./openai-integration.ts) | Real integration with the OpenAI API. Fires 3 prompts in parallel, shows responses + final telemetry (concurrency, tokens, AIMD). | `OPENAI_API_KEY` in env. **Costs credits.** |

## Run

```bash
# Clone the repo, install deps:
npm install

# Isolated example (no cost):
npx tsx examples/basic-usage.ts

# OpenAI example (costs credits):
OPENAI_API_KEY=sk-... npx tsx examples/openai-integration.ts
```

## What to watch in the output

- `paused` / `resumed`: automation in response to `Retry-After`.
- `sync rpm={...}` / `sync tpm={...}`: bucket realigned with the provider.
- `[estimator]`: EWMA calibrated from `usage.total_tokens`.
- `[concurrency] N→M`: AIMD (decrease on failure, increase on success).
- `predicted-over-limit`: estimate exceeds the remaining TPM — the next call
  will likely wait.
