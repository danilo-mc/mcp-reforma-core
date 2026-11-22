import { describe, expect, it } from "vitest";
import {
  assertNoPersonalData,
  AVISO_RECIBO,
  buildReceipt,
  canonicalize,
  compareOutputs,
  findPersonalData,
  isValidCpf,
  outputSha256,
  PersonalDataError,
  ReciboSchema,
  sha256Hex,
  verifyReceipt,
  type AliquotaUsada,
} from "../../src/receipt/index.ts";

const motor = {
  repositorio: "ReceitaFederal/calculadora-rtc-regime-regular",
  commit: "f1eebd7",
  versao: "1.6.1",
  versao_base: "V0059",
};
const payload = { dataHoraEmissao: "2027-03-15", itens: [{ cst: "000", valor: 5000, quantidade: 1 }] };
const rawResponse = '{ "itens": [ {"status": "CALCULADO", "valor": 1.23} ] }';
const aliquota: AliquotaUsada = {
  tributo: "CBS",
  valor: 0.0101,
  vigencia: "2027-01-01/2027-12-31",
  fonte: "Fonte fictícia de teste",
  url_fonte: "",
  data_fonte: "2026-01-01",
  situacao: "provisoria",
  rates_file_version: "2099-01-01",
};

describe("buildReceipt", () => {
  const recibo = buildReceipt({
    engine: motor,
    payloadSentToEngine: payload,
    rawEngineResponse: rawResponse,
    aliquotasUsadas: [aliquota],
    statusItens: [{ item: 1, status: "CALCULADO" }],
    now: new Date("2026-12-01T14:03:22.123Z"),
  });

  it("produces the SPEC §6 contract", () => {
    expect(ReciboSchema.safeParse(recibo).success).toBe(true);
    expect(recibo.schema).toBe("mcp-reforma/recibo@1");
    expect(recibo.gerado_em).toBe("2026-12-01T14:03:22Z");
    expect(recibo.aviso).toBe(AVISO_RECIBO);
    expect(recibo.aviso).toBe(
      "Estimativa gerada a partir do código aberto da Receita Federal. Ferramenta independente, não oficial. A classificação fiscal e a apuração são responsabilidade do contribuinte.",
    );
    expect(Object.keys(recibo)).toEqual([
      "schema",
      "gerado_em",
      "motor",
      "aliquotas_usadas",
      "status_itens",
      "known_issues",
      "input_canonical",
      "input_canonical_sha256",
      "output_sha256",
      "normalizacao",
      "aviso",
    ]);
    expect(recibo.normalizacao).toBe("mcp-reforma/normalizacao@1");
  });

  it("hashes the canonical payload and canonical raw output", () => {
    expect(recibo.input_canonical_sha256).toBe(sha256Hex(canonicalize(payload)));
    expect(recibo.output_sha256).toBe(sha256Hex('{"itens":[{"status":"CALCULADO","valor":1.23}]}'));
    expect(recibo.input_canonical).toEqual(payload);
  });

  it("hashes binary outputs as raw bytes and records pdf_sha256", () => {
    const pdf = Buffer.from("%PDF-1.7 fake");
    const r = buildReceipt({
      engine: motor,
      payloadSentToEngine: { stc: 0 },
      rawEngineResponse: pdf,
      xmlSha256: sha256Hex("<x/>"),
    });
    expect(r.output_sha256).toBe(sha256Hex(pdf));
    expect(r.pdf_sha256).toBe(sha256Hex(pdf));
    expect(r.xml_sha256).toBe(sha256Hex("<x/>"));
    expect(outputSha256("not json")).toBe(sha256Hex("not json"));
  });

  it("rejects personal data in the payload", () => {
    expect(() =>
      buildReceipt({
        engine: motor,
        payloadSentToEngine: { tomador: { cpf: "1" } },
        rawEngineResponse: "{}",
      }),
    ).toThrow(PersonalDataError);
  });

  describe("verifyReceipt", () => {
    it("accepts an untouched receipt", () => {
      const v = verifyReceipt(structuredClone(recibo), { rawEngineResponse: rawResponse });
      expect(v).toMatchObject({ valido: true, erros: [] });
    });

    it("detects a single-byte change in the payload", () => {
      const t = structuredClone(recibo) as typeof recibo & { input_canonical: typeof payload };
      t.input_canonical.itens[0]!.valor = 5001;
      const v = verifyReceipt(t);
      expect(v.valido).toBe(false);
      expect(v.erros.join()).toMatch(/input_canonical_sha256/);
    });

    it("detects a changed hash", () => {
      const t = { ...structuredClone(recibo), input_canonical_sha256: "0".repeat(64) };
      expect(verifyReceipt(t).valido).toBe(false);
    });

    it("detects output mismatch", () => {
      const v = verifyReceipt(recibo, {
        rawEngineResponse: '{"itens":[{"status":"CALCULADO","valor":1.24}]}',
      });
      expect(v.valido).toBe(false);
      expect(v.erros.join()).toMatch(/output_sha256/);
    });

    it("rejects schema violations (wrong aviso, missing fields)", () => {
      expect(verifyReceipt({ ...recibo, aviso: "outro" }).valido).toBe(false);
      expect(verifyReceipt({ ...recibo, schema: "x" }).valido).toBe(false);
      expect(verifyReceipt({}).valido).toBe(false);
      expect(verifyReceipt(null).valido).toBe(false);
    });
  });
});

describe("compareOutputs", () => {
  it("confirms identical structures regardless of key order", () => {
    expect(compareOutputs({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual({ confere: true, diff: [] });
  });

  it("returns JSON-pointer paths for changes, additions and removals", () => {
    const a = { itens: [{ valor: 1, "a/b": "x", "t~": 1 }], total: 10, old: true };
    const b = { itens: [{ valor: 2, "a/b": "y", "t~": 1 }, { valor: 3 }], total: 10, novo: 1 };
    const r = compareOutputs(a, b);
    expect(r.confere).toBe(false);
    expect(r.diff).toEqual([
      { path: "/itens/0/a~1b", tipo: "alterado", antes: "x", depois: "y" },
      { path: "/itens/0/valor", tipo: "alterado", antes: 1, depois: 2 },
      { path: "/itens/1", tipo: "adicionado", depois: { valor: 3 } },
      { path: "/novo", tipo: "adicionado", depois: 1 },
      { path: "/old", tipo: "removido", antes: true },
    ]);
  });

  it("flags type changes at root", () => {
    expect(compareOutputs([1], { 0: 1 }).diff).toEqual([
      { path: "", tipo: "alterado", antes: [1], depois: { 0: 1 } },
    ]);
  });
});

describe("privacy sanitizer", () => {
  it("validates CPF check digits", () => {
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("52998224724")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
  });

  it("flags formatted CPF, valid bare CPF, e-mail and personal keys", () => {
    expect(findPersonalData({ obs: "cliente 529.982.247-25" })).toEqual(["/obs"]);
    expect(findPersonalData({ doc: "52998224725" })).toEqual(["/doc"]);
    expect(findPersonalData({ contato: "fulano@example.com" })).toEqual(["/contato"]);
    expect(findPersonalData({ tomador: { Nome: "Fulano", CPF: "x" } })).toEqual([
      "/tomador/Nome",
      "/tomador/CPF",
    ]);
    expect(findPersonalData([{ name: "x" }])).toEqual(["/0/name"]);
    expect(() => assertNoPersonalData({ nome_completo: "Fulano" })).toThrow(PersonalDataError);
  });

  it("accepts typical engine payloads (codes, values, municipality)", () => {
    const ok = {
      municipio: 3550308,
      cst: "000",
      cClassTrib: "000001",
      nbs: "1.1101.10.00",
      ncm: "22021000",
      cnpj: "12345678000195",
      chave: "12345678901",
      valor: 5000,
      nome: null,
    };
    expect(findPersonalData(ok)).toEqual([]);
  });
});
