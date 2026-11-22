import { metrics, trace, type Counter, type Histogram } from "@opentelemetry/api";
import type { Logger } from "pino";

/**
 * Initialises the Azure Monitor OpenTelemetry distro when a connection string is set.
 * Must run before other modules create HTTP servers/clients so auto-instrumentation applies.
 * Request/response bodies are never captured by the distro; we add no payload attributes.
 */
export async function initTelemetry(connectionString: string | undefined, logger: Logger): Promise<boolean> {
  if (!connectionString) return false;
  try {
    const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
    useAzureMonitor({
      azureMonitorExporterOptions: { connectionString },
      enableLiveMetrics: true,
    });
    logger.info({ telemetry: "azure-monitor" }, "telemetria habilitada");
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "falha ao iniciar telemetria; seguindo sem ela");
    return false;
  }
}

/**
 * Attribute with the MCP tool name, set on the HTTP request span (→ `AppRequests.Properties["mcp.tool"]`
 * in Application Insights) and on the per-tool metrics. Must match `toolDimensionName` in
 * infra/main.bicep (p95 alerts and workbook).
 */
export const TOOL_ATTRIBUTE = "mcp.tool";

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Tool names of the `tools/call` messages in a JSON-RPC body (single message or batch). Only names
 * shaped like tool identifiers are returned, so arbitrary client input never reaches telemetry.
 */
export function toolNamesFromJsonRpc(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const names = new Set<string>();
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const { method, params } = m as { method?: unknown; params?: unknown };
    if (method !== "tools/call" || !params || typeof params !== "object") continue;
    const name = (params as { name?: unknown }).name;
    if (typeof name === "string" && TOOL_NAME_RE.test(name)) names.add(name);
  }
  return [...names];
}

/** Tags the active (HTTP server) span with the tool(s) called in this request. No-op without telemetry. */
export function tagRequestSpan(body: unknown): void {
  const names = toolNamesFromJsonRpc(body);
  if (names.length === 0) return;
  trace.getActiveSpan()?.setAttribute(TOOL_ATTRIBUTE, names.sort().join(","));
}

interface Instruments {
  toolCalls: Counter;
  toolLatency: Histogram;
  engineStatus: Counter;
  rateUsage: Counter;
  engineLatency: Histogram;
}

let instruments: Instruments | undefined;

function get(): Instruments {
  if (!instruments) {
    const meter = metrics.getMeter("mcp-reforma");
    instruments = {
      toolCalls: meter.createCounter("mcp_tool_calls", { description: "Chamadas por ferramenta" }),
      toolLatency: meter.createHistogram("mcp_tool_latency_ms", { unit: "ms" }),
      engineStatus: meter.createCounter("mcp_engine_item_status", {
        description: "Distribuição de status por item devolvidos pelo motor",
      }),
      rateUsage: meter.createCounter("mcp_rate_usage", {
        description: "Uso de alíquotas por situação (oficial|provisoria)",
      }),
      engineLatency: meter.createHistogram("mcp_engine_latency_ms", { unit: "ms" }),
    };
  }
  return instruments;
}

/** Custom metrics. All are no-ops unless telemetry was initialised. */
export const Metrics = {
  toolCall(tool: string, outcome: "ok" | "error", latencyMs: number): void {
    get().toolCalls.add(1, { [TOOL_ATTRIBUTE]: tool, outcome });
    get().toolLatency.record(latencyMs, { [TOOL_ATTRIBUTE]: tool, outcome });
  },
  engineItemStatus(engine: string, status: string): void {
    get().engineStatus.add(1, { engine, status });
  },
  rateUsage(tributo: string, situacao: string): void {
    get().rateUsage.add(1, { tributo, situacao });
  },
  engineLatency(engine: string, route: string, status: number | "error", latencyMs: number): void {
    get().engineLatency.record(latencyMs, { engine, route, status: String(status) });
  },
};
