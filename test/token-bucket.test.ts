import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompositeRateLimiter,
  RequestRateLimiter,
  TokenRateLimiter,
  withSafetyMargin,
} from "../src/rate-limiter/token-bucket.js";

test("RequestRateLimiter libera imediatamente quando há saldo", async () => {
  const limiter = new RequestRateLimiter(60);
  const r = await limiter.acquire(1);
  assert.equal(r.ok, true);
  assert.equal(r.consumed, 1);
  assert.ok(r.waitedMs >= 0);
  const b = limiter.available();
  // O bucket regenera continuamente; aceita até 60 (capacidade) ou pouco
  // acima de 59 (consumiu 1 mas pode já ter regenerado fração).
  assert.ok(b.remaining <= 60.0 && b.remaining >= 58.0, `remaining=${b.remaining}`);
});

test("CompositeRateLimiter respeita TPM quando RPM é folgado", async () => {
  const limiter = new CompositeRateLimiter(60, 10_000);
  const r = await limiter.acquire(500);
  assert.equal(r.consumed, 500);
  assert.ok(r.waitedMs >= 0);
});

test("TokenRateLimiter esgota capacidade exatamente", async () => {
  const limiter = new TokenRateLimiter(60);
  for (let i = 0; i < 6; i++) {
    const r = await limiter.acquire(10);
    assert.equal(r.consumed, 10);
  }
  const b = limiter.available();
  assert.ok(b.remaining <= 1.0, `remaining=${b.remaining}`);
});

test("Acquire custo zero não desconta e retorna imediato", async () => {
  const limiter = new RequestRateLimiter(60);
  const r = await limiter.acquire(0);
  assert.equal(r.consumed, 0);
  assert.equal(r.waitedMs, 0);
});

test("Bucket rejeita capacity <= 0", () => {
  assert.throws(() => new RequestRateLimiter(0));
  assert.throws(() => new TokenRateLimiter(-1));
});

test("sync sobrescreve tokens e reajusta capacity", async () => {
  const limiter = new RequestRateLimiter(100);
  await limiter.acquire(50); // consome metade
  const antes = limiter.available();
  assert.ok(antes.remaining < 60, `esperado <60, veio ${antes.remaining}`);

  limiter.sync(30, 100);
  const depois = limiter.available();
  assert.equal(depois.capacity, 100);
  assert.ok(depois.remaining <= 30.001 && depois.remaining >= 29.9, `remaining=${depois.remaining}`);

  // Mudou a capacidade do bucket:
  const r = await limiter.acquire(25);
  assert.equal(r.ok, true);
});

test("sync rejeita valores inválidos silenciosamente", () => {
  const limiter = new RequestRateLimiter(100);
  const vazio = limiter.available();
  limiter.sync(-1, 100); // remaining negativo: noop
  limiter.sync(50, 0); // capacity 0: noop

  const depois = limiter.available();
  assert.equal(depois.capacity, 100);
  assert.ok(depois.remaining.toFixed(2) === vazio.remaining.toFixed(2));
});

test("CompositeRateLimiter.syncRpmTpm atualiza RPM e TPM separadamente", async () => {
  const limiter = new CompositeRateLimiter(500, 10_000);
  await limiter.acquire(100);
  // Provedor anuncia: restam 400 RPM (cap 500), 9500 TPM (cap 10000)
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

test("CompositeRateLimiter.sync genérico é noop (não afeta estado)", async () => {
  const limiter = new CompositeRateLimiter(500, 10_000);
  await limiter.acquire(100);
  const antes = limiter.available();
  limiter.sync(0, 0); // noop intencional pelo contrato
  const depois = limiter.available();
  assert.equal(antes.remaining.toFixed(3), depois.remaining.toFixed(3));
});

test("withSafetyMargin aplica fator 0.8 (default) sobre RPM/TPM", () => {
  const m = withSafetyMargin(500, 90_000);
  assert.equal(m.rpm, 400);
  assert.equal(m.tpm, 72_000);
});

test("withSafetyMargin customizado (0.7) e arredondamento", () => {
  const m = withSafetyMargin(700, 91_000, 0.7);
  // 700 * 0.7 = 489.999... com ponto flutuante; floor → 489. Aceitamos
  // tanto 489 quanto 490 — o importante é estar dentro de ±1 do esperado.
  assert.ok(m.rpm === 489 || m.rpm === 490, `rpm=${m.rpm}`);
  assert.ok(m.tpm === 63699 || m.tpm === 63700, `tpm=${m.tpm}`);
});

test("withSafetyMargin never abaixo de 1 e rejeita margin fora de (0,1]", () => {
  assert.throws(() => withSafetyMargin(500, 90_000, 0));
  assert.throws(() => withSafetyMargin(500, 90_000, 1.5));
  // Caso extremo: RPM=1 com 0.5 ainda assim deve dar 1 (não 0).
  const m = withSafetyMargin(1, 1, 0.5);
  assert.equal(m.rpm, 1);
  assert.equal(m.tpm, 1);
});

