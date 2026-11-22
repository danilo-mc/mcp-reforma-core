import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { REGULAR_ROUTES } from "../../src/engine-client/routes.ts";
import { canonicalize } from "../../src/receipt/jcs.ts";
import { normalizeEngineOutput, normalizedOutputSha256 } from "../../src/receipt/normalize.ts";
import { createMcpServer } from "../../src/server.ts";
import { NON_NUMERIC_STATUSES } from "../../src/status.ts";
import { executeCalculation, extractObjetosStatus } from "../../src/tools/shared/engine-call.ts";
import { testConfig } from "../helpers/fixtures.ts";

type Structured = Record<string, any>;

const ENGINE_REGULAR_URL = process.env.ENGINE_REGULAR_URL ?? "http://localhost:18080/api";
const ENGINE_SIMPLES_URL = process.env.ENGINE_SIMPLES_URL ?? "http://localhost:18082/api";

const up = await fetch(`${ENGINE_REGULAR_URL}${REGULAR_ROUTES.versao}`).then(
  (r) => r.ok,
  () => false,
);

const FIXTURES = new URL("./fixtures/", import.meta.url);
interface ManifestEntry {
  name: string;
  http_status: number;
  estados: string[] | null;
}
const manifest = JSON.parse(readFileSync(new URL("manifest.json", FIXTURES), "utf8")) as {
  regular: ManifestEntry[];
};
const read = (name: string, kind: "input" | "engine-output") =>
  readFileSync(new URL(`regular/${name}.${kind}.json`, FIXTURES), "utf8");

/** Calls the engine directly (no MCP server code involved). */
async function direct(bodyText: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${ENGINE_REGULAR_URL}${REGULAR_ROUTES.calcular}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: bodyText,
  });
  return { status: res.status, text: await res.text() };
}

const norm = (text: string) => normalizeEngineOutput(JSON.parse(text));

function errorPayload(r: unknown): Structured {
  const text = (r as { content: { text: string }[] }).content[0]!.text;
  return JSON.parse(text.slice(text.indexOf("\n\n{") + 2)) as Structured;
}

function flipHash(h: string): string {
  return (h[0] === "0" ? "1" : "0") + h.slice(1);
}

/** Item lines of resumo_humano for non-numeric statuses must not contain any digit after the dash. */
function assertHonesty(s: Structured) {
  for (const it of s.itens as Structured[]) {
    if (!NON_NUMERIC_STATUSES.has(it.status)) continue;
    expect(it.valores).toBeNull();
    const line = (s.resumo_humano as string).split("\n").find((l) => l.startsWith(`• Item ${it.item} `))!;
    expect(line).toBeDefined();
    expect(line.slice(line.indexOf("—"))).not.toMatch(/\d/);
  }
}

function assertProvenance(s: Structured) {
  if (s.data_fato_gerador < "2027-01-01") return;
  expect(s.recibo.aliquotas_usadas.length).toBeGreaterThan(0);
  for (const a of s.recibo.aliquotas_usadas as Structured[]) {
    expect(typeof a.fonte).toBe("string");
    expect(a.fonte.length).toBeGreaterThan(0);
  }
}

describe.skipIf(!up)("golden: regime regular (motor oficial em execução)", () => {
  let ctx: AppContext;
  let client: Client;
  const signal = new AbortController().signal;

  beforeAll(async () => {
    ctx = createContext(testConfig({ ENGINE_REGULAR_URL, ENGINE_SIMPLES_URL, ENGINE_TIMEOUT_MS: "30000" }), {
      proberTtlMs: 0,
    });
    const server = createMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "golden", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });
  afterAll(async () => client?.close());

  async function reproduzir(args: Record<string, unknown>): Promise<Structured> {
    const r = await client.callTool({ name: "reproduzir_calculo", arguments: args });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    return r.structuredContent as Structured;
  }

  describe.each(manifest.regular.map((m) => [m.name, m] as const))("fixture %s", (name, m) => {
    it("MCP pipeline output = direct engine output (normalized), receipt reproduces", async () => {
      const inputText = read(name, "input");
      const d = await direct(inputText);
      expect(d.status).toBe(m.http_status);
      // regression against the captured upstream output (host/order/timestamp normalized)
      expect(norm(d.text)).toEqual(norm(read(name, "engine-output")));

      const run = await executeCalculation(ctx, {
        engine: "regular",
        payload: JSON.parse(inputText),
        aliquotasUsadas: [],
        extractStatusItens: extractObjetosStatus,
        signal,
        acceptStatuses: [422],
      });
      expect(run.response.status).toBe(m.http_status);
      expect(run.saidaNormalizada).toEqual(norm(d.text));
      expect(run.recibo.output_sha256).toBe(normalizedOutputSha256(d.text));
      expect(run.recibo.normalizacao).toBe("mcp-reforma/normalizacao@1");
      expect(run.recibo.motor).toMatchObject({
        commit: "f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4",
        versao: m.http_status === 200 ? "1.7.2" : expect.any(String),
        rota: REGULAR_ROUTES.calcular,
      });
      expect(run.recibo.status_itens.map((s) => s.status)).toEqual(m.estados ?? []);
      expect(run.recibo.input_canonical).toEqual(JSON.parse(inputText));

      const ok = await reproduzir({ recibo: run.recibo });
      expect(ok.confere).toBe(true);
      expect(ok.versoes_compativeis).toBe(true);
      expect(ok.output_sha256_novo).toBe(run.recibo.output_sha256);

      const tampered = await reproduzir({
        recibo: { ...run.recibo, output_sha256: flipHash(run.recibo.output_sha256) },
      });
      expect(tampered.confere).toBe(false);
      expect(tampered.diff.map((x: Structured) => x.path)).toContain("/output_sha256");

      if (run.recibo.status_itens.length > 0) {
        const st = structuredClone(run.recibo);
        st.status_itens[0]!.status =
          st.status_itens[0]!.status === "CALCULADO" ? "NAO_IMPLEMENTADO" : "CALCULADO";
        const t2 = await reproduzir({ recibo: st });
        expect(t2.confere).toBe(false);
        expect(t2.diff.map((x: Structured) => x.path)).toContain("/status_itens/0/status");
      }

      const withOriginal = await reproduzir({ recibo: run.recibo, resposta_motor_original: d.text });
      expect(withOriginal).toMatchObject({ confere: true, diff: [] });

      const badInput = structuredClone(run.recibo) as Structured;
      badInput.input_canonical.versao = "9.9.9";
      const invalid = await client.callTool({ name: "reproduzir_calculo", arguments: { recibo: badInput } });
      expect(invalid.isError).toBe(true);
      expect(errorPayload(invalid).erro.codigo).toBe("RECIBO_INVALIDO");
    });
  });

  // ---- tool level (public Portuguese schema) ----

  async function calcular(args: Record<string, unknown>) {
    return client.callTool({ name: "calcular_regime_regular", arguments: args });
  }

  /** The tool's engine body equals a direct call with the receipt's canonical input. */
  async function assertSameAsDirect(s: Structured) {
    const d = await direct(canonicalize(s.recibo.input_canonical));
    expect(normalizeEngineOutput(s.resposta_motor)).toEqual(norm(d.text));
    expect(s.recibo.output_sha256).toBe(normalizedOutputSha256(d.text));
    const rep = await reproduzir({ recibo: s.recibo });
    expect(rep.confere).toBe(true);
  }

  it("2026: engine internal reference rates, values verbatim, provenance from the engine", async () => {
    const r = await calcular({
      data_fato_gerador: "2026-01-01",
      hora: "09:50",
      uf: "RS",
      municipio_ibge: "4314902",
      itens: [
        {
          descricao: "Item de teste",
          ncm: "2402.10.00",
          cst: "000",
          cclasstrib: "000001",
          valor: 200,
          quantidade: 1,
          unidade: "VN",
        },
      ],
    });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as Structured;
    expect(s.dh_fato_gerador).toBe("2026-01-01T09:50:00-03:00");
    expect(s.recibo.input_canonical.itens[0].aliquotasNominais).toBeUndefined();
    expect(s.itens[0]).toMatchObject({
      status: "CALCULADO",
      valores: { base_calculo: "200.00", cbs: "1.80", ibs_uf: "0.20", ibs_mun: "0.00" },
    });
    expect(s.totais).toMatchObject({ cbs: "1.80", ibs: "0.20" });
    expect(s.cenario_aliquotas).toBe("referencia_motor");
    expect(s.aliquotas_usadas.map((a: Structured) => [a.tributo, a.valor, a.fonte, a.situacao])).toEqual([
      ["CBS", 0.009, "motor (alíquotas de referência internas)", "referencia_motor"],
      ["IBS_UF", 0.001, "motor (alíquotas de referência internas)", "referencia_motor"],
      ["IBS_MUN", 0, "motor (alíquotas de referência internas)", "referencia_motor"],
    ]);
    expect(s.resumo_humano).toMatch(/CBS R\$ 1,80/);
    expect(s.known_issues.map((k: Structured) => k.id)).toEqual([
      "calculadora-rtc-regime-regular#3",
      "calculadora-rtc-regime-regular#10",
    ]);
    // same engine output as the official fixture for the same operation
    expect(normalizeEngineOutput(s.resposta_motor)).toEqual(
      norm(read("teste_000001_1_2026_aliquotas_internas", "engine-output")),
    );
    await assertSameAsDirect(s);
    assertHonesty(s);
  });

  it("2027: explicit user rates (fractions) converted exactly to percentage points; IS item", async () => {
    const r = await calcular({
      data_fato_gerador: "2027-01-01",
      hora: "09:50:05",
      uf: "RS",
      municipio_ibge: "4314902",
      itens: [
        {
          ncm: "24021000",
          cst: "000",
          cclasstrib: "000001",
          valor: "200",
          quantidade: 1,
          unidade: "VN",
          imposto_seletivo: {
            cst: "000",
            cclasstrib: "000001",
            valor: 200,
            quantidade: 1,
            unidade: "VN",
            imposto_informado: 0,
          },
        },
      ],
      cenario_aliquotas: {
        cbs: 0.084,
        ibs_uf: "0.0005",
        ibs_mun: 0.0005,
        is: { ad_valorem: 0.13, ad_rem: 21.3 },
      },
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const s = r.structuredContent as Structured;
    expect(s.recibo.input_canonical.itens[0].aliquotasNominais).toEqual({
      cbs: 8.4,
      ibsEstadual: 0.05,
      ibsMunicipal: 0.05,
      impostoSeletivo: { adValorem: 13, adRem: 21.3 },
    });
    expect(s.itens[0]).toMatchObject({
      status: "CALCULO_SIMULADO",
      valores: { cbs: "20.77", is: "47.30", ibs: "0.24" },
    });
    expect(s.totais.is).toBe("47.30");
    expect(s.avisos_motor).toEqual({ "x-warning-dados-simulados": "6" });
    expect(s.cenario_aliquotas).toBe("usuario");
    expect(
      s.aliquotas_usadas.every((a: Structured) => a.fonte === "usuario" && a.situacao === "usuario"),
    ).toBe(true);
    expect(s.aliquotas_usadas.find((a: Structured) => a.componente === "ad_rem").valor).toBe(21.3);
    // identical to the upstream fixture computed with the same rates (Teste_000001_2)
    expect(normalizeEngineOutput(s.resposta_motor)).toEqual(
      norm(read("teste_000001_2_2027_is_aliquotas_injetadas", "engine-output")),
    );
    assertProvenance(s);
    await assertSameAsDirect(s);
  });

  it("2027 with 'vigente': refuses to calculate while rates/ is not validated", async () => {
    const r = await calcular({
      data_fato_gerador: "2027-03-15",
      uf: "SP",
      municipio_ibge: "3550308",
      itens: [{ nbs: "1.0101.11.00", cst: "000", cclasstrib: "000001", valor: 5000 }],
    });
    expect(r.isError).toBe(true);
    expect(errorPayload(r).erro.codigo).toBe("ALIQUOTAS_NAO_VALIDADAS");
  });

  it("explicit rates before 2027 are rejected before calling the engine", async () => {
    const r = await calcular({
      data_fato_gerador: "2026-06-01",
      uf: "RS",
      municipio_ibge: "4314902",
      itens: [{ ncm: "24021000", cst: "000", cclasstrib: "000001", valor: 1 }],
      cenario_aliquotas: { cbs: 0.01, ibs_uf: 0.01, ibs_mun: 0.01 },
    });
    expect(r.isError).toBe(true);
    expect(errorPayload(r).erro.codigo).toBe("CENARIO_INVALIDO");
  });

  it("multiple items with NAO_IMPLEMENTADO and INCONSISTENCIA_ENTRADA: statuses passed through, no numbers", async () => {
    const r = await calcular({
      data_fato_gerador: "2027-01-01",
      uf: "RS",
      municipio_ibge: "4314902",
      itens: [
        {
          descricao: "Produto 123 com dígitos",
          ncm: "29051100",
          cst: "620",
          cclasstrib: "620001",
          valor: 200,
        },
        { descricao: "Chá 2", ncm: "09024000", cst: "200", cclasstrib: "200003", valor: 200 },
        { descricao: "Serviço", nbs: "101011100", cst: "000", cclasstrib: "000001", valor: "1000.10" },
      ],
      cenario_aliquotas: { cbs: 0.088, ibs_uf: 0.0885, ibs_mun: 0.0005 },
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const s = r.structuredContent as Structured;
    expect(s.itens.map((i: Structured) => i.status)).toEqual([
      "NAO_IMPLEMENTADO",
      "INCONSISTENCIA_ENTRADA",
      "CALCULO_SIMULADO",
    ]);
    expect(s.itens[0].erros[0].codigo).toBe("CAL-007");
    expect(s.itens[1].erros.map((e: Structured) => e.codigo)).toContain("REG-011");
    expect(s.recibo.status_itens).toEqual([
      { item: 1, status: "NAO_IMPLEMENTADO" },
      { item: 2, status: "INCONSISTENCIA_ENTRADA" },
      { item: 3, status: "CALCULO_SIMULADO" },
    ]);
    expect(s.itens[2].valores.base_calculo).toBe("1000.10");
    assertHonesty(s);
    assertProvenance(s);
    await assertSameAsDirect(s);
  });

  it("2026 NAO_IMPLEMENTADO only: no numeric value in resumo_humano", async () => {
    const r = await calcular({
      data_fato_gerador: "2026-01-01",
      uf: "RS",
      municipio_ibge: "4314902",
      itens: [{ descricao: "Álcool 96", ncm: "29051100", cst: "620", cclasstrib: "620001", valor: 200 }],
    });
    const s = r.structuredContent as Structured;
    expect(s.itens[0].status).toBe("NAO_IMPLEMENTADO");
    expect(s.aliquotas_usadas).toEqual([]);
    expect(s.resumo_humano).toMatch(/não informou as alíquotas/);
    assertHonesty(s);
    await assertSameAsDirect(s);
  });

  it("HTTP 422 global error becomes a tool error with engine messages, hint and a reproducible receipt", async () => {
    const r = await calcular({
      data_fato_gerador: "2027-01-01",
      uf: "CE",
      municipio_ibge: "1200013",
      itens: [{ ncm: "24021000", cst: "000", cclasstrib: "000001", valor: 200 }],
      cenario_aliquotas: { cbs: 0.088, ibs_uf: 0.01, ibs_mun: 0.01 },
    });
    expect(r.isError).toBe(true);
    const p = errorPayload(r);
    expect(p.erro.codigo).toBe("ERRO_GLOBAL_MOTOR");
    expect(p.erro.erros_motor[0]).toMatchObject({
      codigo: "REG-018",
      titulo: "Município não pertencente à UF",
    });
    expect(p.erro.erros_motor[0].dica).toMatch(/municipio_ibge/);
    expect(p.recibo.status_itens).toEqual([]);
    const d = await direct(canonicalize(p.recibo.input_canonical));
    expect(d.status).toBe(422);
    expect(p.recibo.output_sha256).toBe(normalizedOutputSha256(d.text));
    expect((await reproduzir({ recibo: p.recibo })).confere).toBe(true);
  });

  it("reproduzir_calculo also accepts input_canonical + motor + output_sha256", async () => {
    const r = await calcular({
      data_fato_gerador: "2026-01-01",
      uf: "RS",
      municipio_ibge: "4314902",
      itens: [{ ncm: "24021000", cst: "000", cclasstrib: "000001", valor: 200 }],
    });
    const recibo = (r.structuredContent as Structured).recibo;
    const ok = await reproduzir({
      input_canonical: recibo.input_canonical,
      motor: recibo.motor,
      output_sha256: recibo.output_sha256,
    });
    expect(ok.confere).toBe(true);
    const ko = await reproduzir({
      input_canonical: {
        ...recibo.input_canonical,
        itens: [{ ...recibo.input_canonical.itens[0], baseCalculo: 300 }],
      },
      motor: recibo.motor,
      output_sha256: recibo.output_sha256,
    });
    expect(ko.confere).toBe(false);
    expect(ko.diff.map((x: Structured) => x.path)).toContain("/output_sha256");
  });

  it("buscar_classificacao uses the official tables (NBS links, NCM applicability, suggestions)", async () => {
    const nbs = (
      await client.callTool({
        name: "buscar_classificacao",
        arguments: { nbs: "1.0101.11.00", data: "2027-01-01" },
      })
    ).structuredContent as Structured;
    expect(nbs.nomenclatura).toMatchObject({ tipo: "NBS", codigo: "101011100", encontrado: true });
    expect(nbs.candidatos.length).toBeGreaterThan(0);
    expect(nbs.candidatos.length).toBeLessThanOrEqual(5);
    expect(nbs.candidatos[0]).toMatchObject({ cst: "000", cclasstrib: "000001", codigo_aplicavel: true });
    expect(nbs.aviso).toBe("A classificação é responsabilidade de quem emite a nota.");
    expect(nbs.known_issues.map((k: Structured) => k.id)).toEqual([
      "calculadora-rtc-regime-regular#7",
      "calculadora-rtc-regime-regular#11",
      "calculadora-rtc-regime-regular#12",
    ]);
    expect(nbs.resumo_humano).toMatch(/responsabilidade de quem emite a nota/);

    const ncm = (
      await client.callTool({
        name: "buscar_classificacao",
        arguments: { ncm: "0902.40.00", data: "2027-01-01" },
      })
    ).structuredContent as Structured;
    expect(ncm.candidatos[0].cclasstrib).toBe("000001");
    expect(ncm.candidatos.every((c: Structured) => c.codigo_aplicavel === true)).toBe(true);
    expect(ncm.candidatos.map((c: Structured) => c.cclasstrib)).not.toContain("200003"); // engine: not applicable

    const txt = (
      await client.callTool({
        name: "buscar_classificacao",
        arguments: { descricao: "água mineral", data: "2027-01-01" },
      })
    ).structuredContent as Structured;
    expect(txt.sugestoes_ncm.map((x: Structured) => x.codigo)).toContain("22011000");
    expect(txt.candidatos[0].cclasstrib).toBe("000001");

    const alim = (
      await client.callTool({
        name: "buscar_classificacao",
        arguments: { descricao: "produtos destinados à alimentação humana", data: "2027-01-01" },
      })
    ).structuredContent as Structured;
    expect(alim.candidatos.map((c: Structured) => c.cclasstrib)).toContain("200003");
  });
});

const simplesUp = await fetch(`${ENGINE_SIMPLES_URL}/versao`).then(
  (r) => r.ok,
  () => false,
);
const manifestSimples = (
  JSON.parse(readFileSync(new URL("manifest.json", FIXTURES), "utf8")) as {
    simples: { name: string; route: string }[];
  }
).simples;

describe.skipIf(!up || !simplesUp)(
  "golden: reproduzir_calculo com recibos do Simples (rota registrada)",
  () => {
    let ctx: AppContext;
    let client: Client;

    beforeAll(async () => {
      ctx = createContext(
        testConfig({ ENGINE_REGULAR_URL, ENGINE_SIMPLES_URL, ENGINE_TIMEOUT_MS: "30000" }),
        { proberTtlMs: 0 },
      );
      const server = createMcpServer(ctx);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "golden-simples", version: "0.0.0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
    });
    afterAll(async () => client?.close());

    it.each(manifestSimples.map((m) => [m.name, m.route] as const))("%s", async (name, route) => {
      const rota = route.replace(/^POST \/api/, "");
      const input = readFileSync(new URL(`simples/${name}.input.json`, FIXTURES), "utf8");
      const run = await executeCalculation(ctx, {
        engine: "simples",
        route: rota,
        payload: JSON.parse(input),
        aliquotasUsadas: [],
        extractStatusItens: extractObjetosStatus,
        signal: new AbortController().signal,
      });
      expect(run.recibo.motor.rota).toBe(rota);
      const expected = normalizeEngineOutput(
        JSON.parse(readFileSync(new URL(`simples/${name}.engine-output.json`, FIXTURES), "utf8")),
      );
      expect(run.saidaNormalizada).toEqual(expected);
      const r = await client.callTool({ name: "reproduzir_calculo", arguments: { recibo: run.recibo } });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      expect((r.structuredContent as Structured).confere).toBe(true);
    });
  },
);
