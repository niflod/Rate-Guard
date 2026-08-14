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

test("queue enqueues, retries on 429 and finishes with success", async () => {
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
  assert.ok(retries >= 2, `expected >=2 retry events, got ${retries}`);
  const success = events.find((e) => e.type === "success");
  assert.ok(success);
});

test("queue rejects a non-retryable request without retries", async () => {
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
      assert.match((err as Error).message, /non-retryable/i);
      return true;
    },
  );
  assert.equal(calls, 1, "there should be no retries for 401");
});

test("queue exposes size and pending", async () => {
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({
    provider,
    rateLimiter: new CompositeRateLimiter(60, 10_000),
    concurrency: 2,
  });
  // Before adding: size/pending are numbers
  assert.ok(typeof queue.size === "number");
  assert.ok(typeof queue.pending === "number");
});

test("auto-pauses the queue on 429 with Retry-After and resumes after the deadline", async () => {
  // Scenario: req1 gets 429 with retry-after=0.05s (50ms) and then 200.
  // req2 must wait for the auto-resume before executing.
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
  assert.ok(elapsed >= 50, `req2 should start only after ~50ms, started at ${elapsed}ms`);

  const paused = events.filter((e) => e.type === "paused" && e.reason === "auto");
  const resumed = events.filter((e) => e.type === "resumed" && e.reason === "auto");
  assert.ok(paused.length >= 1, "expected >=1 paused auto");
  assert.ok(resumed.length >= 1, "expected >=1 resumed auto");
  if (paused[0].type === "paused") {
    assert.ok((paused[0].durationMs ?? 0) <= 60_000);
  }
});

test("manual pause is not cancelled by Retry-After", async () => {
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

  // Give time for any eventual auto-resume to appear.
  await new Promise((r) => setTimeout(r, 150));

  const resumedAuto = events.filter((e) => e.type === "resumed" && e.reason === "auto");
  assert.equal(resumedAuto.length, 0, "auto-resume should not fire with a manual pause active");

  queue.resume();
  await assert.rejects(() => p, () => true);
});

test("syncs the rateLimiter from x-ratelimit-* headers on success", async () => {
  // Scenario: local bucket starts "full" (60 RPM, 10k TPM). After the 1st
  // call, the provider announces via headers that only 10 RPM (cap 60) and
  // 1000 TPM (cap 10k) remain. The queue must sync the bucket. We validate
  // the bucket state directly — we don't need to call acquire again.
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

  // After sync, the RPM bucket must have remaining=10 and capacity=60,
  //   TPM bucket must have remaining=1000 and capacity=10000.
  const rpm = (rateLimiter as unknown as { rpm: TokenRateLimiter }).rpm;
  const tpm = (rateLimiter as unknown as { tpm: TokenRateLimiter }).tpm;
  const rRpm = rpm.available();
  const rTpm = tpm.available();
  assert.equal(rRpm.capacity, 60);
  assert.ok(rRpm.remaining <= 10.001 && rRpm.remaining >= 9.9, `rpm.remaining=${rRpm.remaining}`);
  assert.equal(rTpm.capacity, 10_000);
  assert.ok(rTpm.remaining <= 1000.01 && rTpm.remaining >= 999.9, `tpm.remaining=${rTpm.remaining}`);
});

test("syncs from Anthropic-style headers (anthropic-ratelimit-*)", async () => {
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

  // After sync, TPM capacity must be 5000 (not the original 10000).
  // Since Composite's available() returns a ratio, we validate each bucket directly.
  // Use a cast to access internals:
  const tpm = (rateLimiter as unknown as { tpm: TokenRateLimiter }).tpm;
  const tpmBudget = tpm.available();
  assert.equal(tpmBudget.capacity, 5000);
  assert.ok(tpmBudget.remaining <= 2000.1 && tpmBudget.remaining >= 1999.9,
    `tpm.remaining=${tpmBudget.remaining}`);
});

test("queue ignores missing x-ratelimit headers without altering capacity", async () => {
  const fetchFn: typeof fetch = async () => res(200, { id: "ok" });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const rateLimiter = new CompositeRateLimiter(60, 10_000);
  const queue = new AiRequestQueue({ provider, rateLimiter, concurrency: 1 });

  const rpm = (rateLimiter as unknown as { rpm: TokenRateLimiter }).rpm;
  const tpm = (rateLimiter as unknown as { tpm: TokenRateLimiter }).tpm;
  const rpmCapBefore = rpm.available().capacity;
  const tpmCapBefore = tpm.available().capacity;

  await queue.enqueue({ path: "/p", estimatedTokens: 1 });

  // Without x-ratelimit-* headers the queue shouldn't call sync, so the
  //   capacity of each bucket remains unchanged.
  assert.equal(rpm.available().capacity, rpmCapBefore);
  assert.equal(tpm.available().capacity, tpmCapBefore);
});

test("feeds TokenEstimator with usage.total_tokens on success", async () => {
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

  await queue.enqueue({ path: "/p" }); // no estimatedTokens — uses the estimator
  await queue.enqueue({ path: "/p" });

  // After 2 observations of 850: EWMA(alpha=0.5) starts at 100, first sample
  // replaces it -> 850, second sample -> 0.5*850 + 0.5*850 = 850.
  // We validate that the estimator converged close to the real sample.
  const cast = queue as unknown as {
    estimator: { current(): { estimate: number; samples: number } };
  };
  const snap = cast.estimator.current();
  assert.equal(snap.samples, 2);
  assert.ok(snap.estimate >= 840 && snap.estimate <= 860,
    `expected ~850, got ${snap.estimate}`);
});

test("feeds estimator with prompt_tokens + completion_tokens when there's no total_tokens", async () => {
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

test("emits predicted-over-limit when estimate exceeds remaining TPM", async () => {
  // Scenario: TPM sync is low (5) but capacity is high (1M) — fast
  // regeneration lets acquire complete in ~50ms without hanging.
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
  // After success, headers synced TPM to remaining=5, capacity=1M.
  //   Estimator saw 850 and (alpha=1) stayed at 850.
  //   TPM with cap=1M regenerates 1M/60s ~= 16.6 tokens/ms, so waiting
  //   from 5 to 850 takes ~50ms (no hang).
  events.length = 0;
  await queue.enqueue({ path: "/p" }); // no estimatedTokens -> uses 850

  const predicted = events.filter((e) => e.type === "predicted-over-limit");
  assert.ok(predicted.length >= 1, "expected >=1 predicted-over-limit");
  if (predicted[0].type === "predicted-over-limit") {
    assert.ok(predicted[0].estimatedTokens >= 800, `expected >=800, got ${predicted[0].estimatedTokens}`);
    // TPM regenerates continuously; between sync (remaining=5) and verify
    // (~30ms later) it may have regenerated ~30-50 tokens. We accept up to
    // 100 as tolerance for scheduling jitter.
    assert.ok(predicted[0].tpmRemaining <= 100,
      `expected <=100 (continuous regeneration), got ${predicted[0].tpmRemaining}`);
    assert.equal(predicted[0].tpmCapacity, 1_000_000);
  }
});

test("doesn't emit predicted-over-limit when there's enough budget", async () => {
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

test("default rateLimiter applies 0.8x margin over 500/90000", () => {
  // No rateLimiter passed — the queue must build a default with
  //   CompositeRateLimiter(400, 72000) due to safetyMargin=0.8.
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({ provider });

  const rl = (queue as unknown as {
    rateLimiter: { rpm: TokenRateLimiter; tpm: TokenRateLimiter };
  }).rateLimiter;
  assert.equal(rl.rpm.available().capacity, 400);
  assert.equal(rl.tpm.available().capacity, 72_000);
});

test("safetyMargin=1.0 disables the margin (full default)", () => {
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const queue = new AiRequestQueue({ provider, safetyMargin: 1.0 });

  const rl = (queue as unknown as {
    rateLimiter: { rpm: TokenRateLimiter; tpm: TokenRateLimiter };
  }).rateLimiter;
  assert.equal(rl.rpm.available().capacity, 500);
  assert.equal(rl.tpm.available().capacity, 90_000);
});

test("explicit opts.rateLimiter ignores safetyMargin", () => {
  const fetchFn: typeof fetch = async () => res(200, { ok: 1 });
  const provider = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  // Passes a CompositeRateLimiter(60, 10k). Even with safetyMargin=0.5,
  //   the explicit one must prevail.
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

test("adaptive concurrency off by default keeps concurrency fixed", async () => {
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

  assert.equal(queue.concurrency, 4, "without adaptive, it should NOT change");
  const changed = events.filter((e) => e.type === "concurrency-changed");
  assert.equal(changed.length, 0);
});

test("adaptive concurrency drops on 429 (multiplicative decrease)", async () => {
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

  // 429 -> 8/2 = 4. Success -> 4+1 = 5.
  assert.equal(queue.concurrency, 5,
    `expected 5 (4 after 429 + 1 after success), got ${queue.concurrency}`);

  const decreases = events.filter((e) => e.type === "concurrency-changed" && e.reason === "decrease");
  assert.ok(decreases.length >= 1, "expected >=1 decrease");
  if (decreases[0].type === "concurrency-changed") {
    assert.equal(decreases[0].from, 8);
    assert.equal(decreases[0].to, 4);
  }
});

test("adaptive concurrency rises on consecutive successes up to maxConcurrency", async () => {
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
  assert.equal(queue.concurrency, 5, `expected 5 after 4 successes starting from 1`);
  await queue.enqueue({ path: "/p", estimatedTokens: 1 });
  assert.equal(queue.concurrency, 5, "capped at maxConcurrency");
});

test("adaptive concurrency respects minConcurrency on a 429 cascade", async () => {
  // mock always 429 — maxRetries=5 emulates 6 failing attempts.
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
  assert.equal(queue.concurrency, 1, `expected 1 after multiple 429s, got ${queue.concurrency}`);
});



