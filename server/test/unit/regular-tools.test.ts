import { describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { KNOWN_ISSUES, knownIssuesFor } from "../../src/receipt/known-issues.ts";
import { KnownIssueSchema } from "../../src/receipt/receipt.ts";
import {
  aliquotasReferenciaMotor,
  buildRegularPayload,
  dhFatoGerador,
  planRates,
  totaisRegular,
  valoresItem,
  type CalcularRegimeRegularArgs,
} from "../../src/tools/calcular-regime-regular.ts";
import {
  dicaErroMotor,
  engineGlobalErrorResult,
  mapErrosMotor,
} from "../../src/tools/shared/engine-errors.ts";
import { buildResumoHumano, formatValorDecimal } from "../../src/tools/shared/resumo.ts";
import { normalizeText, scoreDocument, stem, tokenize } from "../../src/tools/shared/texto.ts";
import { toolDescriptorMeta } from "../../src/tools/index.ts";
import type { Extension } from "../../src/extensions/types.ts";
import { AliquotasNaoValidadasError } from "../../src/rates/loader.ts";
import { ToolUserError } from "../../src/tools/shared/result.ts";
import { FAKE_VALID_RATES, removeDir, scratchDir, testConfig, writeRates } from "../helpers/fixtures.ts";

const base: CalcularRegimeRegularArgs = {
  data_fato_gerador: "2026-06-01",
  uf: "RS",
  municipio_ibge: "4314902",
  itens: [{ ncm: "24021000", cst: "000", cclasstrib: "000001", valor: "200.00" }],
  cenario_aliquotas: "vigente",
};

describe("calcular_regime_regular helpers", () => {
  const ctx = createContext(testConfig(), { now: () => new Date("2026-11-21T12:00:00Z") });

  it("builds dhFatoGerador with Brasília offset", () => {
    expect(dhFatoGerador("2027-03-15")).toBe("2027-03-15T00:00:00-03:00");
    expect(dhFatoGerador("2027-03-15", "10:30")).toBe("2027-03-15T10:30:00-03:00");
    expect(dhFatoGerador("2027-03-15", "10:30:05")).toBe("2027-03-15T10:30:05-03:00");
  });

  it("2026: no injection; explicit scenario rejected", () => {
    const plan = planRates(ctx, base);
    expect(plan).toMatchObject({ modo: "referencia_motor", aliquotasUsadas: [] });
    const payload = buildRegularPayload(base, plan.porItem);
    expect(payload).toEqual({
      id: "mcp-reforma",
      versao: "0.0.1",
      dhFatoGerador: "2026-06-01T00:00:00-03:00",
      municipio: 4314902,
      uf: "RS",
      itens: [{ numero: 1, ncm: "24021000", cst: "000", cClassTrib: "000001", baseCalculo: 200 }],
    });
    expect(() =>
      planRates(ctx, { ...base, cenario_aliquotas: { cbs: "0.01", ibs_uf: "0.01", ibs_mun: "0.01" } }),
    ).toThrow(ToolUserError);
  });

  it("2027 'vigente' with the real (placeholder) rates file → AliquotasNaoValidadasError", () => {
    expect(() => planRates(ctx, { ...base, data_fato_gerador: "2027-01-01" })).toThrow(
      AliquotasNaoValidadasError,
    );
  });

  it("2027 'vigente' with validated rates injects percentage points; IS needs produto", () => {
    const dir = writeRates(scratchDir("rates-unit"), { "2027.yaml": FAKE_VALID_RATES });
    try {
      const c2 = createContext(testConfig({ RATES_DIR: dir }));
      const args = { ...base, data_fato_gerador: "2027-02-01", uf: "SP", municipio_ibge: "3550308" };
      const plan = planRates(c2, args);
      expect(plan.porItem).toEqual([{ cbs: 1.01, ibsEstadual: 2.03, ibsMunicipal: 3.03 }]);
      expect(plan.aliquotasUsadas.map((a) => a.situacao)).toEqual(["provisoria", "oficial", "oficial"]);
      const withIs = {
        ...args,
        itens: [{ ...args.itens[0]!, imposto_seletivo: { cst: "000", cclasstrib: "000001", valor: "10" } }],
      };
      expect(() => planRates(c2, withIs)).toThrow(/produto/);
      const withProduto = {
        ...withIs,
        itens: [
          {
            ...withIs.itens[0]!,
            imposto_seletivo: { ...withIs.itens[0]!.imposto_seletivo, produto: "bebidas_acucaradas" },
          },
        ],
      };
      expect(() => planRates(c2, withProduto)).toThrow(AliquotasNaoValidadasError); // IS entry is a placeholder
    } finally {
      removeDir(dir);
    }
  });

  it("explicit scenario: exact conversion, IS only on IS items, provenance 'usuario'", () => {
    const args: CalcularRegimeRegularArgs = {
      ...base,
      data_fato_gerador: "2027-01-01",
      itens: [
        {
          ncm: "24021000",
          cst: "000",
          cclasstrib: "000001",
          valor: "200",
          imposto_seletivo: {
            cst: "000",
            cclasstrib: "000001",
            valor: "200",
            quantidade: "1",
            unidade: "VN",
          },
        },
        { nbs: "101011100", cst: "000", cclasstrib: "000001", valor: "0.07" },
      ],
      cenario_aliquotas: {
        cbs: "0.07",
        ibs_uf: "0.0885",
        ibs_mun: "0.0005",
        is: { ad_valorem: "0.13", ad_rem: "21.3" },
      },
    };
    const plan = planRates(ctx, args);
    expect(plan.porItem).toEqual([
      { cbs: 7, ibsEstadual: 8.85, ibsMunicipal: 0.05, impostoSeletivo: { adValorem: 13, adRem: 21.3 } },
      { cbs: 7, ibsEstadual: 8.85, ibsMunicipal: 0.05 },
    ]);
    expect(
      plan.aliquotasUsadas.map((a) => [a.tributo, a.valor, a.componente ?? null, a.fonte, a.data_fonte]),
    ).toEqual([
      ["CBS", 0.07, null, "usuario", "2026-11-21"],
      ["IBS_UF", 0.0885, null, "usuario", "2026-11-21"],
      ["IBS_MUN", 0.0005, null, "usuario", "2026-11-21"],
      ["IS", 0.13, "ad_valorem", "usuario", "2026-11-21"],
      ["IS", 21.3, "ad_rem", "usuario", "2026-11-21"],
    ]);
    const p = buildRegularPayload(args, plan.porItem) as { itens: Record<string, unknown>[] };
    expect(p.itens[0]!.impostoSeletivo).toEqual({
      cst: "000",
      cClassTrib: "000001",
      baseCalculo: 200,
      quantidade: 1,
      unidade: "VN",
    });
    expect(p.itens[1]).not.toHaveProperty("impostoSeletivo");
    const noIs = { ...args, cenario_aliquotas: { cbs: "0.07", ibs_uf: "0.0885", ibs_mun: "0.0005" } };
    expect(() => planRates(ctx, noIs)).toThrow(/imposto seletivo|Imposto Seletivo/i);
  });

  it("reads values and totals verbatim from the engine body", () => {
    const body = {
      objetos: [
        {
          nObj: 1,
          estadoItem: "CALCULADO",
          tribCalc: {
            IBSCBS: {
              gIBSCBS: {
                vBC: "200.00",
                gIBSUF: { pIBSUF: "0.10", vIBSUF: "0.20" },
                gIBSMun: { pIBSMun: "0.00", vIBSMun: "0.00" },
                vIBS: "0.20",
                gCBS: { pCBS: "0.90", vCBS: "1.80" },
              },
            },
          },
        },
        { nObj: 2, estadoItem: "NAO_IMPLEMENTADO", erros: [] },
      ],
      total: {
        tribCalc: { IBSCBSTot: { vBCIBSCBS: "200.00", gIBS: { vIBS: "0.20" }, gCBS: { vCBS: "1.80" } } },
      },
    };
    expect(valoresItem(body.objetos[0]!)).toEqual({
      base_calculo: "200.00",
      cbs: "1.80",
      ibs_uf: "0.20",
      ibs_mun: "0.00",
      ibs: "0.20",
      is: null,
    });
    expect(totaisRegular(body)).toMatchObject({ cbs: "1.80", ibs: "0.20", ibs_uf: null });
    expect(aliquotasReferenciaMotor(body, "2026-06-01").map((a) => [a.tributo, a.valor, a.situacao])).toEqual(
      [
        ["CBS", 0.009, "referencia_motor"],
        ["IBS_UF", 0.001, "referencia_motor"],
        ["IBS_MUN", 0, "referencia_motor"],
      ],
    );
  });
});

describe("resumo with engine decimal strings", () => {
  it("formats without converting to float and hides numbers for non-numeric statuses", () => {
    expect(formatValorDecimal("1234567.50")).toBe("R$ 1.234.567,50");
    expect(formatValorDecimal("0.2")).toBe("R$ 0,20");
    expect(formatValorDecimal("abc")).toBeUndefined();
    const r = buildResumoHumano({
      titulo: "T",
      itens: [
        { item: 1, status: "CALCULADO", valores: { CBS: "1.80", IS: null } },
        { item: 2, status: "NAO_IMPLEMENTADO", descricao: "x 99", valores: { CBS: "9.99" } },
      ],
      totais: { CBS: "1.80" },
    });
    expect(r).toContain("• Item 1 — CALCULADO: CBS R$ 1,80");
    const l2 = r.split("\n").find((l) => l.startsWith("• Item 2"))!;
    expect(l2.slice(l2.indexOf("—"))).not.toMatch(/\d/);
  });
});

describe("engine errors", () => {
  it("maps RFC 7807 errors and builds the 422 tool error", () => {
    const body = {
      title: "Erros no processamento do cálculo",
      status: 422,
      errors: [
        {
          type: "/x",
          title: "Município não pertencente à UF",
          code: "REG-018",
          pointer: "#/itens/-1",
          detail: "d",
        },
      ],
    };
    expect(mapErrosMotor(body.errors)).toEqual([
      { codigo: "REG-018", titulo: "Município não pertencente à UF", detalhe: "d", campo: "#/itens/-1" },
    ]);
    expect(dicaErroMotor("REG-999")).toMatch(/explicar_status/);
    const r = engineGlobalErrorResult(body, undefined);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/ERRO_GLOBAL_MOTOR/);
  });
});

describe("known issues registry", () => {
  it("has valid entries for regular calc and classification", () => {
    for (const list of Object.values(KNOWN_ISSUES))
      for (const k of list) expect(KnownIssueSchema.safeParse(k).success).toBe(true);
    expect(knownIssuesFor("regular").map((k) => k.id)).toEqual([
      "calculadora-rtc-regime-regular#3",
      "calculadora-rtc-regime-regular#10",
    ]);
    expect(knownIssuesFor("inexistente")).toEqual([]);
    const copy = knownIssuesFor("regular");
    copy[0]!.descricao = "x";
    expect(KNOWN_ISSUES.regular![0]!.descricao).not.toBe("x");
  });
});

describe("text search (buscar_classificacao)", () => {
  it("normalizes accents, stopwords and plurals", () => {
    expect(normalizeText("Água-Mineral, AÇÚCAR!")).toBe("agua mineral acucar");
    expect(tokenize("Venda de bebidas açucaradas para o consumidor")).toEqual([
      "bebida",
      "acucarada",
      "consumidor",
    ]);
    expect(stem("operacoes")).toBe("operacao");
  });

  it("scores by term overlap with field weights and prefix matches", () => {
    const s = scoreDocument(tokenize("alimentação humana"), [
      { text: "Vendas de produtos destinados à alimentação humana (Anexo I)", weight: 2 },
    ]);
    expect(s.termos).toEqual(["alimentacao", "humana"]);
    expect(s.score).toBe(4);
    expect(scoreDocument(["aliment"], [{ text: "alimentação", weight: 2 }]).score).toBe(1);
    expect(scoreDocument(["xyz"], [{ text: "alimentação", weight: 2 }]).score).toBe(0);
  });
});

describe("tool descriptor _meta", () => {
  const fakeWidget: Extension = {
    name: "fake-widget",
    toolMeta: (t) =>
      t.name === "calcular_regime_regular" ? { ui: { resourceUri: "ui://x" }, n: t.name } : undefined,
  };
  const ctx = { extensions: [fakeWidget] } as unknown as AppContext;
  const tool = { name: "calcular_regime_regular" } as never;
  it("merges extension toolMeta and keeps the tool's own _meta", () => {
    expect(toolDescriptorMeta(tool, ctx)).toEqual({
      ui: { resourceUri: "ui://x" },
      n: "calcular_regime_regular",
    });
    expect(toolDescriptorMeta({ name: "versao" } as never, ctx)).toBeUndefined();
    expect(toolDescriptorMeta({ name: "versao", _meta: { a: 1 } } as never, ctx)).toEqual({ a: 1 });
    expect(toolDescriptorMeta(tool, ctx, [])).toBeUndefined();
  });
});
