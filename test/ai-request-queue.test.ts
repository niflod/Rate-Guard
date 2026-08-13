import { test } from "node:test";
import assert from "node:assert/strict";
import { AiRequestQueue } from "../src/queue/ai-request-queue.js";
import { DefaultProviderClient } from "../src/provider/provider-client.js";
import { CompositeRateLimiter, TokenRateLimiter } from "../src/rate-limiter/token-bucket.js";
import type { QueueEvent } from "../src/queue/ai-request-queue.js";

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("fila enfileira, retenta em 429 e termina com sucesso", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    if (calls <= 2) return res(429, { error: "rl" }, { "retry-after": "0.01" });
    return res(200, { id: "ok", data: 42 });
  };
  const events: QueueEvent[] = [];
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(60, 10_000),
    concurrency: 1,
    backoff: { maxRetries: 5, baseBackoffMs: 5, maxBackoffMs: 50 },
    onEvent: (e) => events.push(e),
  });

  const r = await queue.enqueue(
    { path: "/p", estimatedTokens: 100 },
    { estimatedTokens: 100 },
  );
  assert.equal(calls, 3);
  assert.equal(r.attempts, 3);
  assert.ok((r.value.body as { data: number }).data === 42);

  const retries = events.filter((e) => e.type === "retry").length;
  assert.ok(retries >= 2, `esperado >=2 retry events, veio ${retries}`);
  const success = events.find((e) => e.type === "success");
  assert.ok(success);
});

test("fila rejeita requisição não-recuperável sem retentativas", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    return res(401, { error: "unauthorized" });
  };
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(60, 10_000),
    concurrency: 1,
    backoff: { maxRetries: 5, baseBackoffMs: 5, maxBackoffMs: 50 },
  });
  await assert.rejects(
    () => queue.enqueue({ path: "/p", estimatedTokens: 10 }),
    (err: unknown) => {
      assert.match((err as Error).message, /não recuperável/);
      return true;
    },
  );
  assert.equal(calls, 1, "não deveria haver retentativas para 401");
});

test("fila expõe size e pending", async () => {
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(60, 10_000),
    concurrency: 2,
  });
  // Antes de adicionar: size/pending sao numbers
  assert.ok(typeof queue.size === "number");
  assert.ok(typeof queue.pending === "number");
});

test("pausa automaticamente a fila em 429 com Retry-After e retoma após o prazo", async () => {
  // Cenário: req1 recebe 429 com retry-after=0.05s (50ms) e depois 200.
  // req2 deve esperar a auto-retomada antes de executar.
  let firstReqCalls = 0;
  let secondReqStartedAt = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = (init?.body as string) ?? "";
    if (body.includes("\"req1\"")) {
      firstReqCalls++;
      if (firstReqCalls === 1) {
        return res(429, { error: "rl" }, { "retry-after": "0.05" });
      }
      return res(200, { id: "ok1" });
    }
    secondReqStartedAt = Date.now();
    return res(200, { id: "ok2" });
  };

  const events: QueueEvent[] = [];
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(10_000, 1_000_000),
    concurrency: 1,
    backoff: { maxRetries: 5, baseBackoffMs: 1, maxBackoffMs: 5 },
    onEvent: (e) => events.push(e),
  });

  const firstStartedAt = Date.now();
  const p1 = queue.enqueue({
    path: "/p",
    body: JSON.stringify({ tag: "req1" }),
    estimatedTokens: 1,
  });
  const p2 = queue.enqueue({
    path: "/p",
    body: JSON.stringify({ tag: "req2" }),
    estimatedTokens: 1,
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  const elapsed = secondReqStartedAt - firstStartedAt;

  assert.ok((r1.value.body as { id?: string }).id === "ok1");
  assert.ok((r2.value.body as { id?: string }).id === "ok2");
  assert.ok(elapsed >= 50, `req2 deveria iniciar só após ~50ms, iniciou em ${elapsed}ms`);

  const paused = events.filter((e) => e.type === "paused" && e.reason === "auto");
  const resumed = events.filter((e) => e.type === "resumed" && e.reason === "auto");
  assert.ok(paused.length >= 1, "esperado >=1 paused auto");
  assert.ok(resumed.length >= 1, "esperado >=1 resumed auto");
  if (paused[0].type === "paused") {
    assert.ok((paused[0].durationMs ?? 0) <= 60_000);
  }
});

test("pausa manual não é anulada por Retry-After", async () => {
  const fetchFn: typeof fetch = async () => res(429, { error: "rl" }, { "retry-after": "0.02" });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const events: QueueEvent[] = [];
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(10_000, 1_000_000),
    concurrency: 1,
    backoff: { maxRetries: 1, baseBackoffMs: 1, maxBackoffMs: 5 },
    maxAutoPauseMs: 100,
    onEvent: (e) => events.push(e),
  });

  queue.pause();
  const p = queue.enqueue({ path: "/p", estimatedTokens: 1 });

  // Dá tempo para qualquer auto-retomada eventual aparecer.
  await new Promise((r) => setTimeout(r, 150));

  const resumedAuto = events.filter((e) => e.type === "resumed" && e.reason === "auto");
  assert.equal(resumedAuto.length, 0, "auto-retomada não deveria disparar com pausa manual ativa");

  queue.resume();
  await assert.rejects(() => p, () => true);
});

test("sincroniza rateLimiter a partir de headers x-ratelimit-* em sucesso", async () => {
  // Cenário: bucket local começa "cheio" (60 RPM, 10k TPM). Após a 1ª
  // chamada, provedor anuncia via headers que restam só 10 RPM (cap 60) e
  // 1000 TPM (cap 10k). A fila deve sincronizar o bucket. Validamos o
  // estado do bucket diretamente — não precisamos chamar acquire de novo.
  const fetchFn: typeof fetch = async () =>
    res(
      200,
      { id: "ok" },
      {
        "x-ratelimit-remaining-requests": "10",
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-tokens": "1000",
        "x-ratelimit-limit-tokens": "10000",
      },
    );
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(60, 10_000);
  const queue = new AiRequestQueue({
    provider,
    rateLimiter,
    concurrency: 1,
  });

  const r = await queue.enqueue({ path: "/p", estimatedTokens: 1 });
  assert.ok((r.value.body as { id: string }).id === "ok");

  // Após sync, RPM bucket deve ter remaining=10 e capacity=60,
  //   TPM bucket deve ter remaining=1000 e capacity=10000.
  const rpm = (rateLimiter as unknown as { rpm: TokenRateLimiter }).rpm;
  const tpm = (rateLimiter as unknown as { tpm: TokenRateLimiter }).tpm;
  const rRpm = rpm.available();
  const rTpm = tpm.available();
  assert.equal(rRpm.capacity, 60);
  assert.ok(rRpm.remaining <= 10.001 && rRpm.remaining >= 9.9, `rpm.remaining=${rRpm.remaining}`);
  assert.equal(rTpm.capacity, 10_000);
  assert.ok(rTpm.remaining <= 1000.01 && rTpm.remaining >= 999.9, `tpm.remaining=${rTpm.remaining}`);
});

test("sincroniza a partir de headers estilo Anthropic (anthropic-ratelimit-*)", async () => {
  const fetchFn: typeof fetch = async () =>
    res(
      200,
      { id: "ok" },
      {
        "anthropic-ratelimit-requests-remaining": "5",
        "anthropic-ratelimit-requests-limit": "50",
        "anthropic-ratelimit-tokens-remaining": "2000",
        "anthropic-ratelimit-tokens-limit": "5000",
      },
    );
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(100, 10_000);
  const queue = new AiRequestQueue({
    provider,
    rateLimiter,
    concurrency: 1,
  });

  await queue.enqueue({ path: "/p", estimatedTokens: 1 });

  // Após sync, TPM capacity deve ser 5000 (não 10000 original).
  // Como available() do Composite retorna razão, validamos cada bucket direto.
  // Use cast para acessar internals:
  const tpm = (rateLimiter as unknown as { tpm: TokenRateLimiter }).tpm;
  const tpmBudget = tpm.available();
  assert.equal(tpmBudget.capacity, 5000);
  assert.ok(tpmBudget.remaining <= 2000.1 && tpmBudget.remaining >= 1999.9,
    `tpm.remaining=${tpmBudget.remaining}`);
});

test("fila ignora headers x-ratelimit ausentes sem alterar capacity", async () => {
  const fetchFn: typeof fetch = async () => res(200, { id: "ok" });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(60, 10_000);
  const queue = new AiRequestQueue({ provider, rateLimiter, concurrency: 1 });

  const rpm = (rateLimiter as unknown as { rpm: TokenRateLimiter }).rpm;
  const tpm = (rateLimiter as unknown as { tpm: TokenRateLimiter }).tpm;
  const rpmCapAntes = rpm.available().capacity;
  const tpmCapAntes = tpm.available().capacity;

  await queue.enqueue({ path: "/p", estimatedTokens: 1 });

  // Sem headers x-ratelimit-* a fila não deve chamar sync, portanto a
  //   capacity de cada bucket permanece inalterada.
  assert.equal(rpm.available().capacity, rpmCapAntes);
  assert.equal(tpm.available().capacity, tpmCapAntes);
});

test("alimenta TokenEstimator com usage.total_tokens em sucesso", async () => {
  const fetchFn: typeof fetch = async () =>
    res(200, {
      id: "ok",
      usage: { total_tokens: 850, prompt_tokens: 500, completion_tokens: 350 },
    });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(10_000, 1_000_000);
  const queue = new AiRequestQueue({
    provider,
    rateLimiter,
    concurrency: 1,
    tokenEstimator: { initialEstimate: 100, alpha: 0.5 },
  });

  await queue.enqueue({ path: "/p" }); // sem estimatedTokens — usa estimator
  await queue.enqueue({ path: "/p" });

  // Após 2 observações de 850: EWMA(α=0.5) começa em 100, primeiro sample
  // substitui → 850, segundo sample → 0.5*850 + 0.5*850 = 850.
  // Validamos que estimator convergiu perto do sample real.
  const cast = queue as unknown as {
    estimator: { current(): { estimate: number; samples: number } };
  };
  const snap = cast.estimator.current();
  assert.equal(snap.samples, 2);
  assert.ok(snap.estimate >= 840 && snap.estimate <= 860,
    `esperado ~850, veio ${snap.estimate}`);
});

test("alimenta estimator com prompt_tokens + completion_tokens quando não há total_tokens", async () => {
  const fetchFn: typeof fetch = async () =>
    res(200, {
      id: "ok",
      usage: { prompt_tokens: 200, completion_tokens: 100 },
    });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(10_000, 1_000_000);
  const queue = new AiRequestQueue({
    provider,
    rateLimiter,
    concurrency: 1,
    tokenEstimator: { initialEstimate: 50, alpha: 1 },
  });

  await queue.enqueue({ path: "/p" });
  const cast = queue as unknown as {
    estimator: { current(): { estimate: number } };
  };
  assert.equal(cast.estimator.current().estimate, 300);
});

test("emite predicted-over-limit quando estimativa excede TPM restante", async () => {
  // Cenário: TPM sync baixo (5) mas capacity alta (1M) — regeneração rápida
  // permite que o acquire complete em ~50ms sem hang.
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    const headers: Record<string, string> = calls === 1
      ? {
          "x-ratelimit-remaining-tokens": "5",
          "x-ratelimit-limit-tokens": "1000000",
        }
      : {};
    return res(200, {
      id: "ok",
      usage: { total_tokens: 850 },
    }, headers);
  };

  const events: QueueEvent[] = [];
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(10_000, 1_000_000);
  const queue = new AiRequestQueue({
    provider,
    rateLimiter,
    concurrency: 1,
    tokenEstimator: { initialEstimate: 850, alpha: 1 },
    onEvent: (e) => events.push(e),
  });

  await queue.enqueue({ path: "/p", estimatedTokens: 1 });
  // Após sucesso, headers sincronizaram TPM para remaining=5, capacity=1M.
  //   Estimator viu 850 e (alpha=1) ficou em 850.
  //   TPM com cap=1M regenera 1M/60s ≈ 16.6 tokens/ms, então esperar
  //   de 5 até 850 demora ~50ms (sem hang).
  events.length = 0;
  await queue.enqueue({ path: "/p" }); // sem estimatedTokens → usa 850

  const predicted = events.filter((e) => e.type === "predicted-over-limit");
  assert.ok(predicted.length >= 1, "esperado >=1 predicted-over-limit");
  if (predicted[0].type === "predicted-over-limit") {
    assert.ok(predicted[0].estimatedTokens >= 800, `esperado >=800, veio ${predicted[0].estimatedTokens}`);
    // TPM regenera continuamente; entre sync (remaining=5) e verify (~30ms
    // depois) pode ter regenerado ~30-50 tokens. Aceitamos ate 100 como
    // tolerance para jitter de scheduling.
    assert.ok(predicted[0].tpmRemaining <= 100,
      `esperado <=100 (regeneração contínua), veio ${predicted[0].tpmRemaining}`);
    assert.equal(predicted[0].tpmCapacity, 1_000_000);
  }
});

test("não emite predicted-over-limit quando há saldo suficiente", async () => {
  const fetchFn: typeof fetch = async () =>
    res(200, { id: "ok", usage: { total_tokens: 100 } });
  const events: QueueEvent[] = [];
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(10_000, 1_000_000);
  const queue = new AiRequestQueue({
    provider,
    rateLimiter,
    concurrency: 1,
    onEvent: (e) => events.push(e),
  });

  await queue.enqueue({ path: "/p", estimatedTokens: 50 });
  const predicted = events.filter((e) => e.type === "predicted-over-limit");
  assert.equal(predicted.length, 0);
});

test("default rateLimiter aplica margem 0.8x sobre 500/90000", () => {
  // Não passa rateLimiter — a fila deve construir um default com
  //   CompositeRateLimiter(400, 72000) devido ao safetyMargin=0.8.
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({ provider });

  const rl = (queue as unknown as {
    rateLimiter: { rpm: TokenRateLimiter; tpm: TokenRateLimiter };
  }).rateLimiter;
  assert.equal(rl.rpm.available().capacity, 400);
  assert.equal(rl.tpm.available().capacity, 72_000);
});

test("safetyMargin=1.0 desativa a margem (default cheio)", () => {
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({ provider, safetyMargin: 1.0 });

  const rl = (queue as unknown as {
    rateLimiter: { rpm: TokenRateLimiter; tpm: TokenRateLimiter };
  }).rateLimiter;
  assert.equal(rl.rpm.available().capacity, 500);
  assert.equal(rl.tpm.available().capacity, 90_000);
});

test("opts.rateLimiter explícito ignora safetyMargin", () => {
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  // Passa um CompositeRateLimiter(60, 10k). Mesmo com safetyMargin=0.5,
  //   o explícito deve prevalecer.
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(60, 10_000),
    safetyMargin: 0.5,
  });
  const rl = (queue as unknown as {
    rateLimiter: { rpm: TokenRateLimiter; tpm: TokenRateLimiter };
  }).rateLimiter;
  assert.equal(rl.rpm.available().capacity, 60);
  assert.equal(rl.tpm.available().capacity, 10_000);
});

test("conc adaptive desligada por default mantém concurrency fixa", async () => {
  const fetchFn: typeof fetch = async () => res(429, { error: "rl" }, { "retry-after": "0.001" });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const events: QueueEvent[] = [];
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(10_000, 1_000_000),
    concurrency: 4,
    backoff: { maxRetries: 1, baseBackoffMs: 1, maxBackoffMs: 5 },
    onEvent: (e) => events.push(e),
  });

  await assert.rejects(() => queue.enqueue({ path: "/p", estimatedTokens: 1 }), () => true);

  assert.equal(queue.concurrency, 4, "sem adaptive, NÃO deve mudar");
  const changed = events.filter((e) => e.type === "concurrency-changed");
  assert.equal(changed.length, 0);
});

test("conc adaptive diminui em 429 (multiplicative decrease)", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    if (calls <= 1) return res(429, { error: "rl" }, { "retry-after": "0.001" });
    return res(200, { id: "ok", usage: { total_tokens: 10 } });
  };
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const events: QueueEvent[] = [];
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(10_000, 1_000_000),
    concurrency: 8,
    adaptiveConcurrency: true,
    maxConcurrency: 8,
    minConcurrency: 1,
    backoff: { maxRetries: 5, baseBackoffMs: 1, maxBackoffMs: 5 },
    onEvent: (e) => events.push(e),
  });

  await queue.enqueue({ path: "/p", estimatedTokens: 1 });

  // 429 → 8/2 = 4. Sucesso → 4+1 = 5.
  assert.equal(queue.concurrency, 5,
    `esperado 5 (4 após 429 + 1 após sucesso), veio ${queue.concurrency}`);

  const decreases = events.filter((e) => e.type === "concurrency-changed" && e.reason === "decrease");
  assert.ok(decreases.length >= 1, "esperado >=1 decrease");
  if (decreases[0].type === "concurrency-changed") {
    assert.equal(decreases[0].from, 8);
    assert.equal(decreases[0].to, 4);
  }
});

test("conc adaptive sobe em sucessos sucessivos até maxConcurrency", async () => {
  const fetchFn: typeof fetch = async () => res(200, { id: "ok", usage: { total_tokens: 10 } });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(10_000, 1_000_000),
    concurrency: 1,
    adaptiveConcurrency: true,
    maxConcurrency: 5,
    minConcurrency: 1,
  });

  for (let i = 0; i < 4; i++) {
    await queue.enqueue({ path: "/p", estimatedTokens: 1 });
  }
  assert.equal(queue.concurrency, 5, `esperado 5 após 4 sucessos a partir de 1`);
  await queue.enqueue({ path: "/p", estimatedTokens: 1 });
  assert.equal(queue.concurrency, 5, "limitado em maxConcurrency");
});

test("conc adaptive respeita minConcurrency em cascata de 429", async () => {
  // mock sempre 429 — maxRetries=5 emula 6 tentativas falhando.
  const fetchFn: typeof fetch = async () => res(429, { error: "rl" }, { "retry-after": "0.001" });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(10_000, 1_000_000),
    concurrency: 4,
    adaptiveConcurrency: true,
    maxConcurrency: 8,
    minConcurrency: 1,
    backoff: { maxRetries: 5, baseBackoffMs: 1, maxBackoffMs: 5 },
  });

  await assert.rejects(
    () => queue.enqueue({ path: "/p", estimatedTokens: 1 }),
    () => true,
  );
  assert.equal(queue.concurrency, 1, `esperado 1 após multiplos 429, veio ${queue.concurrency}`);
});



