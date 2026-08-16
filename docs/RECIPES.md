# Recipes

> Languages: [English](./RECIPES.md) • [Português](./RECIPES.pt-BR.md)

## OpenAI (minimal configuration)

```ts
import { AiRequestQueue } from "rate-guard";
import { DefaultProviderClient, loadConfig } from "rate-guard";

const config = loadConfig();
const queue = new AiRequestQueue({
  provider: new DefaultProviderClient({
    baseUrl: config.providerBaseUrl,
    apiKey: config.providerApiKey,
  }),
  safetyMargin: config.safetyMargin,
  adaptiveConcurrency: true,
  backoff: { maxRetries: config.maxRetries, baseBackoffMs: config.baseBackoffMs, maxBackoffMs: config.maxBackoffMs },
});
```

## Anthropic (`anthropic-ratelimit-*` headers)

The same code works — the queue auto-detects Anthropic headers.

```ts
const queue = new AiRequestQueue({
  provider: new DefaultProviderClient({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  // the queue detects anthropic-ratelimit-* on success
});
```

## Custom provider

Implement `ProviderClient`:

```ts
import { ProviderClient, ProviderRequest, ProviderResponse, RetryOutcome, retry, success } from "rate-guard";

class MyProvider implements ProviderClient {
  async call<T>(req: ProviderRequest): Promise<RetryOutcome<ProviderResponse<T>>> {
    const res = await fetch(`${this.baseUrl}${req.path}`, {
      method: req.method ?? "POST",
      headers: { Authorization: `Bearer ${this.key}`, ...req.headers },
      body: req.body,
    });
    if (res.status === 429) return retry("rate limited", { status: 429, retryAfterMs: parseRetryAfter(res), retryable: true });
    if (res.status >= 500) return retry(`server error ${res.status}`, { status: res.status, retryable: true });
    if (res.status >= 400) return retry(`client error ${res.status}`, { status: res.status, retryable: false });
    return success<T>({ status: res.status, headers: res.headers, body: await res.json() as T });
  }
}
```

## Observability (Prometheus-compatible)

```ts
import { AiRequestQueue, QueueEvent } from "rate-guard";

const events = { retries: 0, successes: 0, pauses: 0, predictedOver: 0, concurrencyChanges: 0 };

const queue = new AiRequestQueue({
  provider,
  onEvent: (e: QueueEvent) => {
    switch (e.type) {
      case "retry": events.retries++; break;
      case "success": events.successes++; break;
      case "paused": events.pauses++; break;
      case "predicted-over-limit": events.predictedOver++; break;
      case "concurrency-changed": events.concurrencyChanges++; break;
    }
  },
});
// Periodically export to Prometheus / logs
```

## Priority (high -> low)

```ts
await queue.enqueue(req, { priority: 10 }); // high
await queue.enqueue(req, { priority: 0 });  // normal
await queue.enqueue(req, { priority: -5 }); // low
```

## Cancel / pause manually

```ts
queue.pause();   // pauses everything
queue.resume();  // resumes
```

## Custom per-call estimate

```ts
await queue.enqueue({ path: "/chat", body: "..." }, { estimatedTokens: 2000 });
```

## Test with a mock (no cost)

```ts
const mockFetch: typeof fetch = async () => {
  if (++calls <= 2) return new Response('{"error":"rate limited"}', { status: 429, headers: { "retry-after": "0.5" } });
  return new Response('{"id":"ok"}', { status: 200 });
};
const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn: mockFetch });
```

---

## Framework integration

### Express / Fastify (middleware)

```ts
import { AiRequestQueue } from "rate-guard";

const queue = new AiRequestQueue({ provider, concurrency: 4 });

app.post("/chat", async (req, res) => {
  const result = await queue.enqueue({ path: "/chat", body: JSON.stringify(req.body) });
  res.json(result.value.body);
});
```

### Worker queue (BullMQ-style but without Redis)

```ts
// Use AiRequestQueue itself — it is already a queue with backpressure, retry and AIMD
const queue = new AiRequestQueue({ provider, concurrency: 2 });

for (const job of jobs) {
  queue.enqueue(job); // doesn't block, adds to the queue
}
await queue.onIdle(); // waits for everything
```
