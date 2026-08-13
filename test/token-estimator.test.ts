import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenEstimator } from "../src/rate-limiter/token-estimator.js";

test("TokenEstimator começa com initialEstimate e samples=0", () => {
  const e = new TokenEstimator({ initialEstimate: 500, alpha: 0.5 });
  const snap = e.current();
  assert.equal(snap.estimate, 500);
  assert.equal(snap.samples, 0);
  assert.equal(e.hasRealData, false);
});

test("Primeiro observe substitui o initial (não suaviza contra ele)", () => {
  const e = new TokenEstimator({ initialEstimate: 500, alpha: 0.3 });
  e.observe(2000);
  assert.equal(e.current().estimate, 2000);
  assert.equal(e.current().samples, 1);
  assert.equal(e.hasRealData, true);
});

test("EWMA reage à mudança mas sem dominar por 1 sample", () => {
  const e = new TokenEstimator({ initialEstimate: 1000, alpha: 0.5 });
  // 3 samples de 100: converge para ~100 em poucos passos
  for (let i = 0; i < 5; i++) e.observe(100);
  const snap = e.current();
  assert.ok(snap.estimate < 200, `esperado <200, veio ${snap.estimate}`);
  assert.equal(snap.samples, 5);
});

test("EWMA com alpha=1 vira o último sample", () => {
  const e = new TokenEstimator({ initialEstimate: 1000, alpha: 1 });
  e.observe(500);
  e.observe(300);
  e.observe(900);
  assert.equal(e.current().estimate, 900);
});

test("observe rejeita 0, negativo, NaN e Infinity", () => {
  const e = new TokenEstimator({ initialEstimate: 777, alpha: 0.5 });
  e.observe(0);
  e.observe(-10);
  e.observe(NaN);
  e.observe(Infinity);
  assert.equal(e.current().samples, 0);
  assert.equal(e.current().estimate, 777);
});

test("observe clampa ao maxEstimate para evitar runaway", () => {
  const e = new TokenEstimator({ initialEstimate: 100, alpha: 1, maxEstimate: 50_000 });
  e.observe(1_000_000);
  assert.equal(e.current().estimate, 50_000);
});

test("construtor rejeita alpha fora de (0, 1]", () => {
  assert.throws(() => new TokenEstimator({ alpha: 0 }));
  assert.throws(() => new TokenEstimator({ alpha: -0.5 }));
  assert.throws(() => new TokenEstimator({ alpha: 1.5 }));
});
