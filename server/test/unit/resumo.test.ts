import { describe, expect, it } from "vitest";
import type { AliquotaUsada } from "../../src/receipt/receipt.ts";
import { buildResumoHumano, formatPercentual, formatValor } from "../../src/tools/shared/resumo.ts";

const prov: AliquotaUsada = {
  tributo: "CBS",
  valor: 0.0101,
  vigencia: "2027-01-01/2027-12-31",
  fonte: "Fonte fictícia",
  url_fonte: "",
  data_fonte: "2026-01-01",
  situacao: "provisoria",
  rates_file_version: "x",
};

describe("resumo_humano rules", () => {
  it("mentions provisional rates explicitly", () => {
    const r = buildResumoHumano({ titulo: "Cálculo", itens: [], aliquotas: [prov] });
    expect(r).toMatch(/PROVISÓRIA/);
    expect(r).toMatch(/CBS/);
  });

  it("does not mention provisional when all rates are official", () => {
    const r = buildResumoHumano({
      titulo: "Cálculo",
      itens: [],
      aliquotas: [{ ...prov, situacao: "oficial" }],
    });
    expect(r).not.toMatch(/PROVIS/);
  });

  it("never prints numeric values for NAO_IMPLEMENTADO / INCONSISTENCIA_ENTRADA / FALHA_TECNICA", () => {
    const r = buildResumoHumano({
      titulo: "Cálculo",
      itens: [
        { item: 1, status: "CALCULADO", descricao: "Consultoria", valores: { CBS: 50.5 } },
        { item: 2, status: "NAO_IMPLEMENTADO", descricao: "Produto 123", valores: { CBS: 999.99 } },
        { item: 3, status: "INCONSISTENCIA_ENTRADA", valores: { IBS_UF: 77.7 } },
        { item: 4, status: "FALHA_TECNICA", valores: { IS: 1 } },
      ],
    });
    const lines = r.split("\n");
    expect(lines.find((l) => l.includes("Item 1"))).toContain("R$ 50,50");
    for (const n of [2, 3, 4]) {
      const line = lines.find((l) => l.includes(`Item ${n}`))!;
      expect(line.replace(`Item ${n}`, "")).not.toMatch(/\d/);
      expect(line).toMatch(/sem valor/);
    }
    expect(r).not.toContain("999");
    expect(r).not.toContain("77,7");
    expect(r).not.toContain("123");
  });

  it("formats values without re-rounding", () => {
    expect(formatValor(1234.5)).toBe("R$ 1.234,50");
    expect(formatValor(0.125)).toBe("R$ 0,125");
    expect(formatPercentual(0.0101)).toBe("1,01%");
  });
});
