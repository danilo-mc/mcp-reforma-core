import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AppContext } from "../context.ts";

export interface ToolExtra {
  /** Aborted when the MCP client cancels the request (pass it to engine calls). */
  signal: AbortSignal;
}

/**
 * One MCP tool = one file exporting a ToolDefinition (via `defineTool`).
 * Handlers return a CallToolResult built with `toolResult()` (tools/shared/result.ts) and may throw:
 * known errors are mapped to friendly Portuguese messages by `toolErrorResult()`.
 */
export interface ToolDefinition<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject | undefined = z.ZodObject | undefined,
> {
  name: string;
  title: string;
  /** pt-BR description shown to the model. */
  description: string;
  inputSchema: I;
  outputSchema?: O;
  annotations: ToolAnnotations;
  /**
   * Optional tool descriptor `_meta`. Extensions may add more at registration (Extension.toolMeta,
   * e.g. the MCP Apps `ui.resourceUri` of the receipt widget).
   */
  _meta?: Record<string, unknown>;
  /**
   * OAuth scope needed to see/call the tool when an access-control extension is active
   * (default there: `reforma:calc`). Ignored by the core.
   */
  requiredScope?: string;
  handler: (args: z.infer<I>, ctx: AppContext, extra: ToolExtra) => Promise<CallToolResult>;
}

/** A tool module exports either a static definition or a factory (when the schema depends on config). */
export type ToolEntry = ToolDefinition | ((ctx: AppContext) => ToolDefinition);

/** All tools are read-only and closed-world (they only talk to the official engines / rates). */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

export function defineTool<I extends z.ZodObject, O extends z.ZodObject | undefined = undefined>(
  def: Omit<ToolDefinition<I, O>, "annotations"> & { annotations?: Partial<ToolAnnotations> },
): ToolDefinition<I, O> {
  return { ...def, annotations: { ...READ_ONLY_ANNOTATIONS, title: def.title, ...def.annotations } };
}
