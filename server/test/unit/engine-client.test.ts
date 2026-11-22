import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  EngineAbortedError,
  EngineBadResponseError,
  EngineClient,
  EngineTimeoutError,
  EngineUnavailableError,
} from "../../src/engine-client/index.ts";
import { sendJson, startMockServer, type MockServer } from "../helpers/mock-http.ts";

let server: MockServer;
let calls = 0;

const client = (opts: Partial<ConstructorParameters<typeof EngineClient>[0]> = {}) =>
  new EngineClient({
    name: "regular",
    baseUrl: `${server.url}/api`,
    timeoutMs: 500,
    retries: 2,
    backoffMs: 5,
    ...opts,
  });

beforeEach(async () => {
  calls = 0;
  server ??= await startMockServer(() => undefined);
  server.requests.length = 0;
});
afterAll(async () => server?.close());

describe("EngineClient", () => {
  it("returns raw text, parsed body, status and latency; propagates traceparent", async () => {
    server.setHandler((_req, res) => sendJson(res, 200, { b: 1, a: [1, 2] }));
    const res = await client().getJson("/x", { data: "2027-01-01", empty: undefined });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ b: 1, a: [1, 2] });
    expect(res.rawText).toBe('{"b":1,"a":[1,2]}');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(server.requests[0]!.url).toBe("/api/x?data=2027-01-01");
    expect(server.requests[0]!.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("retries idempotent GETs on 503 then succeeds", async () => {
    server.setHandler((_req, res) => {
      calls++;
      if (calls < 3) return sendJson(res, 503, {});
      sendJson(res, 200, { ok: true });
    });
    const res = await client().getJson("/x");
    expect(res.body).toEqual({ ok: true });
    expect(res.attempts).toBe(3);
  });

  it("gives up after retries with EngineUnavailableError", async () => {
    server.setHandler((_req, res) => sendJson(res, 502, {}));
    await expect(client().getJson("/x")).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(server.requests).toHaveLength(3);
  });

  it("does not retry POSTs unless flagged; flagged POSTs retry once", async () => {
    server.setHandler((_req, res) => sendJson(res, 504, {}));
    await expect(client().postJson("/calc", { a: 1 })).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(server.requests).toHaveLength(1);
    server.requests.length = 0;
    await expect(client().postJson("/calc", { a: 1 }, { retryable: true })).rejects.toBeInstanceOf(
      EngineUnavailableError,
    );
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.body).toBe('{"a":1}');
    expect(server.requests[0]!.headers["content-type"]).toBe("application/json");
  });

  it("does not retry on 500 and throws EngineBadResponseError", async () => {
    server.setHandler((_req, res) => sendJson(res, 500, {}));
    await expect(client().getJson("/x")).rejects.toBeInstanceOf(EngineBadResponseError);
    expect(server.requests).toHaveLength(1);
  });

  it("returns 4xx responses (engines report validation errors in the body)", async () => {
    server.setHandler((_req, res) => sendJson(res, 422, { erro: "x" }));
    const res = await client().postJson("/calc", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ erro: "x" });
  });

  it("throws EngineBadResponseError on invalid JSON with 2xx", async () => {
    server.setHandler((_req, res) => {
      res.statusCode = 200;
      res.end("<html>");
    });
    await expect(client().getJson("/x")).rejects.toBeInstanceOf(EngineBadResponseError);
  });

  it("times out with EngineTimeoutError", async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => sendJson(res, 200, {}), 300);
    });
    await expect(client({ timeoutMs: 50 }).getJson("/slow")).rejects.toBeInstanceOf(EngineTimeoutError);
  });

  it("honours caller cancellation", async () => {
    server.setHandler((_req, res) => {
      setTimeout(() => sendJson(res, 200, {}), 300);
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(client().getJson("/slow", undefined, { signal: ac.signal })).rejects.toBeInstanceOf(
      EngineAbortedError,
    );
  });

  it("maps connection refused to EngineUnavailableError", async () => {
    const c = new EngineClient({
      name: "simples",
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 500,
      retries: 0,
    });
    await expect(c.getJson("/x")).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it("reads binary responses", async () => {
    server.setHandler((_req, res) => {
      res.setHeader("content-type", "application/pdf");
      res.end(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    });
    const res = await client().request({
      method: "POST",
      path: "/api/danfse",
      body: "<x/>",
      contentType: "application/xml",
      responseType: "binary",
    });
    expect(res.bytes).toEqual(Buffer.from("%PDF"));
    expect(server.requests[0]!.body).toBe("<x/>");
  });

  it("opens the circuit after consecutive failures and recovers after cooldown", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 1000, now: () => now });
    const c = client({ breaker, retries: 0 });
    server.setHandler((_req, res) => sendJson(res, 503, {}));
    await expect(c.getJson("/x")).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(c.getJson("/x")).rejects.toBeInstanceOf(EngineUnavailableError);
    expect(breaker.state).toBe("open");
    await expect(c.getJson("/x")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(server.requests).toHaveLength(2);

    now = 1500;
    expect(breaker.state).toBe("half-open");
    server.setHandler((_req, res) => sendJson(res, 200, { ok: 1 }));
    await expect(c.getJson("/x")).resolves.toMatchObject({ status: 200 });
    expect(breaker.state).toBe("closed");
  });

  it("re-opens the circuit when the half-open trial fails", () => {
    let now = 0;
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 10, now: () => now });
    b.onFailure();
    expect(b.allow()).toBe(false);
    now = 20;
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
    b.onFailure();
    expect(b.state).toBe("open");
  });
});
