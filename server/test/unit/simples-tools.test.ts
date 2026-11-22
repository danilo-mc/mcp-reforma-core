import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import {
  buildSimplesPayload,
  calcularSimplesTool,
  SIMPLES_NAO_ASSISTIDO_ROUTE,
} from "../../src/tools/calcular-simples.ts";
import { toolErrorResult, ToolUserError } from "../../src/tools/shared/result.ts";
import { testConfig } from "../helpers/fixtures.ts";
import { sendJson, startMockEngines, type MockEngines } from "../helpers/mock-http.ts";

type Dict = Record<string, any>;
const signal = new AbortController().signal;

const baseSimples = {
  data: "2027-03-15",
  tipo_documento: "55",
  crt: "1",
  itens: [{ cativsn: "01", cclasstrib: "000001", base_calculo: "1000.00", valor_imposto_seletivo: "0.00" }],
};

describe("calcular_simples (unit, mocked engines)", () => {
  let engines: MockEngines;
  let ctx: AppContext;

  beforeAll(async () => {
    engines = await startMockEngines();
    ctx = createContext(
      testConfig({
        ENGINE_REGULAR_URL: engines.regularUrl,
        ENGINE_SIMPLES_URL: engines.simplesUrl,
        MAX_ITEMS: "2",
      }),
      { proberTtlMs: 0 },
    );
  });
  afterAll(async () => {
    await engines.close();
  });
  beforeEach(() => {
    engines.simples.requests.length = 0;
  });

  describe("calcular_simples", () => {
    it("rejects dates before 2027-01-01 without calling the engine", async () => {
      const args = calcularSimplesTool.inputSchema.parse({ ...baseSimples, data: "2026-12-31" });
      const err = await calcularSimplesTool.handler(args, ctx, { signal }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolUserError);
      expect((err as ToolUserError).codigo).toBe("DATA_ANTERIOR_A_2027");
      expect((err as Error).message).toContain("2027");
      expect(toolErrorResult(err).isError).toBe(true);
      expect(engines.simples.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    });

    it("validates the input schema", () => {
      const s = calcularSimplesTool.inputSchema;
      expect(s.safeParse({ ...baseSimples, data: "15/03/2027" }).success).toBe(false);
      expect(s.safeParse({ ...baseSimples, itens: [] }).success).toBe(false);
      expect(s.safeParse({ ...baseSimples, tipo_documento: "NF" }).success).toBe(false);
      expect(s.safeParse({ ...baseSimples, itens: [{ cclasstrib: "1", base_calculo: "1" }] }).success).toBe(
        false,
      );
      expect(
        s.safeParse({ ...baseSimples, itens: [{ cclasstrib: "000001", base_calculo: "1,5" }] }).success,
      ).toBe(false);
      const ok = s.parse({
        ...baseSimples,
        itens: [{ cclasstrib: "000001", base_calculo: 950, p_ibs_sn: 1.25 }],
      });
      expect(ok.modo).toBe("nao_assistido");
      expect(ok.itens[0]!.base_calculo).toBe("950");
      expect(ok.itens[0]!.p_ibs_sn).toBe("1.25");
    });

    it("maps to the engine payload (numbers as strings; route-specific fields)", () => {
      const s = calcularSimplesTool.inputSchema;
      const na = buildSimplesPayload(
        s.parse({
          ...baseSimples,
          aliquotas_efetivas: {
            fator_r: true,
            anexo_i: { p_cbs_sn: "1.1612", p_ibs_sn: "0.0129" },
            anexo_iii: {
              p_cbs_sn: "2.2",
              p_ibs_sn: "0.02",
              sem_redistribuicao_iss: { p_cbs_sn: "1.99", p_ibs_sn: "0.0231" },
            },
          },
          itens: [{ ...baseSimples.itens[0], p_ibs_sn: "9" }],
        }),
      );
      expect(na).toEqual({
        id: "mcp-reforma",
        versao: "3.0.0",
        data: "2027-03-15",
        tpDoc: "55",
        CRT: "1",
        aliquotasEfetivas: {
          fatorR: true,
          anexoI: { pCBSSN: "1.1612", pIBSSN: "0.0129" },
          anexoIII: {
            pCBSSN: "2.2",
            pIBSSN: "0.02",
            semRedistribuicaoISS: { pCBSSN: "1.99", pIBSSN: "0.0231" },
          },
        },
        itens: [
          {
            numero: 1,
            cAtivSN: "01",
            cClassTrib: "000001",
            baseCalculo: "1000.00",
            valorImpostoSeletivo: "0.00",
          },
        ],
      });
      const cl = buildSimplesPayload(
        s.parse({
          ...baseSimples,
          modo: "classico",
          itens: [{ ...baseSimples.itens[0], p_ibs_sn: "1.25", p_cbs_sn: "2.75" }],
        }),
      );
      expect(cl.versao).toBe("2.0.0");
      expect(cl.aliquotasEfetivas).toBeUndefined();
      expect((cl.itens as Dict[])[0]).toMatchObject({ pIBSSN: "1.25", pCBSSN: "2.75" });
    });

    it("enforces MAX_ITEMS and rejects NFS-e in classic mode", async () => {
      const many = calcularSimplesTool.inputSchema.parse({
        ...baseSimples,
        itens: [baseSimples.itens[0], baseSimples.itens[0], baseSimples.itens[0]],
      });
      await expect(calcularSimplesTool.handler(many, ctx, { signal })).rejects.toMatchObject({
        codigo: "ITENS_DEMAIS",
      });
      const nfse = calcularSimplesTool.inputSchema.parse({
        ...baseSimples,
        tipo_documento: "91",
        modo: "classico",
      });
      await expect(calcularSimplesTool.handler(nfse, ctx, { signal })).rejects.toMatchObject({
        codigo: "MODO_INCOMPATIVEL",
      });
    });

    it("passes NAO_CALCULADO through unchanged and shows no numbers for it", async () => {
      engines.simples.setHandler((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        if (u.pathname === "/api/versao")
          return sendJson(res, 200, { versaoApp: "0.9.0", versaoDb: "V0010" });
        if (u.pathname === "/api/calculadora/simples-nacional/atividades") {
          return sendJson(res, 200, [
            { codigo: "01", descricao: "Revenda", rotuloAnexo: "I", tpDocsAdmissiveis: ["55"] },
          ]);
        }
        if (req.method === "POST" && u.pathname === `/api${SIMPLES_NAO_ASSISTIDO_ROUTE}`) {
          return sendJson(res, 200, {
            oper: { data: "2027-03-15", regimeApuracao: "SOMENTE_RECEITA" },
            objetos: [
              {
                nObj: 1,
                estadoItem: "NAO_CALCULADO",
                motivoEstado: { codigo: "REGIME_SOMENTE_RECEITA", descricao: "Texto 123" },
                tribCalc: { vRBSNitem: "1000.00" },
              },
            ],
            total: { vRBSNtot: "1000.00" },
          });
        }
        res.statusCode = 404;
        res.end();
      });
      const r = await calcularSimplesTool.handler(calcularSimplesTool.inputSchema.parse(baseSimples), ctx, {
        signal,
      });
      const out = r.structuredContent as Dict;
      expect(out.itens[0]).toMatchObject({
        status: "NAO_CALCULADO",
        motivo_estado: { codigo: "REGIME_SOMENTE_RECEITA", descricao: "Texto 123" },
        valores: { vRBSNitem: "1000.00" },
        atividade: { codigo: "01", descricao: "Revenda", anexo: "I" },
      });
      expect(out.recibo.status_itens).toEqual([{ item: 1, status: "NAO_CALCULADO" }]);
      expect(out.recibo.motor.rota).toBe(SIMPLES_NAO_ASSISTIDO_ROUTE);
      const linha = (out.resumo_humano as string).split("\n").find((l) => l.startsWith("• Item 1"))!;
      expect(linha.replace("• Item 1", "")).not.toMatch(/\d/);
      expect(out.resumo_humano).not.toContain("1.000");
      const post = engines.simples.requests.find((q) => q.method === "POST")!;
      expect(JSON.parse(post.body)).toEqual(out.recibo.input_canonical);
    });
  });
});
