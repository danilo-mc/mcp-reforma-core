import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { normalizeEngineOutput, normalizedOutputSha256 } from "../../src/receipt/normalize.ts";
import { verifyReceipt } from "../../src/receipt/receipt.ts";
import {
  calcularSimplesTool,
  SIMPLES_CLASSICO_ROUTE,
  SIMPLES_NAO_ASSISTIDO_ROUTE,
  SIMPLES_OPERACAO_ID,
} from "../../src/tools/calcular-simples.ts";
import { reproduceReceipt } from "../../src/tools/shared/engine-call.ts";
import { testConfig } from "../helpers/fixtures.ts";

const ENGINE_SIMPLES_URL = (process.env.ENGINE_SIMPLES_URL ?? "http://localhost:18082/api").replace(
  /\/+$/,
  "",
);
const FIXTURES = new URL("./fixtures/", import.meta.url);

type Dict = Record<string, any>;
interface ManifestEntry {
  name: string;
  route: string;
  http_status: number;
  estados: string[];
}

const manifest = JSON.parse(readFileSync(new URL("manifest.json", FIXTURES), "utf8")) as {
  simples: ManifestEntry[];
};

const up = await fetch(`${ENGINE_SIMPLES_URL}/versao`, { signal: AbortSignal.timeout(3000) }).then(
  (r) => r.ok,
  () => false,
);

const par = (p: Dict | undefined) => (p ? { p_cbs_sn: p.pCBSSN, p_ibs_sn: p.pIBSSN } : undefined);
const parIss = (p: Dict | undefined) =>
  p
    ? {
        ...par(p),
        ...(p.semRedistribuicaoISS ? { sem_redistribuicao_iss: par(p.semRedistribuicaoISS) } : {}),
      }
    : undefined;
const clean = (o: Dict) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** Reverse mapping: engine fixture payload → calcular_simples tool arguments. */
function toolArgs(input: Dict, naoAssistido: boolean): Dict {
  const a = input.aliquotasEfetivas as Dict | undefined;
  return clean({
    data: input.data,
    modo: naoAssistido ? "nao_assistido" : "classico",
    tipo_documento: input.tpDoc,
    crt: input.CRT,
    tp_regime_ibs_cbs: input.tpRegimeIBSCBS,
    tp_ente_gov: input.tpEnteGov,
    nfse: input.opSimpNac
      ? clean({
          op_simp_nac: input.opSimpNac,
          reg_ap_ibs_cbs_sn: input.regApIBSCBSSN,
          reg_ap_trib_sn: input.regApTribSN,
        })
      : undefined,
    aliquotas_efetivas: a
      ? clean({
          fator_r: a.fatorR,
          impedimento_sublimite: a.impedimentoSublimite,
          anexo_i: par(a.anexoI),
          anexo_ii: par(a.anexoII),
          anexo_iii: parIss(a.anexoIII),
          anexo_iv: parIss(a.anexoIV),
          anexo_v: par(a.anexoV),
        })
      : undefined,
    itens: (input.itens as Dict[]).map((it) =>
      clean({
        cativsn: it.cAtivSN,
        cclasstrib: it.cClassTrib,
        ncm: it.ncm,
        nbs: it.nbs,
        base_calculo: it.baseCalculo,
        valor_imposto_seletivo: it.valorImpostoSeletivo,
        p_ibs_sn: it.pIBSSN,
        p_cbs_sn: it.pCBSSN,
        trib_issqn: it.tribISSQN,
        tp_ret_issqn: it.tpRetISSQN,
        tp_bm: it.tpBM,
      }),
    ),
  });
}

/** Payload the tool is expected to send: the fixture minus `id` (fixed) and fields unknown to the contract. */
function expectedPayload(input: Dict): Dict {
  const { pRedutor: _ignored, ...rest } = input;
  return { ...rest, id: SIMPLES_OPERACAO_ID };
}

describe.skipIf(!up)("golden: Simples Nacional (motor direto × calcular_simples)", () => {
  let ctx: AppContext;
  const signal = new AbortController().signal;

  beforeAll(() => {
    ctx = createContext(testConfig({ ENGINE_SIMPLES_URL }), { proberTtlMs: 0 });
  });

  it("manifest lists simples fixtures", () => {
    expect(manifest.simples.length).toBeGreaterThanOrEqual(9);
  });

  for (const fx of manifest.simples) {
    it(fx.name, async () => {
      const input = JSON.parse(
        readFileSync(new URL(`simples/${fx.name}.input.json`, FIXTURES), "utf8"),
      ) as Dict;
      const fixtureRaw = readFileSync(new URL(`simples/${fx.name}.engine-output.json`, FIXTURES), "utf8");
      const naoAssistido = fx.route.endsWith("/nao-assistido");
      const route = naoAssistido ? SIMPLES_NAO_ASSISTIDO_ROUTE : SIMPLES_CLASSICO_ROUTE;

      // 1. Direct engine call with the exact fixture bytes.
      const direct = await fetch(`${ENGINE_SIMPLES_URL}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: readFileSync(new URL(`simples/${fx.name}.input.json`, FIXTURES)),
      });
      const directRaw = await direct.text();
      expect(direct.status).toBe(fx.http_status);
      expect(normalizeEngineOutput(JSON.parse(directRaw))).toEqual(
        normalizeEngineOutput(JSON.parse(fixtureRaw)),
      );

      // 2. Same operation through the tool.
      const args = calcularSimplesTool.inputSchema.parse(toolArgs(input, naoAssistido));
      const result = await calcularSimplesTool.handler(args, ctx, { signal });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as Dict;
      const recibo = out.recibo as Dict;

      expect(out.rota).toBe(route);
      expect(recibo.motor.rota).toBe(route);
      expect(recibo.input_canonical).toEqual(expectedPayload(input));
      expect(out.itens.map((i: Dict) => i.status)).toEqual(fx.estados);
      expect(recibo.status_itens.map((s: Dict) => s.status)).toEqual(fx.estados);

      // Normalized outputs equal (direct vs tool) ⇔ same normalized hash; receipt self-consistent.
      expect(recibo.output_sha256).toBe(normalizedOutputSha256(directRaw));
      expect(verifyReceipt(recibo, { rawEngineResponse: directRaw })).toMatchObject({ valido: true });
      expect(recibo.motor).toMatchObject({
        repositorio: "ReceitaFederal/calculadora-rtc-simples-nacional",
        commit: "a926d5a76095ac0295a6612a9a54db7ffead2396",
        versao: "1.0.2",
        versao_base: "V0073",
      });
      expect(recibo.known_issues.map((k: Dict) => k.id)).toContain("calculadora-rtc-simples-nacional#4");
      for (const a of recibo.aliquotas_usadas as Dict[]) expect(a.situacao).toBe("usuario");

      // Resumo never shows numbers for items without values.
      for (const line of (out.resumo_humano as string).split("\n")) {
        if (/^• Item \d+ — sem valor/.test(line)) expect(line.replace(/^• Item \d+/, "")).not.toMatch(/\d/);
      }

      // 3. Reproduction of the receipt.
      const rep = await reproduceReceipt(ctx, recibo, signal, JSON.parse(directRaw));
      expect(rep.confere).toBe(true);
      expect(rep.diff).toEqual([]);
    });
  }
});
