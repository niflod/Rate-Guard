import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompositeRateLimiter,
  RequestRateLimiter,
  TokenRateLimiter,
  withSafetyMargin,
} from "../src/rate-limiter/token-bucket.js";

test("RequestRateLimiter releases immediately when budget is available", async () => {
  const limiter = new RequestRateLimiter(60);
  const r = await limiter.acquire(1);
  assert.equal(r.ok, true);
  assert.equal(r.consumed, 1);
  assert.ok(r.waitedMs >= 0);
  const b = limiter.available();
  // The bucket regenerates continuously; accepts up to 60 (capacity) or
  // slightly above 59 (consumed 1 but may have regenerated a fraction).
  assert.ok(b.remaining <= 60.0 && b.remaining >= 58.0, `remaining=${b.remaining}`);
});

test("CompositeRateLimiter respects TPM when RPM is loose", async () => {
  const limiter = new CompositeRateLimiter(60, 10_000);
  const r = await limiter.acquire(500);
  assert.equal(r.consumed, 500);
  assert.ok(r.waitedMs >= 0);
});

test("TokenRateLimiter exhausts capacity exactly", async () => {
  const limiter = new TokenRateLimiter(60);
  for (let i = 0; i < 6; i++) {
    const r = await limiter.acquire(10);
    assert.equal(r.consumed, 10);
  }
  const b = limiter.available();
  assert.ok(b.remaining <= 1.0, `remaining=${b.remaining}`);
});

test("Zero-cost acquire doesn't discount and returns immediately", async () => {
  const limiter = new RequestRateLimiter(60);
  const r = await limiter.acquire(0);
  assert.equal(r.consumed, 0);
  assert.equal(r.waitedMs, 0);
});

test("Bucket rejects capacity <= 0", () => {
  assert.throws(() => new RequestRateLimiter(0));
  assert.throws(() => new TokenRateLimiter(-1));
});

test("sync overwrites tokens and readjusts capacity", async () => {
  const limiter = new RequestRateLimiter(100);
  await limiter.acquire(50); // consumes half
  const before = limiter.available();
  assert.ok(before.remaining < 60, `expected <60, got ${before.remaining}`);

  limiter.sync(30, 100);
  const after = limiter.available();
  assert.equal(after.capacity, 100);
  assert.ok(after.remaining <= 30.001 && after.remaining >= 29.9, `remaining=${after.remaining}`);

  // Bucket capacity changed:
  const r = await limiter.acquire(25);
  assert.equal(r.ok, true);
});

test("sync silently rejects invalid values", () => {
  const limiter = new RequestRateLimiter(100);
  const empty = limiter.available();
  limiter.sync(-1, 100); // negative remaining: noop
  limiter.sync(50, 0); // capacity 0: noop

  const after = limiter.available();
  assert.equal(after.capacity, 100);
  assert.ok(after.remaining.toFixed(2) === empty.remaining.toFixed(2));
});

test("CompositeRateLimiter.syncRpmTpm updates RPM and TPM separately", async () => {
  const limiter = new CompositeRateLimiter(500, 10_000);
  await limiter.acquire(100);
  // Provider announces: 400 RPM remaining (cap 500), 9500 TPM (cap 10000)
  limiter.syncRpmTpm(
    { remaining: 400, capacity: 500 },
    { remaining: 9500, capacity: 10_000 },
  );
  const rpm = limiter["rpm" as keyof CompositeRateLimiter] as unknown as { available(): { remaining: number; capacity: number } };
  const tpm = limiter["tpm" as keyof CompositeRateLimiter] as unknown as { available(): { remaining: number; capacity: number } };

  const r = rpm.available();
  assert.equal(r.capacity, 500);
  assert.ok(r.remaining <= 400.001 && r.remaining >= 399.9, `rpm.remaining=${r.remaining}`);
  const t = tpm.available();
  assert.equal(t.capacity, 10_000);
  assert.ok(t.remaining <= 9500.1 && t.remaining >= 9499.9, `tpm.remaining=${t.remaining}`);
});

test("generic CompositeRateLimiter.sync is a noop (doesn't affect state)", async () => {
  const limiter = new CompositeRateLimiter(500, 10_000);
  await limiter.acquire(100);
  const before = limiter.available();
  limiter.sync(0, 0); // intentional noop by contract
  const after = limiter.available();
  assert.equal(before.remaining.toFixed(3), after.remaining.toFixed(3));
});

test("withSafetyMargin applies factor 0.8 (default) over RPM/TPM", () => {
  const m = withSafetyMargin(500, 90_000);
  assert.equal(m.rpm, 400);
  assert.equal(m.tpm, 72_000);
});

test("withSafetyMargin custom (0.7) and rounding", () => {
  const m = withSafetyMargin(700, 91_000, 0.7);
  // 700 * 0.7 = 489.999... with floating point; floor -> 489. We accept
  // either 489 or 490 — the important thing is being within +/-1 of the expected.
  assert.ok(m.rpm === 489 || m.rpm === 490, `rpm=${m.rpm}`);
  assert.ok(m.tpm === 63699 || m.tpm === 63700, `tpm=${m.tpm}`);
});

test("withSafetyMargin never below 1 and rejects margin outside (0,1]", () => {
  assert.throws(() => withSafetyMargin(500, 90_000, 0));
  assert.throws(() => withSafetyMargin(500, 90_000, 1.5));
  // Edge case: RPM=1 with 0.5 still gives 1 (not 0).
  const m = withSafetyMargin(1, 1, 0.5);
  assert.equal(m.rpm, 1);
  assert.equal(m.tpm, 1);
});

