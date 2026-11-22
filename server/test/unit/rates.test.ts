import { afterAll, describe, expect, it } from "vitest";
import {
  AliquotasNaoValidadasError,
  loadRates,
  RatesConfigError,
  requireRates,
  selectRates,
} from "../../src/rates/index.ts";
import { runRatesCheck } from "../../src/rates/check.ts";
import { FAKE_VALID_RATES, REPO_RATES_DIR, removeDir, scratchDir, writeRates } from "../helpers/fixtures.ts";

const dirs: string[] = [];
const mk = (files: Record<string, string>) => {
  const d = scratchDir("rates");
  dirs.push(d);
  return writeRates(d, files);
};
afterAll(() => dirs.forEach(removeDir));

describe("rates loader", () => {
  it("loads valid entries and marks placeholders as pendentes", () => {
    const snap = loadRates(mk({ "2027.yaml": FAKE_VALID_RATES }));
    expect(snap.version).toBe("2099-01-01");
    expect(snap.entries).toHaveLength(5);
    const is = snap.entries.find((e) => e.tributo === "IS")!;
    expect(is.pendente).toBe(true);
    expect(is.motivos_pendencia).toEqual(
      expect.arrayContaining([
        "valor ausente",
        "fonte ausente",
        "data_fonte ausente",
        "marcado TODO(VALIDAR)",
      ]),
    );
    expect(snap.entries.filter((e) => !e.pendente)).toHaveLength(4);
  });

  it("marks an otherwise complete entry with a TODO(VALIDAR) comment as pendente", () => {
    const snap = loadRates(
      mk({
        "a.yaml": `version: "1"
entries:
  - tributo: CBS
    vigencia: { inicio: 2027-01-01, fim: 2027-12-31 }
    valor: 0.5 # TODO(VALIDAR)
    situacao: oficial
    fonte: "x"
    data_fonte: 2026-01-01
`,
      }),
    );
    expect(snap.entries[0]!.pendente).toBe(true);
  });

  it("rejects overlapping vigências for the same scope", () => {
    const entry = (inicio: string, fim: string) => `
  - tributo: CBS
    vigencia: { inicio: ${inicio}, fim: ${fim} }
    valor: 0.1
    situacao: oficial
    fonte: "x"
    data_fonte: 2026-01-01`;
    const dir = mk({
      "a.yaml": `version: "1"\nentries:${entry("2027-01-01", "2027-06-30")}${entry("2027-06-30", "2027-12-31")}\n`,
    });
    expect(() => loadRates(dir)).toThrow(RatesConfigError);
    expect(loadRates(dir, { lenient: true }).problemas.join()).toMatch(/sobrepostas/);
  });

  it("does not treat different scopes as overlapping", () => {
    expect(() => loadRates(mk({ "2027.yaml": FAKE_VALID_RATES }))).not.toThrow();
  });

  it("rejects schema violations (valor > 1, bad tributo, fim < inicio, unknown key)", () => {
    const bad = `version: "1"
entries:
  - tributo: CBS
    valor: 1.5
  - tributo: ICMS
  - tributo: IBS_MUN
    vigencia: { inicio: 2027-12-31, fim: 2027-01-01 }
  - tributo: IS
    aliquota: 0.1
`;
    const snap = loadRates(mk({ "a.yaml": bad }), { lenient: true });
    const msg = snap.problemas.join("\n");
    expect(msg).toMatch(/entries\[0\]\.valor/);
    expect(msg).toMatch(/entries\[1\]\.tributo/);
    expect(msg).toMatch(/fim anterior/);
    expect(msg).toMatch(/entries\[3\]/);
  });

  it("selects applicable rates, preferring the most specific scope", () => {
    const snap = loadRates(mk({ "2027.yaml": FAKE_VALID_RATES }));
    const sp = selectRates(snap, "2027-03-15", { uf: "SP" });
    expect(sp.aplicaveis.find((e) => e.tributo === "IBS_UF")!.valor).toBe(0.0203);
    expect(sp.aplicaveis.filter((e) => e.tributo === "IBS_UF")).toHaveLength(1);
    const rj = selectRates(snap, "2027-03-15", { uf: "RJ" });
    expect(rj.aplicaveis.find((e) => e.tributo === "IBS_UF")!.valor).toBe(0.0202);
    expect(selectRates(snap, "2028-01-01").aplicaveis).toEqual([]);
    expect(sp.pendentes.map((e) => e.tributo)).toEqual(["IS"]);
  });

  it("requireRates: no injection before 2027, rates with provenance from 2027 on", () => {
    const snap = loadRates(mk({ "2027.yaml": FAKE_VALID_RATES }));
    expect(requireRates(snap, "2026-06-01").injetar).toBe(false);
    const r = requireRates(snap, "2027-02-01", { uf: "SP" });
    expect(r.injetar).toBe(true);
    expect(r.aliquotasUsadas.map((a) => a.tributo).sort()).toEqual(["CBS", "IBS_MUN", "IBS_UF"]);
    for (const a of r.aliquotasUsadas) {
      expect(a.fonte).toBeTruthy();
      expect(a.data_fonte).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.rates_file_version).toBe("2099-01-01");
    }
  });

  it("requireRates refuses pending entries with a Portuguese error", () => {
    const snap = loadRates(mk({ "2027.yaml": FAKE_VALID_RATES }));
    expect(() => requireRates(snap, "2027-02-01", { produto: "bebidas_acucaradas" }, ["CBS", "IS"])).toThrow(
      AliquotasNaoValidadasError,
    );
    try {
      requireRates(snap, "2027-02-01", {}, ["IS"]);
    } catch (e) {
      expect((e as Error).message).toMatch(/ainda não foram validadas/);
    }
  });

  it("repo rates/2027.yaml: loads, everything is pending and nothing is usable", () => {
    const snap = loadRates(REPO_RATES_DIR);
    expect(snap.entries.map((e) => e.tributo).sort()).toEqual(["CBS", "IBS_MUN", "IBS_UF", "IS"]);
    expect(snap.entries.every((e) => e.pendente && e.valor === null)).toBe(true);
    expect(() => requireRates(snap, "2027-01-01")).toThrow(AliquotasNaoValidadasError);
  });
});

describe("rates check CLI", () => {
  it("non-strict passes on repo rates (placeholders listed)", () => {
    const r = runRatesCheck(REPO_RATES_DIR, false);
    expect(r.ok).toBe(true);
    expect(r.linhas.join("\n")).toMatch(/PENDENTE/);
  });

  it("strict fails on repo rates/2027.yaml", () => {
    const r = runRatesCheck(REPO_RATES_DIR, true);
    expect(r.ok).toBe(false);
    expect(r.linhas.join("\n")).toMatch(/TODO\(VALIDAR\)/);
  });

  it("strict passes on a fully validated file", () => {
    const valid = FAKE_VALID_RATES.split("  - tributo: IS")[0]!;
    expect(runRatesCheck(mk({ "2027.yaml": valid }), true).ok).toBe(true);
  });

  it("fails when the directory has no files", () => {
    expect(runRatesCheck(mk({}), false).ok).toBe(false);
  });
});
