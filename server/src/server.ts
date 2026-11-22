import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.ts";
import type { RequestScope } from "./extensions/types.ts";
import { registerTools, type ToolEntry } from "./tools/index.ts";

export const SERVER_INSTRUCTIONS =
  "Servidor MCP independente (não oficial) que dá acesso à calculadora oficial da Reforma Tributária do Consumo " +
  "(CBS, IBS e Imposto Seletivo) publicada em código aberto pela Receita Federal. Nunca calcule impostos de cabeça: " +
  "use as ferramentas. Mostre ao usuário o resumo_humano, as fontes das alíquotas e avise quando alguma for provisória.";

export interface McpServerOptions {
  /** Restrict the server to these tools (tests). Default: core tools + enabled extensions' tools. */
  tools?: ToolEntry[] | undefined;
  /** Caller of this request (tool visibility, quotas). Default: local (stdio). */
  scope?: RequestScope | undefined;
}

/** Creates a fully configured McpServer. Cheap enough to create one per HTTP request (stateless mode). */
export function createMcpServer(ctx: AppContext, opts: McpServerOptions = {}): McpServer {
  const scope: RequestScope = opts.scope ?? { transport: "stdio" };
  const server = new McpServer(
    { name: "mcp-reforma", title: "MCP da Reforma Tributária", version: ctx.config.SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, ctx, opts.tools, scope);
  for (const ext of ctx.extensions) ext.registerResources?.(server, ctx, scope);
  return server;
}
