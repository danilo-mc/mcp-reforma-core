import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContext, type AppContext } from "../../src/context.ts";
import { EngineBadResponseError } from "../../src/engine-client/errors.ts";
import { PersonalDataError } from "../../src/receipt/privacy.ts";
import { executeCalculation, reproduceReceipt } from "../../src/tools/shared/engine-call.ts";
import { ToolUserError } from "../../src/tools/shared/result.ts";
import { testConfig } from "../helpers/fixtures.ts";
import { sendJson, startMockEngines, type MockEngines } from "../helpers/mock-http.ts";

interface FakeBody {
  itens: { numero: number; status: string }[];
}

describe("executeCalculation / reproduceReceipt (generic pipeline)", () => {
  let engines: MockEngines;
  let ctx: AppContext;
  const signal = new AbortController().signal;
  const payload = { dataHoraEmissao: "2026-06-01", itens: [{ cst: "000" }, { cst: "200" }] };
  const extract = (b: FakeBody) => b.itens.map((i) => ({ item: i.numero, status: i.status }));

  beforeAll(async () => {
    engines = await startMockEngines();
    ctx = createContext(
      testConfig({
        ENGINE_REGULAR_URL: engines.regularUrl,
        ENGINE_SIMPLES_URL: engines.simplesUrl,
      }),
      { proberTtlMs: 0 },
    );
  });
  afterAll(async () => engines.close());

  it("posts the exact payload and returns a verifiable receipt with statuses", async () => {
    const run = await executeCalculation<FakeBody>(ctx, {
      engine: "regular",
      payload,
      aliquotasUsadas: [],
      extractStatusItens: extract,
      signal,
    });
    const post = engines.regular.requests.find((r) => r.method === "POST")!;
    expect(JSON.parse(post.body)).toEqual(payload);
    expect(post.headers.traceparent).toBeDefined();
    expect(run.recibo.status_itens).toEqual([
      { item: 1, status: "CALCULADO" },
      { item: 2, status: "NAO_IMPLEMENTADO" },
    ]);
    expect(run.recibo.motor).toMatchObject({ versao: "1.6.1", versao_base: "V0059" });
    expect(run.recibo.input_canonical).toEqual(payload);

    const rep = await reproduceReceipt(ctx, run.recibo, signal, run.response.body);
    expect(rep).toMatchObject({ confere: true, versoes_compativeis: true, diff: [] });
  });

  it("refuses to replay a receipt against a route outside the allowlist", async () => {
    const run = await executeCalculation<FakeBody>(ctx, {
      engine: "regular",
      payload,
      aliquotasUsadas: [],
      extractStatusItens: extract,
      signal,
    });
    for (const rota of [
      "/calculadora/xml/generate",
      "/calculadora/observabilidade/regime-geral/../../xml/validate",
    ]) {
      const forged = structuredClone(run.recibo);
      forged.motor.rota = rota;
      const before = engines.regular.requests.length;
      await expect(reproduceReceipt(ctx, forged, signal)).rejects.toBeInstanceOf(ToolUserError);
      expect(engines.regular.requests.length).toBe(before);
    }
  });

  it("reproduction detects tampered receipts and diverging outputs", async () => {
    const run = await executeCalculation<FakeBody>(ctx, {
      engine: "regular",
      payload,
      aliquotasUsadas: [],
      extractStatusItens: extract,
      signal,
    });
    const tampered = structuredClone(run.recibo) as { input_canonical: typeof payload };
    tampered.input_canonical.itens.push({ cst: "x" });
    await expect(reproduceReceipt(ctx, tampered, signal)).rejects.toBeInstanceOf(ToolUserError);

    engines.regular.setHandler((_req, res) => sendJson(res, 200, { itens: [], total: 0 }));
    // re-probe hits the same handler; keep versao route working
    const rep = await reproduceReceipt(ctx, run.recibo, signal, run.response.body);
    expect(rep.confere).toBe(false);
    expect(rep.diff.map((d) => d.path)).toContain("/total");
  });

  it("refuses personal data before calling the engine and maps non-2xx", async () => {
    const before = engines.regular.requests.length;
    await expect(
      executeCalculation(ctx, {
        engine: "regular",
        payload: { cpf: "52998224725" },
        aliquotasUsadas: [],
        extractStatusItens: () => [],
        signal,
      }),
    ).rejects.toBeInstanceOf(PersonalDataError);
    expect(engines.regular.requests.length).toBe(before);

    engines.regular.setHandler((_req, res) => sendJson(res, 400, { erro: "x" }));
    await expect(
      executeCalculation(ctx, {
        engine: "regular",
        payload: {},
        aliquotasUsadas: [],
        extractStatusItens: () => [],
        signal,
      }),
    ).rejects.toBeInstanceOf(EngineBadResponseError);
  });
});
