import { AiRequestQueue } from "../src/queue/ai-request-queue.js";
import { DefaultProviderClient } from "../src/provider/provider-client.js";
import { CompositeRateLimiter } from "../src/rate-limiter/token-bucket.js";
import {
  exponentialBackoffWithJitter,
  type QueueEvent,
} from "../src/index.js";

let calls = 0;
const mockFetch: typeof fetch = async (_input, _init?) => {
  calls += 1;
  if (calls <= 2) {
    return new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { "retry-after": "1", "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    choices: [],
    usage: { total_tokens: 180, prompt_tokens: 30, completion_tokens: 150 },
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-limit-requests": "60",
      "x-ratelimit-remaining-requests": "58",
      "x-ratelimit-limit-tokens": "10000",
      "x-ratelimit-remaining-tokens": "9800",
    },
  });
};

const provider = new DefaultProviderClient({
  baseUrl: "https://api.exemplo.com/v1",
  apiKey: "fake-key",
  fetchFn: mockFetch,
});

function log(ev: QueueEvent): void {
  const t = ev.type;
  if (t === "retry") {
    console.log(`[${t}] id=${ev.id} attempt=${ev.attempt} status=${ev.status ?? "n/a"} wait=${ev.waitMs ?? "??"}ms reason=${ev.reason}`);
  } else if (t === "success") {
    console.log(`[${t}] id=${ev.id} attempts=${ev.attempts} total=${ev.totalMs}ms`);
  } else if (t === "failed") {
    console.log(`[${t}] id=${ev.id} reason=${ev.reason} status=${ev.status ?? "n/a"}`);
  } else if (t === "rate-acquired") {
    console.log(`[${t}] id=${ev.id} waited=${ev.waitedMs}ms`);
  } else if (t === "paused") {
    console.log(`[${t}] reason=${ev.reason} duration=${ev.durationMs ?? "?"}ms until=${ev.untilMs ?? "?"}`);
  } else if (t === "resumed") {
    console.log(`[${t}] reason=${ev.reason}`);
  } else if (t === "predicted-over-limit") {
    console.log(`[${t}] id=${ev.id} estimate=${ev.estimatedTokens} tpm=${ev.tpmRemaining}/${ev.tpmCapacity}`);
  } else if (t === "concurrency-changed") {
    console.log(`[${t}] reason=${ev.reason} ${ev.from}→${ev.to}`);
  } else {
    console.log(`[${t}] ${(ev as { id?: string; path?: string }).id ?? (ev as { path?: string }).path ?? ""}`);
  }
}

const rateLimiter = new CompositeRateLimiter(60, 10_000);
const queue = new AiRequestQueue({
  provider,
  rateLimiter,
  concurrency: 4,
  adaptiveConcurrency: true,
  maxConcurrency: 8,
  minConcurrency: 1,
  backoff: { maxRetries: 5, baseBackoffMs: 500, maxBackoffMs: 5_000 },
  delayResolver: exponentialBackoffWithJitter,
  onEvent: log,
});

const body = JSON.stringify({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Oi" }],
});

const result = await queue.enqueue({
  path: "/chat/completions",
  method: "POST",
  body,
  estimatedTokens: 200,
});

console.log("FINAL:", JSON.stringify(result.value.body, null, 2));
console.log(`attempts=${result.attempts}`);

const rpmBudget = rateLimiter.available();
console.log(`[sync] ratio=${rpmBudget.remaining.toFixed(3)} (RPM dominante após sync)`);
const cast = rateLimiter as unknown as {
  rpm: { available(): { remaining: number; capacity: number } };
  tpm: { available(): { remaining: number; capacity: number } };
};
console.log(`[sync] rpm=${JSON.stringify(cast.rpm.available())}`);
console.log(`[sync] tpm=${JSON.stringify(cast.tpm.available())}`);

const estimCast = queue as unknown as {
  estimator: { current(): { estimate: number; samples: number } };
};
console.log(`[estimator] ${JSON.stringify(estimCast.estimator.current())}`);
console.log(`[concurrency] final=${queue.concurrency}`);

await queue.onIdle();
process.exit(0);
