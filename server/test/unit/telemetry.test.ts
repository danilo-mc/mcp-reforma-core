import { trace, type Span } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tagRequestSpan, TOOL_ATTRIBUTE, toolNamesFromJsonRpc } from "../../src/observability/telemetry.ts";

const call = (name: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name } });

describe("mcp.tool request attribute", () => {
  afterEach(() => vi.restoreAllMocks());

  it("matches the dimension queried by the infra alerts", () => {
    expect(TOOL_ATTRIBUTE).toBe("mcp.tool");
  });

  it("extracts tool names from single and batch JSON-RPC bodies", () => {
    expect(toolNamesFromJsonRpc(call("calcular_regime_regular"))).toEqual(["calcular_regime_regular"]);
    expect(
      toolNamesFromJsonRpc([
        call("gerar_danfse"),
        { jsonrpc: "2.0", method: "notifications/x" },
        call("versao", 2),
      ]),
    ).toEqual(["gerar_danfse", "versao"]);
    expect(toolNamesFromJsonRpc([call("versao"), call("versao", 2)])).toEqual(["versao"]);
    expect(toolNamesFromJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual([]);
    expect(toolNamesFromJsonRpc(undefined)).toEqual([]);
    expect(toolNamesFromJsonRpc("x")).toEqual([]);
    expect(toolNamesFromJsonRpc([null, 1, { method: "tools/call" }])).toEqual([]);
    // never copies arbitrary client input into telemetry
    expect(toolNamesFromJsonRpc(call("<?xml version='1.0'?>"))).toEqual([]);
    expect(toolNamesFromJsonRpc(call("a".repeat(100)))).toEqual([]);
    expect(toolNamesFromJsonRpc(call(42))).toEqual([]);
  });

  it("sets the attribute on the active span only for tools/call", () => {
    const setAttribute = vi.fn();
    vi.spyOn(trace, "getActiveSpan").mockReturnValue({ setAttribute } as unknown as Span);
    tagRequestSpan({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(setAttribute).not.toHaveBeenCalled();
    tagRequestSpan([call("versao"), call("calcular_simples", 2)]);
    expect(setAttribute).toHaveBeenCalledWith("mcp.tool", "calcular_simples,versao");
  });

  it("is a no-op without an active span", () => {
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(undefined);
    expect(() => tagRequestSpan(call("versao"))).not.toThrow();
  });
});
