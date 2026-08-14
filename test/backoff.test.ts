import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exponentialBackoffWithJitter,
  fullJitterBackoff,
  RetryExecutor,
  NonRetryableError,
  MaxRetriesExceededError,
  type RetryOutcome,
  success,
  retry,
} from "../src/retry/backoff.js";

const opts = { maxRetries: 4, baseBackoffMs: 10, maxBackoffMs: 100 };

test("backoff doubles with the attempt and respects the cap", () => {
  const values = Array.from({ length: 8 }, (_, attempt) =>
    exponentialBackoffWithJitter({ attempt, status: 429 }, opts),
  );
  // attempt 0: cap=10 -> [5,10]
  assert.ok(values[0] >= 5 && values[0] <= 10, `a0=${values[0]}`);
  // attempt 1: cap=20 -> [10,20]
  assert.ok(values[1] >= 10 && values[1] <= 20, `a1=${values[1]}`);
  // attempt 7: cap=100 (capped) -> [50,100]
  assert.ok(values[7] >= 50 && values[7] <= 100, `a7=${values[7]}`);
});

test("full jitter stays in [0, cap]", () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const v = fullJitterBackoff({ attempt, status: 429 }, opts);
    assert.ok(v >= 0 && v <= 100);
  }
});

test("RetryExecutor returns success on the first call", async () => {
  const exec = new RetryExecutor(opts);
  const op = async (): Promise<RetryOutcome<number>> => success(42);
  const r = await exec.run(op);
  assert.equal(r.value, 42);
  assert.equal(r.attempts, 1);
});

test("RetryExecutor retries on 429 until it succeeds", async () => {
  const exec = new RetryExecutor({ ...opts, baseBackoffMs: 5, maxBackoffMs: 20 });
  let n = 0;
  const op = async (): Promise<RetryOutcome<string>> => {
    n++;
    if (n < 3) return retry("429", { status: 429, retryable: true });
    return success("ok");
  };
  const r = await exec.run(op);
  assert.equal(r.value, "ok");
  assert.equal(r.attempts, 3);
});

test("RetryExecutor respects explicit retryAfterMs (simulates Retry-After)", async () => {
  const delays: number[] = [];
  const exec = new RetryExecutor({
    maxRetries: 3,
    baseBackoffMs: 9999,
    maxBackoffMs: 9999,
  });
  let n = 0;
  const start = Date.now();
  const op = async (): Promise<RetryOutcome<unknown>> => {
    n++;
    if (n < 2) return retry("429 with Retry-After=0.05s", { status: 429, retryAfterMs: 50, retryable: true });
    return success(null);
  };
  await exec.run(op);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 40, `expected >=40ms, got ${elapsed}ms`);
  assert.ok(elapsed < 1000);
  void delays;
});

test("RetryExecutor throws NonRetryableError on 4xx (not 429)", async () => {
  const exec = new RetryExecutor(opts);
  const op = async (): Promise<RetryOutcome<never>> =>
    retry("400 bad request", { status: 400 });
  await assert.rejects(() => exec.run(op), (err: unknown) => {
    assert.ok(err instanceof NonRetryableError);
    assert.equal((err as NonRetryableError).status, 400);
    return true;
  });
});

test("RetryExecutor throws MaxRetriesExceededError when attempts are exceeded", async () => {
  const exec = new RetryExecutor({ ...opts, baseBackoffMs: 1, maxBackoffMs: 2 });
  const op = async (): Promise<RetryOutcome<never>> =>
    retry("always 429", { status: 429, retryable: true });
  await assert.rejects(() => exec.run(op), (err: unknown) => {
    assert.ok(err instanceof MaxRetriesExceededError);
    assert.equal((err as MaxRetriesExceededError).lastStatus, 429);
    return true;
  });
});
