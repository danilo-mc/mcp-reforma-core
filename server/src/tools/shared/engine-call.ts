import type { AppContext } from "../../context.ts";
import type { EngineResponse } from "../../engine-client/client.ts";
import { engineCommit, engineRepo } from "../../engine-client/engines.ts";
import { EngineBadResponseError } from "../../engine-client/errors.ts";
import { ENGINE_REPOS, REGULAR_ROUTES, SIMPLES_ROUTES, type EngineName } from "../../engine-client/routes.ts";
import { Metrics } from "../../observability/telemetry.ts";
import { compareOutputs, type DiffEntry } from "../../receipt/diff.ts";
import { canonicalize } from "../../receipt/jcs.ts";
import { normalizeEngineOutput, parseEngineJson } from "../../receipt/normalize.ts";
import { assertNoPersonalData } from "../../receipt/privacy.ts";
import {
  buildReceipt,
  outputSha256,
  rawOutputSha256,
  verifyReceipt,
  type AliquotaUsada,
  type KnownIssue,
  type Motor,
  type Recibo,
  type StatusItem,
} from "../../receipt/receipt.ts";
import { ToolUserError } from "./result.ts";

/** Engines that expose a JSON calculation route. */
export type CalcEngine = Extract<EngineName, "regular" | "simples">;

export const CALC_ROUTES: Record<CalcEngine, string> = {
  regular: REGULAR_ROUTES.calcular,
  simples: SIMPLES_ROUTES.calcular,
};

/**
 * Routes a receipt may be replayed against. `recibo.motor.rota` is caller-controlled, so anything
 * else (other engine endpoints, `../` traversal) is rejected before any request is made.
 */
export const REPRODUCIBLE_ROUTES: Record<CalcEngine, readonly string[]> = {
  regular: [REGULAR_ROUTES.calcular],
  simples: [SIMPLES_ROUTES.calcular, `${SIMPLES_ROUTES.calcular}/nao-assistido`],
};

/** HTTP statuses of the observability routes that carry a meaningful body ("erro global"). */
export const DEFAULT_ACCEPTED_ERROR_STATUSES: readonly number[] = [422];

export interface CalculationRequest<T> {
  engine: CalcEngine;
  /** Exact payload to POST (rates already injected). Must not contain personal data. */
  payload: unknown;
  /** Rates injected into `payload` (empty for dates < 2027 — engine uses its own). */
  aliquotasUsadas: AliquotaUsada[];
  knownIssues?: KnownIssue[];
  /** Extracts the per-item statuses from the engine body, verbatim. */
  extractStatusItens: (body: T) => StatusItem[];
  signal: AbortSignal;
  /** Override the route (defaults to the observability route of the engine). Stored in recibo.motor.rota. */
  route?: string;
  /**
   * Non-2xx statuses that still carry a meaningful engine body (e.g. 422 "erro global" of the
   * observability route) and should produce a receipt instead of an error.
   */
  acceptStatuses?: number[];
}

export interface CalculationRun<T> {
  response: EngineResponse<T>;
  recibo: Recibo;
  /** Normalized view of the engine body (the one hashed in recibo.output_sha256). */
  saidaNormalizada: unknown;
  /** Engine warning headers (e.g. `x-warning-dados-simulados`), verbatim. */
  avisosMotor: Record<string, string>;
}

const WARNING_HEADERS = ["x-warning-dados-simulados"];

/** Generic per-item status extractor for observability routes: `objetos[].{nObj, estadoItem}`. */
export function extractObjetosStatus(body: unknown): StatusItem[] {
  const objetos = (body as { objetos?: unknown } | null)?.objetos;
  if (!Array.isArray(objetos)) return [];
  return objetos.flatMap((o: unknown, i) => {
    const obj = o as { nObj?: unknown; estadoItem?: unknown };
    if (typeof obj?.estadoItem !== "string" || obj.estadoItem === "") return [];
    const n = typeof obj.nObj === "number" && Number.isInteger(obj.nObj) && obj.nObj >= 1 ? obj.nObj : i + 1;
    return [{ item: n, status: obj.estadoItem }];
  });
}

async function motorFor(ctx: AppContext, engine: EngineName): Promise<Motor> {
  let motor = await ctx.prober.motor(engine);
  if (!motor.versao) {
    await ctx.prober.probeAll(true);
    motor = await ctx.prober.motor(engine);
  }
  return motor;
}

/**
 * `recibo.motor` for a response: repository/commit from config, versions from the engine response
 * headers (X-CALC-APP-VERSION / X-CALC-DB-VERSION) when present, otherwise from the version probe.
 */
export async function motorFromResponse(
  ctx: AppContext,
  engine: EngineName,
  headers: Headers | undefined,
  rota?: string,
): Promise<Motor> {
  const app = headers?.get("x-calc-app-version") ?? null;
  const db = headers?.get("x-calc-db-version") ?? null;
  const base: Motor =
    app && db
      ? {
          repositorio: engineRepo(ctx.config, engine),
          commit: engineCommit(ctx.config, engine),
          versao: app,
          versao_base: db,
        }
      : await motorFor(ctx, engine);
  return rota ? { ...base, rota } : base;
}

function warningHeaders(headers: Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of WARNING_HEADERS) {
    const v = headers?.get(h);
    if (v) out[h] = v;
  }
  return out;
}

/** POSTs the canonical JSON text of `payload` (so the hashed input is byte-for-byte what was sent). */
async function postCanonical<T>(
  ctx: AppContext,
  engine: CalcEngine,
  route: string,
  canonical: string,
  signal: AbortSignal,
): Promise<EngineResponse<T>> {
  return ctx.engines[engine].request<T>({
    method: "POST",
    path: route,
    body: canonical,
    contentType: "application/json",
    retryable: true,
    allowHttpErrors: true,
    signal,
  });
}

/**
 * Standard pipeline for every `calcular_*` tool:
 * privacy check → POST the canonical payload to the observability route (retryable once; calc is
 * pure) → metrics → receipt built from the exact payload and the normalized engine output.
 * Throws EngineError subclasses / EngineBadResponseError on non-2xx (except `acceptStatuses`).
 */
export async function executeCalculation<T>(
  ctx: AppContext,
  req: CalculationRequest<T>,
): Promise<CalculationRun<T>> {
  assertNoPersonalData(req.payload);
  const route = req.route ?? CALC_ROUTES[req.engine];
  const canonical = canonicalize(req.payload);
  const response = await postCanonical<T>(ctx, req.engine, route, canonical, req.signal);
  if (!response.ok && !(req.acceptStatuses ?? []).includes(response.status)) {
    throw new EngineBadResponseError(req.engine, route, `HTTP ${response.status}`, response.status);
  }
  const statusItens = response.ok ? req.extractStatusItens(response.body) : [];
  for (const s of statusItens) Metrics.engineItemStatus(req.engine, s.status);
  for (const a of req.aliquotasUsadas) Metrics.rateUsage(a.tributo, a.situacao);

  const raw = response.rawText ?? response.body;
  const motor = await motorFromResponse(ctx, req.engine, response.headers);
  const recibo = buildReceipt({
    engine: motor,
    rota: route,
    payloadSentToEngine: JSON.parse(canonical) as unknown,
    rawEngineResponse: raw,
    aliquotasUsadas: req.aliquotasUsadas,
    statusItens,
    knownIssues: req.knownIssues ?? [],
    now: ctx.now(),
  });
  const parsed = parseEngineJson(raw);
  ctx.logger.info(
    {
      engine: req.engine,
      http: response.status,
      input_sha256: recibo.input_canonical_sha256,
      output_sha256: recibo.output_sha256,
      status: statusItens.map((s) => s.status),
      latencyMs: response.latencyMs,
      motor: recibo.motor.versao,
    },
    "calculation",
  );
  return {
    response,
    recibo,
    saidaNormalizada: parsed ? normalizeEngineOutput(parsed.json) : undefined,
    avisosMotor: warningHeaders(response.headers),
  };
}

export function engineForRepo(repositorio: string): CalcEngine | undefined {
  if (repositorio === ENGINE_REPOS.regular) return "regular";
  if (repositorio === ENGINE_REPOS.simples) return "simples";
  return undefined;
}

export interface ReproductionResult {
  confere: boolean;
  output_sha256_original: string;
  output_sha256_novo: string;
  /**
   * RFC 6901 JSON pointers. With the original engine output: structural diff of the normalized
   * outputs. Without it: differences in `/output_sha256` and `/status_itens` of the receipt.
   */
  diff: DiffEntry[];
  motor_original: Motor;
  motor_atual: Motor;
  /** False when the running engine commit/version differs from the receipt's. */
  versoes_compativeis: boolean;
  avisos: string[];
  /** HTTP status of the re-execution. */
  http_status: number;
  status_itens_novos: StatusItem[];
  /** Normalized output of the re-execution. */
  saida_normalizada: unknown;
}

export interface ReproduceOptions {
  /** Per-item status extractor (default: `objetos[].estadoItem`). */
  extractStatusItens?: (body: unknown) => StatusItem[];
  /** Non-2xx statuses accepted as a valid (comparable) engine answer. Default [422]. */
  acceptStatuses?: readonly number[];
}

/**
 * Generic core of `reproduzir_calculo`: verifies the receipt, re-POSTs `input_canonical` to the same
 * engine route and compares the normalized output hash (and a structural diff when the original
 * output is provided).
 */
export async function reproduceReceipt(
  ctx: AppContext,
  candidate: unknown,
  signal: AbortSignal,
  originalOutput?: unknown,
  opts: ReproduceOptions = {},
): Promise<ReproductionResult> {
  const check = verifyReceipt(candidate);
  if (!check.valido || !check.recibo) {
    throw new ToolUserError("RECIBO_INVALIDO", `Recibo inválido: ${check.erros.join("; ")}`);
  }
  const recibo = check.recibo;
  const engine = engineForRepo(recibo.motor.repositorio);
  if (!engine) {
    throw new ToolUserError("RECIBO_INVALIDO", `Motor do recibo não suportado: ${recibo.motor.repositorio}`);
  }
  assertNoPersonalData(recibo.input_canonical);
  const route = recibo.motor.rota ?? CALC_ROUTES[engine];
  if (!REPRODUCIBLE_ROUTES[engine].includes(route)) {
    throw new ToolUserError("RECIBO_INVALIDO", `Rota do motor não permitida para reprodução: ${route}`);
  }
  const accept = opts.acceptStatuses ?? DEFAULT_ACCEPTED_ERROR_STATUSES;
  const response = await postCanonical(ctx, engine, route, canonicalize(recibo.input_canonical), signal);
  if (!response.ok && !accept.includes(response.status)) {
    throw new EngineBadResponseError(engine, route, `HTTP ${response.status}`, response.status);
  }

  const raw = response.rawText ?? response.body;
  const hashOf = recibo.normalizacao ? outputSha256 : rawOutputSha256;
  const novo = hashOf(raw);
  const extract = opts.extractStatusItens ?? extractObjetosStatus;
  const statusNovos = response.ok ? extract(response.body) : [];
  const motorAtual = await motorFromResponse(ctx, engine, response.headers, route);
  const compat =
    (recibo.motor.commit === null || recibo.motor.commit === motorAtual.commit) &&
    (recibo.motor.versao === null || recibo.motor.versao === motorAtual.versao) &&
    (recibo.motor.versao_base === null || recibo.motor.versao_base === motorAtual.versao_base);
  const avisos: string[] = [];
  if (!compat) {
    avisos.push(
      "A versão do motor em execução difere da registrada no recibo; divergências podem ser esperadas.",
    );
  }
  const parsedNovo = parseEngineJson(raw);
  const saidaNova = parsedNovo ? normalizeEngineOutput(parsedNovo.json) : raw;

  let diff: DiffEntry[];
  if (originalOutput !== undefined) {
    const parsedOrig = parseEngineJson(originalOutput);
    const orig = parsedOrig ? normalizeEngineOutput(parsedOrig.json) : originalOutput;
    diff = compareOutputs(orig, saidaNova).diff;
  } else {
    diff = [];
    if (novo !== recibo.output_sha256) {
      diff.push({ path: "/output_sha256", tipo: "alterado", antes: recibo.output_sha256, depois: novo });
    }
    diff.push(
      ...compareOutputs(recibo.status_itens, statusNovos).diff.map((d) => ({
        ...d,
        path: `/status_itens${d.path}`,
      })),
    );
  }
  // Statuses are compared when they can be extracted from the new output (or an extractor is given).
  const comparaStatus =
    opts.extractStatusItens !== undefined ||
    Array.isArray((response.body as { objetos?: unknown } | null)?.objetos);
  const statusConferem = !comparaStatus || compareOutputs(recibo.status_itens, statusNovos).confere;
  return {
    confere: novo === recibo.output_sha256 && statusConferem,
    output_sha256_original: recibo.output_sha256,
    output_sha256_novo: novo,
    diff,
    motor_original: recibo.motor,
    motor_atual: motorAtual,
    versoes_compativeis: compat,
    avisos,
    http_status: response.status,
    status_itens_novos: statusNovos,
    saida_normalizada: saidaNova,
  };
}
