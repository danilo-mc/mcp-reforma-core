import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppContext } from "../context.ts";
import type { Principal, RequestScope } from "../extensions/types.ts";
import { MESSAGES } from "../i18n/pt-BR.ts";
import { createMcpServer } from "../server.ts";
import { tagRequestSpan } from "../observability/telemetry.ts";
import type { ToolEntry } from "../tools/index.ts";
import { collectVersionInfo } from "../version-info.ts";

export interface HttpAppOptions {
  tools?: ToolEntry[];
}

/**
 * Paths reachable without the Front Door header: internal container probes and `/health`, used by the
 * Front Door origin health probe (identified by `X-FD-HealthProbe: 1`; Microsoft docs do not guarantee
 * `X-Azure-FDID` on probes). `/health` exposes only status and versions, no payloads.
 */
const FDID_EXEMPT = new Set(["/livez", "/readyz", "/health"]);

function jsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
  res.status(httpStatus).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Rejects requests that did not come through our Azure Front Door profile (SPEC §13.3). */
export function frontDoorGuard(frontDoorId: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!frontDoorId || FDID_EXEMPT.has(req.path)) return next();
    const header = req.header("x-azure-fdid");
    if (header && header.split(",").some((v) => safeEqual(v.trim(), frontDoorId))) return next();
    res.status(403).json({ erro: { codigo: "ACESSO_NEGADO", mensagem: MESSAGES.acessoNegado } });
  };
}

export function createHttpApp(ctx: AppContext, opts: HttpAppOptions = {}): express.Express {
  const { config, logger } = ctx;
  const app = express();
  app.disable("x-powered-by");
  const trust = config.TRUST_PROXY;
  app.set(
    "trust proxy",
    /^\d+$/.test(trust) ? Number(trust) : trust === "true" ? true : trust === "false" ? false : trust,
  );

  if (config.ALLOWED_HOSTS) {
    app.use(
      hostHeaderValidation(
        config.ALLOWED_HOSTS.split(",")
          .map((h) => h.trim())
          .filter(Boolean),
      ),
    );
  }
  app.use(frontDoorGuard(config.FRONT_DOOR_ID));

  app.get("/livez", (_req, res) => {
    res.json({ status: "ok" });
  });

  const engineHealth = async (_req: Request, res: Response) => {
    const motores = await ctx.prober.probeAll();
    const ok = motores.every((m) => m.disponivel);
    res
      .status(ok ? 200 : 503)
      .set("cache-control", "no-store")
      .json({
        status: ok ? "ok" : "degradado",
        servidor: { status: "ok", versao: config.SERVER_VERSION },
        motores: motores.map((m) => ({
          nome: m.nome,
          disponivel: m.disponivel,
          versao: m.versao,
          latencia_ms: m.latencia_ms,
          erro: m.erro,
        })),
      });
  };
  app.get("/readyz", engineHealth);
  app.get("/health", engineHealth);

  app.get("/versao", async (_req, res) => {
    res.set("cache-control", "no-store").json(await collectVersionInfo(ctx));
  });

  for (const ext of ctx.extensions) ext.httpRoutes?.(app, ctx);

  const mcpLimiter =
    config.RATE_LIMIT_PER_MIN > 0
      ? rateLimit({
          windowMs: 60_000,
          limit: config.RATE_LIMIT_PER_MIN,
          standardHeaders: "draft-8",
          legacyHeaders: false,
          handler: (_req, res) => jsonRpcError(res, 429, -32000, MESSAGES.rateLimit),
        })
      : (_req: Request, _res: Response, next: NextFunction) => next();

  const mcpGuards = ctx.extensions.flatMap((e) => e.mcpMiddleware?.(ctx) ?? []);

  app.post(
    "/mcp",
    mcpLimiter,
    ...mcpGuards,
    express.json({ limit: config.MAX_BODY_BYTES }),
    async (req, res) => {
      tagRequestSpan(req.body);
      const scope: RequestScope = {
        transport: "http",
        principal: res.locals.principal as Principal | undefined,
      };
      const server = createMcpServer(ctx, { tools: opts.tools, scope });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error({ err: (err as Error).message }, "mcp request failed");
        if (!res.headersSent) jsonRpcError(res, 500, -32603, MESSAGES.erroGenerico);
      }
    },
  );

  // Stateless server: no standalone SSE stream and no sessions to delete.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.set("allow", "POST");
    jsonRpcError(res, 405, -32000, "Método não permitido: este servidor opera sem sessão (use POST).");
  };
  app.get("/mcp", mcpLimiter, ...mcpGuards, methodNotAllowed);
  app.delete("/mcp", mcpLimiter, ...mcpGuards, methodNotAllowed);

  app.use((_req, res) => {
    res.status(404).json({ erro: { codigo: "NAO_ENCONTRADO", mensagem: "Rota não encontrada." } });
  });

  app.use(
    (err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
      if (err.type === "entity.too.large" || err.status === 413) {
        jsonRpcError(res, 413, -32600, "Requisição maior que o limite permitido.");
        return;
      }
      if (err.type === "entity.parse.failed" || err.status === 400) {
        jsonRpcError(res, 400, -32700, "JSON inválido.");
        return;
      }
      logger.error({ err: err.message }, "unhandled http error");
      jsonRpcError(res, 500, -32603, MESSAGES.erroGenerico);
    },
  );

  return app;
}
