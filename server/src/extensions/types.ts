import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Express, RequestHandler } from "express";
import type { Config } from "../config.ts";
import type { AppContext, ContextOverrides } from "../context.ts";
import type { ToolDefinition, ToolEntry } from "../tools/types.ts";

/**
 * Extension points of the server. The core (calculation tools, receipts, HTTP/stdio transports)
 * never depends on an extension: every non-core feature (DANFSe, receipt widget, authentication,
 * quotas…) lives in its own folder under `src/extensions/<name>/` and is enabled by listing it in
 * `src/extensions/index.ts`. Deleting the folder and its entry (or replacing index.ts with
 * `export const extensions = [];`) leaves a working core.
 *
 * Lifecycle: `enabled` → `init` (sync, inside createContext) → `start` (async, before serving)
 * → `stop` (shutdown). Hooks run in list order.
 */

/** Authenticated caller of an HTTP request (set by an auth extension). Never contains raw PII. */
export interface Principal {
  /** Stable, non-reversible identifier (e.g. `key:<uuid>`, `oidc:<hash>`). Safe to log. */
  id: string;
  kind: "apikey" | "oidc";
  scopes: ReadonlySet<string>;
  /** Quota tier (e.g. free, beta, admin). */
  tier: string;
}

/** Who/where a single MCP request comes from. */
export interface RequestScope {
  /** `stdio` = local user (also in-memory tests); `http` = remote request. */
  transport: "stdio" | "http";
  /** Present only when an auth extension authenticated the HTTP request. */
  principal?: Principal | undefined;
}

export interface ToolCallInfo {
  tool: ToolDefinition;
  scope: RequestScope;
}

/** Outcome of an `onToolCall` hook. */
export interface ToolCallDecision {
  /** When set, the tool is NOT executed and this result is returned instead (e.g. quota exceeded). */
  result?: CallToolResult;
  /** Merged into the result `_meta` (e.g. remaining quota). */
  meta?: Record<string, unknown>;
}

export interface Extension {
  readonly name: string;
  /** Feature flag; defaults to enabled. Parse settings from `config.env`. */
  enabled?(config: Config): boolean;
  /** Synchronous setup inside createContext (parse config, create clients, register engine probes). */
  init?(ctx: AppContext, overrides: ContextOverrides): void;
  /** Async startup before serving (migrations, warm-up). Must not throw for degradable features. */
  start?(ctx: AppContext): Promise<void>;
  stop?(ctx: AppContext): Promise<void> | void;

  /** Additional MCP tools. */
  tools?(ctx: AppContext): ToolEntry[];
  /** Extra tool descriptor `_meta` (e.g. MCP Apps `ui.resourceUri`). */
  toolMeta?(tool: ToolDefinition, ctx: AppContext): Record<string, unknown> | undefined;
  /** Tool visibility per request: tools for which any extension returns false are not registered. */
  canUseTool?(tool: ToolDefinition, scope: RequestScope, ctx: AppContext): boolean;
  /** Runs before each tools/call (after input validation). May short-circuit or add `_meta`. */
  onToolCall?(call: ToolCallInfo, ctx: AppContext): Promise<ToolCallDecision | undefined>;
  /** MCP resources (e.g. UI templates). */
  registerResources?(server: McpServer, ctx: AppContext, scope: RequestScope): void;

  /** Extra public HTTP routes (registered before /mcp and the 404 handler). */
  httpRoutes?(app: Express, ctx: AppContext): void;
  /**
   * Middlewares for every /mcp request, after the per-IP limiter and before body parsing (e.g.
   * authentication). An auth middleware stores the caller in `res.locals.principal`.
   */
  mcpMiddleware?(ctx: AppContext): RequestHandler[];
}
