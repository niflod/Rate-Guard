/**
 * Real integration example with the OpenAI API using rate-guard.
 *
 * Prerequisites:
 *   - Node 20+
 *   - OPENAI_API_KEY environment variable set (e.g. export OPENAI_API_KEY=sk-...)
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/openai-integration.ts
 *
 * This example:
 *   1. Builds a DefaultProviderClient pointing at api.openai.com.
 *   2. Builds the queue using loadConfig() (reads RPM_LIMIT/TPM_LIMIT/etc
 *      from .env or defaults).
 *   3. Fires 3 small prompts in parallel (controlled concurrency) and waits
 *      for all to finish.
 *   4. Prints a telemetry summary at the end.
 *
 * Note: this example makes real calls (costs credits on your account). Use
 * `examples/basic-usage.ts` for a local no-cost version (mock fetch).
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
  console.error("Set OPENAI_API_KEY to run this example.");
  process.exit(1);
}

const config = loadConfig();

const provider = new DefaultProviderClient({
  baseUrl: config.providerBaseUrl,
  apiKey,
});

const prompts = [
  "Explain the greenhouse effect in one sentence.",
  "List 3 southern-hemisphere constellation names.",
  "What's the largest planet in the solar system?",
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

console.log(`Firing ${prompts.length} prompts...`);

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

console.log("\n--- Results ---");
results.forEach((r, i) => {
  if (r.status === "fulfilled") {
    const body = r.value.value.body as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content ?? "(no response)";
    const tokens = body.usage?.total_tokens ?? 0;
    console.log(`[${i + 1}] tokens=${tokens}\n    ${text}\n`);
  } else {
    console.error(`[${i + 1}] FAILED: ${(r.reason as Error).message}`);
  }
});

console.log("\n--- Final telemetry ---");
console.log(`final concurrency: ${queue.concurrency}`);
console.log(`pending: ${queue.pending}, size: ${queue.size}`);
await queue.onIdle();
process.exit(0);
