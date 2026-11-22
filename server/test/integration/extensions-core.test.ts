import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { createContext, startExtensions, stopExtensions } from "../../src/context.ts";
import type { Extension, Principal, RequestScope } from "../../src/extensions/types.ts";
import { createHttpApp } from "../../src/http/app.ts";
import { createMcpServer } from "../../src/server.ts";
import { testConfig } from "../helpers/fixtures.ts";

/** Fake extensions exercising every hook of the core extension API (no real extension needed). */
function fakeExtensions(log: string[]) {
  const principal: Principal = { id: "key:teste", kind: "apikey", scopes: new Set(["x"]), tier: "free" };
  const scopes: RequestScope[] = [];
  const gate: Extension = {
    name: "gate",
    init: () => log.push("init:gate"),
    start: () => {
      log.push("start:gate");
      return Promise.resolve();
    },
    stop: () => {
      log.push("stop:gate");
    },
    httpRoutes: (app) => {
      app.get("/extra", (_req, res) => {
        res.json({ ok: true });
      });
    },
    mcpMiddleware: () => [
      (req, res, next) => {
        if (req.header("x-teste") !== "sim") {
          res.status(401).json({ erro: "sem credencial" });
          return;
        }
        res.locals.principal = principal;
        next();
      },
    ],
    canUseTool: (tool, scope) => {
      scopes.push(scope);
      return scope.transport === "stdio" || tool.name !== "consultar_aliquotas";
    },
    onToolCall: ({ tool, scope }) => {
      if (tool.name === "explicar_status" && scope.principal) {
        return Promise.resolve({
          result: { isError: true, content: [{ type: "text", text: "bloqueado" }] },
          meta: { "teste/gate": "negado" },
        });
      }
      return Promise.resolve({ meta: { "teste/gate": scope.principal?.id ?? "local" } });
    },
  };
  const disabled: Extension = { name: "off", enabled: () => false, init: () => log.push("init:off") };
  const resources: Extension = {
    name: "resources",
    tools: () => [],
    toolMeta: (tool) => (tool.name === "versao" ? { "teste/ui": true } : undefined),
    registerResources: (server) => {
      server.registerResource("teste", "ui://teste", { mimeType: "text/plain" }, () => ({
        contents: [{ uri: "ui://teste", text: "oi" }],
      }));
    },
  };
  return { list: [gate, disabled, resources], scopes };
}

describe("core extension API", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it("runs lifecycle hooks of enabled extensions only, in order", async () => {
    const log: string[] = [];
    const ctx = createContext(testConfig(), { extensions: fakeExtensions(log).list });
    expect(ctx.extensions.map((e) => e.name)).toEqual(["gate", "resources"]);
    await startExtensions(ctx);
    await stopExtensions(ctx);
    expect(log).toEqual(["init:gate", "start:gate", "stop:gate"]);
  });

  it("stdio: local scope, tools visible, hooks add _meta and resources", async () => {
    const { list } = fakeExtensions([]);
    const ctx = createContext(testConfig(), { extensions: list });
    const server = createMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("consultar_aliquotas");
    expect(tools.find((t) => t.name === "versao")!._meta).toEqual({ "teste/ui": true });
    const r = await client.callTool({ name: "explicar_status", arguments: { codigo: "CALCULADO" } });
    expect(r.isError).toBeFalsy();
    expect(r._meta).toEqual({ "teste/gate": "local" });
    expect((await client.listResources()).resources.map((x) => x.uri)).toEqual(["ui://teste"]);
    await client.close();
  });

  it("HTTP: middleware guards /mcp, sets the principal, filters tools and short-circuits calls", async () => {
    const { list, scopes } = fakeExtensions([]);
    const ctx = createContext(testConfig({ RATE_LIMIT_PER_MIN: "0" }), { extensions: list });
    const app = createHttpApp(ctx);
    const server = await new Promise<Server>((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect(await (await fetch(`${url}/extra`)).json()).toEqual({ ok: true });
    expect((await fetch(`${url}/livez`)).status).toBe(200);
    expect((await fetch(`${url}/mcp`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}/mcp`)).status).toBe(401);

    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { "x-teste": "sim" } },
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("consultar_aliquotas");
    expect(names).toContain("versao");
    expect(scopes.at(-1)).toMatchObject({ transport: "http", principal: { id: "key:teste" } });

    const blocked = await client.callTool({ name: "explicar_status", arguments: { codigo: "CALCULADO" } });
    expect(blocked).toMatchObject({ isError: true, _meta: { "teste/gate": "negado" } });
    const hidden = await client.callTool({ name: "consultar_aliquotas", arguments: { data: "2026-01-01" } });
    expect(hidden.isError).toBe(true);
    const ok = await client.callTool({ name: "versao", arguments: {} });
    expect(ok._meta).toEqual({ "teste/gate": "key:teste" });
    await client.close();
  });

  it("works with no extensions at all (open-source core build)", async () => {
    const ctx = createContext(testConfig(), { extensions: [] });
    const server = createMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools).toHaveLength(7);
    await client.close();
  });
});
