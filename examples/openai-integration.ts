/**
 * Exemplo de integração real com a API da OpenAI usando rate-guard.
 *
 * Pré-requisitos:
 *   - Node 20+
 *   - Variável de ambiente OPENAI_API_KEY definida (ex.: export OPENAI_API_KEY=sk-...)
 *
 * Rodar:
 *   OPENAI_API_KEY=sk-... npx tsx examples/openai-integration.ts
 *
 * Este exemplo:
 *   1. Constrói o DefaultProviderClient apontando para api.openai.com.
 *   2. Constrói a fila usando loadConfig() (lê RPM_LIMIT/TPM_LIMIT/etc do .env
 *      ou dos defaults).
 *   3. Dispara 3 prompts pequenos em paralelo (concurrency controlada) e
 *      aguarda todos terminarem.
 *   4. Imprime um sumário de telemetria no final.
 *
 * Nota: este exemplo faz chamadas reais (custa créditos da sua conta). Use
 * `examples/basic-usage.ts` se quiser algo local sem custo (mock fetch).
 */
import { AiRequestQueue } from "../src/queue/ai-request-queue.js";
import { DefaultProviderClient } from "../src/provider/provider-client.js";
import { loadConfig } from "../src/config/index.js";
import {
  exponentialBackoffWithJitter,
  type QueueEvent,
} from "../src/index.js";

const apiKey = process.env.OPENAI_API_KEY ?? "";
if (!apiKey) {
  console.error("Defina OPENAI_API_KEY para rodar este exemplo.");
  process.exit(1);
}

const config = loadConfig();

const provider = new DefaultProviderClient({
  baseUrl: config.providerBaseUrl,
  apiKey,
});

const prompts = [
  "Explique o efeito estufa em uma frase.",
  "Liste 3 nomes de constelações do hemisfério sul.",
  "Qual o maior planeta do sistema solar?",
];

const queue = new AiRequestQueue({
  provider,
  concurrency: config.queueConcurrency,
  safetyMargin: config.safetyMargin,
  adaptiveConcurrency: true,
  maxConcurrency: 4,
  minConcurrency: 1,
  backoff: {
    maxRetries: config.maxRetries,
    baseBackoffMs: config.baseBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
  },
  delayResolver: exponentialBackoffWithJitter,
  onEvent: (ev: QueueEvent) => {
    if (ev.type === "retry") {
      console.warn(`[retry] attempt=${ev.attempt} status=${ev.status ?? "n/a"} reason=${ev.reason}`);
    } else if (ev.type === "predicted-over-limit") {
      console.warn(`[predicted-over-limit] estimate=${ev.estimatedTokens} tpm=${ev.tpmRemaining}/${ev.tpmCapacity}`);
    } else if (ev.type === "concurrency-changed") {
      console.log(`[concurrency] ${ev.from}→${ev.to} (${ev.reason})`);
    }
  },
});

console.log(`Disparando ${prompts.length} prompts...`);

const results = await Promise.allSettled(
  prompts.map((p) =>
    queue.enqueue({
      path: "/chat/completions",
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: p }],
        max_tokens: 100,
      }),
      estimatedTokens: 150,
    }),
  ),
);

console.log("\n--- Resultados ---");
results.forEach((r, i) => {
  if (r.status === "fulfilled") {
    const body = r.value.value.body as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content ?? "(sem resposta)";
    const tokens = body.usage?.total_tokens ?? 0;
    console.log(`[${i + 1}] tokens=${tokens}\n    ${text}\n`);
  } else {
    console.error(`[${i + 1}] FALHOU: ${(r.reason as Error).message}`);
  }
});

console.log("\n--- Telemetria final ---");
console.log(`concurrency final: ${queue.concurrency}`);
console.log(`pending: ${queue.pending}, size: ${queue.size}`);
await queue.onIdle();
process.exit(0);
