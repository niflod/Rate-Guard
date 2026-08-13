# Receitas

## OpenAI (configuração mínima)

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

## Anthropic (headers `anthropic-ratelimit-*`)

O mesmo código funciona — a fila detecta automaticamente headers do Anthropic.

```ts
const queue = new AiRequestQueue({
  provider: new DefaultProviderClient({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  // a fila detecta anthropic-ratelimit-* em sucesso
});
```

## Provedor customizado

Implemente `ProviderClient`:

```ts
import { ProviderClient, ProviderRequest, ProviderResponse, RetryOutcome, retry, success } from "rate-guard";

class MeuProvider implements ProviderClient {
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

## Observabilidade (Prometheus-compatible)

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
// Periodicamente exportar para Prometheus / logs
```

## Prioridade (high → low)

```ts
await queue.enqueue(req, { priority: 10 }); // alta
await queue.enqueue(req, { priority: 0 });  // normal
await queue.enqueue(req, { priority: -5 }); // baixa
```

## Cancelar / pausar manual

```ts
queue.pause();   // pausa tudo
queue.resume();  // retoma
```

## Estimativa customizada por chamada

```ts
await queue.enqueue({ path: "/chat", body: "..." }, { estimatedTokens: 2000 });
```

## Testar com mock (sem custo)

```ts
const mockFetch: typeof fetch = async () => {
  if (++calls <= 2) return new Response('{"error":"rate limited"}', { status: 429, headers: { "retry-after": "0.5" } });
  return new Response('{"id":"ok"}', { status: 200 });
};
const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn: mockFetch });
```

---

## Integração com frameworks

### Express / Fastify (middleware)

```ts
import { AiRequestQueue } from "rate-guard";

const queue = new AiRequestQueue({ provider, concurrency: 4 });

app.post("/chat", async (req, res) => {
  const result = await queue.enqueue({ path: "/chat", body: JSON.stringify(req.body) });
  res.json(result.value.body);
});
```

### Worker queue (BullMQ-style mas sem Redis)

```ts
// Use a própria AiRequestQueue — ela já é uma fila com backpressure, retry e AIMD
const queue = new AiRequestQueue({ provider, concurrency: 2 });

for (const job of jobs) {
  queue.enqueue(job); // não bloqueia, adiciona à fila
}
await queue.onIdle(); // aguarda tudo
```