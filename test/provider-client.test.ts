import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultProviderClient } from "../src/provider/provider-client.js";

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("client classifies 429 as retryable and reads Retry-After", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    if (calls === 1) return makeResponse(429, { error: "rl" }, { "retry-after": "0" });
    return makeResponse(200, { ok: true });
  };
  const client = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const r1 = await client.call({ path: "/p" });
  assert.equal(r1.kind, "retry");
  if (r1.kind === "retry") {
    assert.equal(r1.status, 429);
    assert.equal(r1.retryable, true);
    assert.equal(r1.retryAfterMs, 0);
  }
  const r2 = await client.call({ path: "/p" });
  assert.equal(r2.kind, "success");
});

test("client classifies 400 as non-retryable", async () => {
  const fetchFn: typeof fetch = async () => makeResponse(400, { error: "bad" });
  const client = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const r = await client.call({ path: "/p" });
  assert.equal(r.kind, "retry");
  if (r.kind === "retry") assert.equal(r.retryable, false);
});

test("client classifies 500 as retryable", async () => {
  const fetchFn: typeof fetch = async () => makeResponse(503, { error: "boom" });
  const client = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const r = await client.call({ path: "/p" });
  if (r.kind === "retry") assert.equal(r.retryable, true);
});

test("client treats network error as retryable", async () => {
  const fetchFn: typeof fetch = async () => {
    throw new Error("ECONNRESET");
  };
  const client = new DefaultProviderClient({ baseUrl: "https://x", apiKey: "k", fetchFn });
  const r = await client.call({ path: "/p" });
  if (r.kind === "retry") assert.equal(r.retryable, true);
});
