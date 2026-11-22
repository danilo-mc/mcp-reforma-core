import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { trace, type Span } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createContext, type ContextOverrides } from "../../src/context.ts";
import { createHttpApp } from "../../src/http/app.ts";
import { testConfig } from "../helpers/fixtures.ts";
import { startMockEngines, type MockEngines } from "../helpers/mock-http.ts";
import { TOOLS } from "../../src/tools/index.ts";

async function listen(
  env: Record<string, string>,
  overrides: ContextOverrides = {},
): Promise<{ url: string; server: Server }> {
  const ctx = createContext(testConfig(env), { proberTtlMs: 0, ...overrides });
  const app = createHttpApp(ctx);
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const close = (s: Server) =>
  new Promise<void>((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });

describe("HTTP transport", () => {
  let engines: MockEngines;
  let base: string;
  let server: Server;

  beforeAll(async () => {
    engines = await startMockEngines();
    ({ url: base, server } = await listen({
      ENGINE_REGULAR_URL: engines.regularUrl,
      ENGINE_SIMPLES_URL: engines.simplesUrl,
      RATE_LIMIT_PER_MIN: "1000",
    }));
  });
  afterAll(async () => {
    await close(server);
    await engines.close();
  });

  it("serves MCP over Streamable HTTP (SDK client)", async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(TOOLS.length);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const r = await client.callTool({ name: "explicar_status", arguments: { codigo: "CALCULADO" } });
    expect((r.structuredContent as { tipo: string }).tipo).toBe("status");
    await client.close();
  });

  it("handles concurrent calls (stateless per request)", async () => {
    const clients = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const c = new Client({ name: "c", version: "0" });
        await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        return c;
      }),
    );
    const results = await Promise.all(clients.map((c) => c.callTool({ name: "versao", arguments: {} })));
    expect(results.every((r) => !r.isError)).toBe(true);
    await Promise.all(clients.map((c) => c.close()));
  });

  it("GET/DELETE /mcp return 405 in stateless mode", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(405);
  });

  it("/health aggregates engines (200), /livez and /versao respond", async () => {
    const h = await fetch(`${base}/health`);
    expect(h.status).toBe(200);
    const body = (await h.json()) as { status: string; motores: { disponivel: boolean }[] };
    expect(body.status).toBe("ok");
    expect(body.motores.map((m: any) => m.nome)).toEqual(["regular", "simples"]);
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    const v = (await (await fetch(`${base}/versao`)).json()) as { servidor: { nome: string } };
    expect(v.servidor.nome).toBe("mcp-reforma");
  });

  it("rejects bodies over the limit and malformed JSON", async () => {
    const big = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: { x: "a".repeat(3 * 1024 * 1024) },
    });
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: big,
    });
    expect(r.status).toBe(413);
    const bad = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{oops",
    });
    expect(bad.status).toBe(400);
  });

  it("returns 404 for unknown routes (no /pdf without the DANFSe extension)", async () => {
    expect((await fetch(`${base}/pdf/abcdefghijklmnopqrstuvwx`)).status).toBe(404);
    expect((await fetch(`${base}/nada`)).status).toBe(404);
  });

  it("tags the HTTP request span with mcp.tool on tools/call", async () => {
    const setAttribute = vi.fn();
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue({ setAttribute } as unknown as Span);
    try {
      const client = new Client({ name: "otel", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      await client.listTools();
      expect(setAttribute).not.toHaveBeenCalled();
      await client.callTool({ name: "versao", arguments: {} });
      expect(setAttribute).toHaveBeenCalledWith("mcp.tool", "versao");
      await client.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("HTTP /health with engines down", () => {
  it("returns 503 while /livez stays 200", async () => {
    const { url, server } = await listen({
      ENGINE_REGULAR_URL: "http://127.0.0.1:1/api",
      ENGINE_SIMPLES_URL: "http://127.0.0.1:1/api",
    });
    expect((await fetch(`${url}/health`)).status).toBe(503);
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    expect((await fetch(`${url}/livez`)).status).toBe(200);
    await close(server);
  });
});

describe("HTTP rate limit", () => {
  it("returns 429 after RATE_LIMIT_PER_MIN requests on /mcp", async () => {
    const { url, server } = await listen({ RATE_LIMIT_PER_MIN: "3" });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${url}/mcp`)).status);
    expect(statuses).toEqual([405, 405, 405, 429, 429]);
    // other routes are not rate limited
    expect((await fetch(`${url}/livez`)).status).toBe(200);
    await close(server);
  });
});

describe("X-Azure-FDID guard", () => {
  it("rejects requests without the expected Front Door ID, except probes (/livez, /readyz, /health)", async () => {
    const fdid = "11111111-2222-3333-4444-555555555555";
    const { url, server } = await listen({
      FRONT_DOOR_ID: fdid,
      RATE_LIMIT_PER_MIN: "0",
      ENGINE_REGULAR_URL: "http://127.0.0.1:1/api",
      ENGINE_SIMPLES_URL: "http://127.0.0.1:1/api",
    });
    expect((await fetch(`${url}/versao`)).status).toBe(403);
    expect((await fetch(`${url}/nada`)).status).toBe(403);
    // Front Door health probe (X-FD-HealthProbe: 1, no X-Azure-FDID): reaches /health (503 = engines down here)
    const probe = await fetch(`${url}/health`, { headers: { "x-fd-healthprobe": "1" } });
    expect(probe.status).toBe(503);
    expect(Object.keys((await probe.json()) as object).sort()).toEqual(["motores", "servidor", "status"]);
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
    expect((await fetch(`${url}/mcp`, { headers: { "x-azure-fdid": "outro" } })).status).toBe(403);
    expect((await fetch(`${url}/mcp`, { headers: { "x-azure-fdid": fdid } })).status).toBe(405);
    expect((await fetch(`${url}/livez`)).status).toBe(200);

    const client = new Client({ name: "fd", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { "x-azure-fdid": fdid } },
      }),
    );
    expect((await client.listTools()).tools.length).toBe(TOOLS.length);
    await client.close();
    await close(server);
  });

  it("is disabled when FRONT_DOOR_ID is unset", async () => {
    const { url, server } = await listen({});
    expect((await fetch(`${url}/livez`)).status).toBe(200);
    expect((await fetch(`${url}/mcp`)).status).toBe(405);
    await close(server);
  });
});
