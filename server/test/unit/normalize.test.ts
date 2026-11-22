import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../../src/receipt/jcs.ts";
import {
  NORMALIZACAO_ID,
  normalizeEngineOutput,
  normalizedOutputSha256,
  stripUrlHost,
} from "../../src/receipt/normalize.ts";
import { buildReceipt, rawOutputSha256, verifyReceipt } from "../../src/receipt/receipt.ts";
import {
  decimalString,
  fractionToPercentPoints,
  percentPointsToFraction,
  shift,
} from "../../src/tools/shared/decimal.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../golden/fixtures/regular/${name}.engine-output.json`, import.meta.url), "utf8");

const motor = {
  repositorio: "ReceitaFederal/calculadora-rtc-regime-regular",
  commit: null,
  versao: null,
  versao_base: null,
};

describe("engine output normalization (mcp-reforma/normalizacao@1)", () => {
  it("strips scheme and host from absolute URLs only", () => {
    expect(stripUrlHost("http://engine-regular/api/x/erros?codigo=REG-005")).toBe(
      "/api/x/erros?codigo=REG-005",
    );
    expect(stripUrlHost("https://127.0.0.1:18080/api/y")).toBe("/api/y");
    expect(stripUrlHost("http://host")).toBe("/");
    expect(stripUrlHost("about:blank")).toBe("about:blank");
  });

  it("removes the 422 timestamp and host from type URLs", () => {
    const raw = JSON.parse(fixture("observabilidade_erro_global_422")) as Record<string, unknown>;
    const n = normalizeEngineOutput(raw) as Record<string, any>;
    expect(n.timestamp).toBeUndefined();
    expect(n.type).toBe("about:blank");
    expect(n.errors[0].type).toBe("/api/calculadora/observabilidade/erros?codigo=REG-018");
    expect(raw.timestamp).toBeDefined(); // input not mutated
    const other = { ...raw, timestamp: "2030-01-01T00:00:00Z" };
    expect(normalizedOutputSha256(JSON.stringify(other))).toBe(
      normalizedOutputSha256(fixture("observabilidade_erro_global_422")),
    );
  });

  it("keeps timestamp in objects that are not problem details", () => {
    expect(normalizeEngineOutput({ timestamp: "x", valor: "1.00" })).toEqual({
      timestamp: "x",
      valor: "1.00",
    });
  });

  it("sorts erros/errors deterministically and is host independent", () => {
    const text = fixture("observabilidade_entrada_varios_estados");
    const body = JSON.parse(text) as { objetos: { erros?: unknown[] }[] };
    const shuffled = structuredClone(body);
    shuffled.objetos[0]!.erros!.reverse();
    const otherHost = JSON.stringify(shuffled).replaceAll("http://engine-regular/", "http://127.0.0.1/");
    expect(normalizedOutputSha256(otherHost)).toBe(normalizedOutputSha256(text));
    expect(rawOutputSha256(otherHost)).not.toBe(rawOutputSha256(text));
    const n = normalizeEngineOutput(body) as { objetos: { erros?: { code: string; pointer: string }[] }[] };
    const keys = n.objetos[0]!.erros!.map((e) => `${e.code}|${e.pointer}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("does not touch values or other arrays", () => {
    const text = fixture("teste_000001_2_2027_is_aliquotas_injetadas");
    expect(normalizeEngineOutput(JSON.parse(text))).toEqual(JSON.parse(text));
    expect(normalizedOutputSha256(text)).toBe(sha256Hex(canonicalize(JSON.parse(text))));
  });

  it("hashes non-JSON outputs as raw bytes", () => {
    expect(normalizedOutputSha256("not json")).toBe(sha256Hex("not json"));
    const pdf = new Uint8Array([37, 80, 68, 70]);
    expect(normalizedOutputSha256(pdf)).toBe(sha256Hex(pdf));
  });

  it("receipts record the normalization, the route, and verify against reordered outputs", () => {
    const text = fixture("observabilidade_entrada_varios_estados");
    const recibo = buildReceipt({
      engine: motor,
      rota: "/calculadora/observabilidade/regime-geral",
      payloadSentToEngine: { a: 1 },
      rawEngineResponse: text,
    });
    expect(recibo.normalizacao).toBe(NORMALIZACAO_ID);
    expect(recibo.motor.rota).toBe("/calculadora/observabilidade/regime-geral");
    const reordered = JSON.parse(text) as { objetos: { erros?: unknown[] }[] };
    reordered.objetos[0]!.erros!.reverse();
    expect(verifyReceipt(recibo, { rawEngineResponse: JSON.stringify(reordered) }).valido).toBe(true);
    // legacy receipts (without normalizacao) keep the raw hash
    const legacy: Record<string, unknown> = { ...recibo, output_sha256: rawOutputSha256(text) };
    delete legacy.normalizacao;
    expect(verifyReceipt(legacy, { rawEngineResponse: text }).valido).toBe(true);
    expect(verifyReceipt(legacy, { rawEngineResponse: JSON.stringify(reordered) }).valido).toBe(false);
  });
});

describe("exact decimal conversion", () => {
  it("converts fractions to percentage points without float artifacts", () => {
    expect(fractionToPercentPoints(0.088)).toBe(8.8);
    expect(fractionToPercentPoints(0.0885)).toBe(8.85);
    expect(fractionToPercentPoints(0.009)).toBe(0.9);
    expect(fractionToPercentPoints("0.0005")).toBe(0.05);
    expect(fractionToPercentPoints(0.07)).toBe(7);
    expect(fractionToPercentPoints(1e-7)).toBe(0.00001);
    expect(fractionToPercentPoints("0,113")).toBe(11.3);
    expect(0.07 * 100).not.toBe(7); // the reason for string arithmetic
  });

  it("converts percentage points back to fractions", () => {
    expect(percentPointsToFraction("8.40")).toBe(0.084);
    expect(percentPointsToFraction("0.90")).toBe(0.009);
    expect(percentPointsToFraction("0.00")).toBe(0);
  });

  it("shifts and validates decimals", () => {
    expect(shift("123.45", 3)).toBe("123450");
    expect(shift("123.45", -4)).toBe("0.012345");
    expect(decimalString(1.5e-10)).toBe("0.00000000015");
    expect(() => decimalString(-1)).toThrow();
    expect(() => decimalString("1e3")).toThrow();
  });
});
