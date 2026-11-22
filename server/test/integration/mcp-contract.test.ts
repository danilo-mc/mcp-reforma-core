import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext } from "../../src/context.ts";
import { createMcpServer } from "../../src/server.ts";
import { canonicalize } from "../../src/receipt/jcs.ts";
import { FAKE_VALID_RATES, removeDir, scratchDir, testConfig, writeRates } from "../helpers/fixtures.ts";
import { startMockEngines, type MockEngines } from "../helpers/mock-http.ts";

type Structured = Record<string, any>;

const EXPECTED_TOOLS = [
  "buscar_classificacao",
  "calcular_regime_regular",
  "calcular_simples",
  "consultar_aliquotas",
  "explicar_status",
  "reproduzir_calculo",
  "versao",
];

async function connect(env: Record<string, string>) {
  const ctx = createContext(testConfig(env), { proberTtlMs: 0 });
  const server = createMcpServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server, ctx };
}

describe("MCP contract (in-memory)", () => {
  let engines: MockEngines;
  let client: Client;
  let ratesDir: string;

  beforeAll(async () => {
    engines = await startMockEngines();
    ratesDir = writeRates(scratchDir("rates-mcp"), { "2027.yaml": FAKE_VALID_RATES });
    ({ client } = await connect({
      ENGINE_REGULAR_URL: engines.regularUrl,
      ENGINE_SIMPLES_URL: engines.simplesUrl,
      RATES_DIR: ratesDir,
    }));
  });
  afterAll(async () => {
    await client.close();
    await engines.close();
    removeDir(ratesDir);
  });

  it("lists tools, all read-only with pt-BR descriptions and input/output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
    }
  });

  it("calcular_regime_regular (2027, vigente) injects validated rates/ in percentage points with provenance", async () => {
    const before = engines.regular.requests.length;
    const r = await client.callTool({
      name: "calcular_regime_regular",
      arguments: {
        data_fato_gerador: "2027-05-01",
        uf: "sp",
        municipio_ibge: "3550308",
        itens: [
          { ncm: "2202.10.00", cst: "000", cclasstrib: "000001", valor: 10 },
          { nbs: "101011100", cst: "000", cclasstrib: "000001", valor: "20.50" },
        ],
      },
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const post = engines.regular.requests.slice(before).find((q) => q.method === "POST")!;
    const sent = JSON.parse(post.body) as Structured;
    expect(sent).toMatchObject({
      dhFatoGerador: "2027-05-01T00:00:00-03:00",
      municipio: 3550308,
      uf: "SP",
      id: "mcp-reforma",
    });
    expect(sent.itens[0]).toMatchObject({ numero: 1, ncm: "22021000", baseCalculo: 10 });
    expect(sent.itens[1]).toMatchObject({ numero: 2, nbs: "101011100", baseCalculo: 20.5 });
    for (const it of sent.itens) {
      expect(it.aliquotasNominais).toEqual({ cbs: 1.01, ibsEstadual: 2.03, ibsMunicipal: 3.03 });
    }
    const s = r.structuredContent as Structured;
    expect(s.cenario_aliquotas).toBe("vigente");
    expect(s.recibo.aliquotas_usadas.map((a: Structured) => [a.tributo, a.valor, a.fonte])).toEqual([
      ["CBS", 0.0101, "Fonte fictícia de teste"],
      ["IBS_UF", 0.0203, "Fonte fictícia de teste SP"],
      ["IBS_MUN", 0.0303, "Fonte fictícia de teste"],
    ]);
    expect(s.resumo_humano).toMatch(/PROVISÓRIA/);
    expect(s.recibo.motor.rota).toBe("/calculadora/observabilidade/regime-geral");
    // the hashed input is exactly the body sent
    expect(canonicalize(s.recibo.input_canonical)).toBe(post.body);
  });

  it("calcular_regime_regular validates input (NCM and NBS together, too many items)", async () => {
    const both = await client.callTool({
      name: "calcular_regime_regular",
      arguments: {
        data_fato_gerador: "2026-05-01",
        uf: "SP",
        municipio_ibge: "3550308",
        itens: [{ ncm: "22021000", nbs: "101011100", cst: "000", cclasstrib: "000001", valor: 1 }],
      },
    });
    expect(both.isError).toBe(true);
    const many = await client.callTool({
      name: "calcular_regime_regular",
      arguments: {
        data_fato_gerador: "2026-05-01",
        uf: "SP",
        municipio_ibge: "3550308",
        itens: Array.from({ length: 201 }, () => ({
          ncm: "22021000",
          cst: "000",
          cclasstrib: "000001",
          valor: 1,
        })),
      },
    });
    expect(many.isError).toBe(true);
  });

  it("versao reports server, engines, commits and rates", async () => {
    const r = await client.callTool({ name: "versao", arguments: {} });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as Structured;
    expect(s.servidor.nome).toBe("mcp-reforma");
    expect(s.motores.map((m: Structured) => m.nome)).toEqual(["regular", "simples"]);
    const regular = s.motores.find((m: Structured) => m.nome === "regular");
    expect(regular).toMatchObject({
      disponivel: true,
      versao: "1.6.1",
      versao_base: "V0059",
      commit: "f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4",
    });
    expect(s.motores_indisponiveis).toEqual([]);
    expect(s.aliquotas.versao_arquivo).toBe("2099-01-01");
    expect((r.content as { text: string }[])[0]!.text).toContain("mcp-reforma");
  });

  it("consultar_aliquotas (2027) returns provenance, pendentes and provisional warning", async () => {
    const r = await client.callTool({
      name: "consultar_aliquotas",
      arguments: { data: "2027-05-01", uf: "sp" },
    });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as Structured;
    expect(s.injeta_aliquotas_no_motor).toBe(true);
    expect(s.referencia_motor).toBeNull();
    const cbs = s.aliquotas.find((a: Structured) => a.tributo === "CBS");
    expect(cbs).toMatchObject({
      situacao: "provisoria",
      fonte: "Fonte fictícia de teste",
      data_fonte: "2026-01-01",
    });
    expect(s.aliquotas.find((a: Structured) => a.tributo === "IBS_UF").uf).toBe("SP");
    expect(s.pendentes.map((p: Structured) => p.tributo)).toEqual(["IS"]);
    expect(s.resumo_humano).toMatch(/PROVISÓRIA/);
    expect(s.resumo_humano).toMatch(/PENDENTE/);
  });

  it("consultar_aliquotas (2026) fetches engine reference rates best-effort", async () => {
    const r = await client.callTool({
      name: "consultar_aliquotas",
      arguments: { data: "2026-05-01", uf: "SP", municipio_ibge: "3550308" },
    });
    const s = r.structuredContent as Structured;
    expect(s.injeta_aliquotas_no_motor).toBe(false);
    expect(s.referencia_motor).toMatchObject({ consultado: true, disponivel: true, erros: [] });
    expect(s.referencia_motor.uniao).toMatchObject({ aliquotaReferencia: 0.0123 });
    expect(s.referencia_motor.uf).toBeDefined();
    expect(s.referencia_motor.municipio).toBeDefined();
    const ufReq = engines.regular.requests.find((q) => q.url.includes("aliquota-uf"))!;
    expect(ufReq.url).toContain("codigoUf=35");
  });

  it("consultar_aliquotas rejects invalid input", async () => {
    const r = await client.callTool({ name: "consultar_aliquotas", arguments: { data: "2027-02-30" } });
    expect(r.isError).toBe(true);
  });

  it("explicar_status explains item statuses from i18n", async () => {
    const r = await client.callTool({ name: "explicar_status", arguments: { codigo: "nao_implementado" } });
    const s = r.structuredContent as Structured;
    expect(s).toMatchObject({ codigo: "NAO_IMPLEMENTADO", tipo: "status", fonte: "mcp-reforma" });
    expect(s.explicacao).toMatch(/não implementa/);
  });

  it("explicar_status fetches engine error codes (regular and simples)", async () => {
    const reg = (await client.callTool({ name: "explicar_status", arguments: { codigo: "REG-011" } }))
      .structuredContent as Structured;
    expect(reg).toMatchObject({
      tipo: "erro_motor",
      motor: "regular",
      titulo: "Título de teste",
      fonte: "motor-oficial",
    });
    const sn = (await client.callTool({ name: "explicar_status", arguments: { codigo: "VSN-001" } }))
      .structuredContent as Structured;
    expect(sn).toMatchObject({ tipo: "erro_motor", motor: "simples", explicacao: "Descrição Simples" });
  });

  it("explicar_status falls back to neutral text for unknown codes", async () => {
    const s = (await client.callTool({ name: "explicar_status", arguments: { codigo: "REG-999" } }))
      .structuredContent as Structured;
    expect(s).toMatchObject({ tipo: "desconhecido", fonte: "nenhuma", motor_disponivel: true });
    const s2 = (await client.callTool({ name: "explicar_status", arguments: { codigo: "qualquer coisa" } }))
      .structuredContent as Structured;
    expect(s2.tipo).toBe("desconhecido");
  });
});

describe("MCP contract with engines down", () => {
  it("versao reports unavailable engines; explicar_status and consultar_aliquotas degrade gracefully", async () => {
    const { client } = await connect({
      ENGINE_REGULAR_URL: "http://127.0.0.1:1/api",
      ENGINE_SIMPLES_URL: "http://127.0.0.1:1/api",
    });
    const v = (await client.callTool({ name: "versao", arguments: {} })).structuredContent as Structured;
    expect(v.motores_indisponiveis.sort()).toEqual(["regular", "simples"]);
    expect(v.resumo_humano).toMatch(/INDISPONÍVEL/);

    const e = (await client.callTool({ name: "explicar_status", arguments: { codigo: "REG-011" } }))
      .structuredContent as Structured;
    expect(e).toMatchObject({ tipo: "desconhecido", motor_disponivel: false });

    const a = await client.callTool({ name: "consultar_aliquotas", arguments: { data: "2026-03-01" } });
    expect(a.isError).toBeFalsy();
    const s = a.structuredContent as Structured;
    expect(s.referencia_motor.disponivel).toBe(false);
    expect(s.pendentes).toEqual([]);

    const r2027 = (await client.callTool({ name: "consultar_aliquotas", arguments: { data: "2027-03-01" } }))
      .structuredContent as Structured;
    expect(r2027.aliquotas).toEqual([]);
    expect(r2027.pendentes).toHaveLength(4);
    await client.close();
  });
});
