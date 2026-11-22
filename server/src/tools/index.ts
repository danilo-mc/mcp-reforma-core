import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppContext } from "../context.ts";
import type { Extension, RequestScope } from "../extensions/types.ts";
import { Metrics } from "../observability/telemetry.ts";
import { buscarClassificacaoTool } from "./buscar-classificacao.ts";
import { calcularRegimeRegularTool } from "./calcular-regime-regular.ts";
import { calcularSimplesTool } from "./calcular-simples.ts";
import { consultarAliquotasTool } from "./consultar-aliquotas.ts";
import { explicarStatusTool } from "./explicar-status.ts";
import { toolErrorResult } from "./shared/result.ts";
import type { ToolDefinition, ToolEntry } from "./types.ts";
import { reproduzirCalculoTool } from "./reproduzir-calculo.ts";
import { versaoTool } from "./versao.ts";

export type { ToolEntry } from "./types.ts";

/** Core tools (one file each; schemas follow the upstream contracts in docs/upstream/). */
export const TOOLS: ToolEntry[] = [
  versaoTool,
  consultarAliquotasTool,
  explicarStatusTool,
  calcularRegimeRegularTool,
  buscarClassificacaoTool,
  reproduzirCalculoTool,
  calcularSimplesTool,
];

export function resolveTools(ctx: AppContext, entries: ToolEntry[]): ToolDefinition[] {
  return entries.map((t) => (typeof t === "function" ? t(ctx) : t));
}

/** Core tools plus the tools contributed by the enabled extensions. */
export function allToolEntries(ctx: AppContext): ToolEntry[] {
  return [...TOOLS, ...ctx.extensions.flatMap((e) => e.tools?.(ctx) ?? [])];
}

/** `_meta` for a tool descriptor: its own `_meta` plus what extensions add (e.g. widget `toolMeta`). */
export function toolDescriptorMeta(
  tool: ToolDefinition,
  ctx: AppContext,
  extensions: readonly Extension[] = ctx.extensions,
): Record<string, unknown> | undefined {
  let meta: Record<string, unknown> | undefined;
  for (const ext of extensions) {
    const m = ext.toolMeta?.(tool, ctx);
    if (m) meta = { ...meta, ...m };
  }
  if (!tool._meta && !meta) return undefined;
  return { ...meta, ...tool._meta };
}

const LOCAL_SCOPE: RequestScope = { transport: "stdio" };

/**
 * Registers the tools visible to `scope` with the SDK server, wrapping handlers with the extensions'
 * `onToolCall` hooks, error mapping, logs and metrics.
 */
export function registerTools(
  server: McpServer,
  ctx: AppContext,
  entries: ToolEntry[] = allToolEntries(ctx),
  scope: RequestScope = LOCAL_SCOPE,
): void {
  const extensions = ctx.extensions;
  for (const tool of resolveTools(ctx, entries)) {
    if (!extensions.every((e) => e.canUseTool?.(tool, scope, ctx) ?? true)) continue;
    const meta = toolDescriptorMeta(tool, ctx);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations,
        ...(meta ? { _meta: meta } : {}),
      },
      async (args: unknown, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
        const started = performance.now();
        let result: CallToolResult | undefined;
        let resultMeta: Record<string, unknown> | undefined;
        let rejected = false;
        try {
          for (const ext of extensions) {
            const decision = await ext.onToolCall?.({ tool, scope }, ctx);
            if (decision?.meta) resultMeta = { ...resultMeta, ...decision.meta };
            if (decision?.result) {
              result = decision.result;
              rejected = true;
              break;
            }
          }
          result ??= await tool.handler(args as never, ctx, { signal: extra.signal });
        } catch (err) {
          ctx.logger.warn(
            { tool: tool.name, err: (err as Error).name, msg: (err as Error).message },
            "tool error",
          );
          result = toolErrorResult(err);
        }
        if (resultMeta) result = { ...result, _meta: { ...result._meta, ...resultMeta } };
        const latency = performance.now() - started;
        const outcome = result.isError ? "error" : "ok";
        Metrics.toolCall(tool.name, outcome, latency);
        ctx.logger.info(
          {
            tool: tool.name,
            outcome,
            ...(rejected ? { rejected } : {}),
            ...(scope.principal ? { principal: scope.principal.id } : {}),
            latencyMs: Math.round(latency),
          },
          "tool call",
        );
        return result;
      },
    );
  }
}
