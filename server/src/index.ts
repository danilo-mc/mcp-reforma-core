#!/usr/bin/env node
import type { Server } from "node:http";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.ts";
import { createContext, startExtensions, stopExtensions, type AppContext } from "./context.ts";
import { createHttpApp } from "./http/app.ts";
import { createLogger, setLogger } from "./observability/logger.ts";
import { initTelemetry } from "./observability/telemetry.ts";
import { createMcpServer } from "./server.ts";

const SHUTDOWN_GRACE_MS = 10_000;

export async function startHttp(ctx: AppContext): Promise<Server> {
  const app = createHttpApp(ctx);
  const { config, logger } = ctx;
  return new Promise((resolve, reject) => {
    const server = app.listen(config.PORT, config.HOST, () => {
      logger.info(
        { transport: "http", host: config.HOST, port: config.PORT, versao: config.SERVER_VERSION },
        "servidor iniciado",
      );
      resolve(server);
    });
    server.on("error", reject);
    server.headersTimeout = 65_000;
    server.keepAliveTimeout = 61_000;
  });
}

export async function startStdio(ctx: AppContext): Promise<void> {
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  ctx.logger.info({ transport: "stdio", versao: ctx.config.SERVER_VERSION }, "servidor iniciado");
}

export async function main(config: Config = loadConfig()): Promise<void> {
  const logger = createLogger(config.LOG_LEVEL);
  setLogger(logger);
  await initTelemetry(config.APPLICATIONINSIGHTS_CONNECTION_STRING, logger);
  const ctx = createContext(config, { logger });
  await startExtensions(ctx);

  if (config.MCP_TRANSPORT === "stdio") {
    await startStdio(ctx);
    const stop = () => {
      void stopExtensions(ctx).finally(() => process.exit(0));
    };
    process.stdin.on("close", stop);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  const server = await startHttp(ctx);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "encerrando");
    server.close(() => {
      void stopExtensions(ctx).finally(() => {
        logger.flush();
        process.exit(0);
      });
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`Falha ao iniciar: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
