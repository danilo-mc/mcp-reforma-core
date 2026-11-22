import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export type MockHandler = (req: IncomingMessage, res: ServerResponse, body: string) => unknown;

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  setHandler(h: MockHandler): void;
  close(): Promise<void>;
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  let current = handler;
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      void Promise.resolve(current(req, res, body)).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler(h) {
      current = h;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** Fake values used only by tests. They are NOT real tax rates. */
export const FAKE_ENGINE_RATE = { aliquotaReferencia: 0.0123, aliquotaPropria: null, formaAplicacao: null };

export interface MockEngines {
  regularUrl: string;
  simplesUrl: string;
  regular: MockServer;
  simples: MockServer;
  close(): Promise<void>;
}

export async function startMockEngines(): Promise<MockEngines> {
  const regular = await startMockServer((req, res, body) => {
    const u = new URL(req.url ?? "/", "http://x");
    switch (u.pathname) {
      case "/api/calculadora/observabilidade/regime-geral": {
        // Deterministic fake: echoes item count and marks every other item NAO_IMPLEMENTADO.
        const input = JSON.parse(body || "{}") as { itens?: unknown[] };
        const itens = (input.itens ?? []).map((_, i) => ({
          numero: i + 1,
          status: i % 2 === 0 ? "CALCULADO" : "NAO_IMPLEMENTADO",
        }));
        return sendJson(res, 200, { itens, total: itens.length });
      }
      case "/api/calculadora/dados-abertos/versao":
        return sendJson(res, 200, { versaoApp: "1.6.1", versaoDb: "V0059", dataVersaoDb: "2026-11-01" });
      case "/api/calculadora/observabilidade/erros":
        if (u.searchParams.get("codigo") === "REG-011") {
          return sendJson(res, 200, {
            codigo: "REG-011",
            titulo: "Título de teste",
            descricao: "Descrição de teste",
          });
        }
        res.statusCode = 404;
        return res.end();
      case "/api/calculadora/dados-abertos/ufs":
        return sendJson(res, 200, [{ sigla: "SP", nome: "São Paulo", codigo: 35 }]);
      case "/api/calculadora/dados-abertos/aliquota-uniao":
      case "/api/calculadora/dados-abertos/aliquota-uf":
      case "/api/calculadora/dados-abertos/aliquota-municipio":
        return sendJson(res, 200, FAKE_ENGINE_RATE);
      default:
        res.statusCode = 404;
        return res.end();
    }
  });
  const simples = await startMockServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/api/versao") {
      return sendJson(res, 200, { versaoApp: "0.9.0", versaoDb: "V0010", dataVersaoDb: "2026-10-01" });
    }
    if (
      u.pathname === "/api/calculadora/observabilidade/simples-nacional/erros" &&
      u.searchParams.get("codigo") === "VSN-001"
    ) {
      return sendJson(res, 200, {
        codigo: "VSN-001",
        titulo: "Erro Simples de teste",
        descricao: "Descrição Simples",
      });
    }
    res.statusCode = 404;
    res.end();
  });
  return {
    regularUrl: `${regular.url}/api`,
    simplesUrl: `${simples.url}/api`,
    regular,
    simples,
    close: async () => {
      await Promise.all([regular.close(), simples.close()]);
    },
  };
}
