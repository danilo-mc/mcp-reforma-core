import { z } from "zod";
import type { AppContext } from "../context.ts";
import { SIMPLES_ROUTES } from "../engine-client/routes.ts";
import { MESSAGES, MOTIVO_ESTADO_TEXTS } from "../i18n/pt-BR.ts";
import { knownIssuesFor } from "../receipt/known-issues.ts";
import { ReciboSchema, type AliquotaUsada, type KnownIssue } from "../receipt/receipt.ts";
import { percentPointsToFraction } from "./shared/decimal.ts";
import { executeCalculation, extractObjetosStatus } from "./shared/engine-call.ts";
import { ToolUserError, toolResult } from "./shared/result.ts";
import { buildResumoHumano, type ResumoItem } from "./shared/resumo.ts";
import { DataSchema } from "./shared/schemas.ts";
import { defineTool } from "./types.ts";

/**
 * calcular_simples (SPEC §5.2) — Simples Nacional engine.
 *
 * Contract (docs/upstream/simples-nacional.md, DIVERGENCIAS D4/D5/D10/D11/D12):
 * - two observability routes: `nao-assistido` (recommended; taxpayer rate table `aliquotasEfetivas`
 *   by annex) and the classic one (marked OBSOLETO upstream; rates pIBSSN/pCBSSN per item);
 * - `data` is AAAA-MM-DD, no município; numbers travel as decimal strings;
 * - the engine has NO Simples rates and this project's rates/ has none either: the caller supplies
 *   them (receipt marks them `situacao: "usuario"`);
 * - effective minimum date 2027-01-01 (VSN-015 before that) — rejected here before calling the engine;
 * - statuses include NAO_CALCULADO (+ motivoEstado) and never CALCULO_SIMULADO; passed through verbatim.
 */

export const SIMPLES_DATA_MINIMA = "2027-01-01";

export const SIMPLES_NAO_ASSISTIDO_ROUTE = `${SIMPLES_ROUTES.calcular}/nao-assistido`;
export const SIMPLES_CLASSICO_ROUTE = SIMPLES_ROUTES.calcular;

/** Layout versions sent in `versao` (as in the upstream tests/examples). */
const VERSAO_LEIAUTE = { classico: "2.0.0", nao_assistido: "3.0.0" } as const;
/** Fixed operation id: the engine does not echo it; a constant keeps `input_canonical` reproducible. */
export const SIMPLES_OPERACAO_ID = "mcp-reforma";

export const SIMPLES_KNOWN_ISSUES: KnownIssue[] = knownIssuesFor("simples");

const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,10})?$/;

/** Decimal accepted as string ("950.00") or number (950); always sent to the engine as a string. */
const Decimal = (desc: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
    .pipe(z.string().regex(DECIMAL_RE, "use número decimal com ponto, ex.: 950.00"))
    .describe(desc);

const Codigo = (re: RegExp, msg: string, desc: string) => z.string().trim().regex(re, msg).describe(desc);
const Digito = (desc: string) => Codigo(/^\d{1,2}$/, "use o código numérico do leiaute", desc);

const ParAliquotas = z.object({
  p_cbs_sn: Decimal("Alíquota efetiva de CBS no Simples (pCBSSN), em pontos percentuais. Ex.: 1.1612"),
  p_ibs_sn: Decimal("Alíquota efetiva de IBS no Simples (pIBSSN), em pontos percentuais. Ex.: 0.0129"),
});
const ParComIss = ParAliquotas.extend({
  sem_redistribuicao_iss: ParAliquotas.optional().describe(
    "Par de alíquotas sem redistribuição do ISS (usado quando o ISS fica fora do Simples).",
  ),
});

const AliquotasEfetivas = z
  .object({
    fator_r: z
      .boolean()
      .optional()
      .describe("Fator R atendido (define Anexo III ou V nas atividades sujeitas)"),
    impedimento_sublimite: z
      .boolean()
      .optional()
      .describe("Impedido de recolher IBS no Simples por exceder o sublimite"),
    anexo_i: ParAliquotas.optional(),
    anexo_ii: ParAliquotas.optional(),
    anexo_iii: ParComIss.optional(),
    anexo_iv: ParComIss.optional(),
    anexo_v: ParAliquotas.optional(),
  })
  .describe(
    "Linha de alíquotas efetivas do contribuinte por anexo (modo nao_assistido). O motor do Simples não tem alíquotas próprias: informe as alíquotas efetivas apuradas pelo contribuinte.",
  );

const ItemSimples = z.object({
  cativsn: Codigo(
    /^\d{2}$/,
    "use o código de atividade com 2 dígitos, ex.: 01",
    "Atividade do Simples (cAtivSN), ex.: 01",
  )
    .optional()
    .describe(
      "Código de atividade do Simples Nacional (cAtivSN, 2 dígitos). Define o anexo. Lista: rota de atividades do motor (o resultado traz a descrição).",
    ),
  cclasstrib: Codigo(
    /^\d{6}$/,
    "use o cClassTrib com 6 dígitos",
    "Classificação tributária (cClassTrib), ex.: 000001",
  ),
  ncm: Codigo(/^\d{8}$/, "use a NCM com 8 dígitos", "NCM (8 dígitos), quando mercadoria").optional(),
  nbs: Codigo(/^[\d.]{9,12}$/, "use a NBS com 9 dígitos", "NBS, quando serviço").optional(),
  base_calculo: Decimal("Valor do item / base de cálculo (baseCalculo), ex.: 950.00"),
  valor_imposto_seletivo: Decimal(
    "Valor do Imposto Seletivo do item (valorImpostoSeletivo), ex.: 0.00. Obrigatório nos documentos com CRT.",
  ).optional(),
  p_ibs_sn: Decimal(
    "Modo classico: alíquota efetiva de IBS do item (pIBSSN), em pontos percentuais",
  ).optional(),
  p_cbs_sn: Decimal(
    "Modo classico: alíquota efetiva de CBS do item (pCBSSN), em pontos percentuais",
  ).optional(),
  trib_issqn: Digito("NFS-e: tributação do ISSQN (tribISSQN)").optional(),
  tp_ret_issqn: Digito("NFS-e: tipo de retenção do ISSQN (tpRetISSQN)").optional(),
  tp_bm: Digito("NFS-e: tipo de benefício municipal (tpBM)").optional(),
});

export const calcularSimplesInputSchema = z.object({
  data: DataSchema.describe(
    "Data do fato gerador (AAAA-MM-DD). O motor do Simples só calcula a partir de 2027-01-01.",
  ),
  modo: z
    .enum(["nao_assistido", "classico"])
    .default("nao_assistido")
    .describe(
      "nao_assistido (recomendado): informe aliquotas_efetivas por anexo e o motor escolhe a alíquota de cada item. classico (rota marcada como obsoleta pelo upstream): informe p_ibs_sn/p_cbs_sn em cada item.",
    ),
  tipo_documento: Codigo(
    /^\d{2}$/,
    "use o código do documento com 2 dígitos",
    "Tipo de documento (tpDoc): 55 NF-e, 65 NFC-e, 57 CT-e, 67 CT-e OS, 63 BP-e, 93 BP-e TM, 62 NFCom, 91 NFS-e (só no modo nao_assistido)",
  ),
  crt: Digito(
    "Código de Regime Tributário (CRT), obrigatório exceto na NFS-e: 1 Simples Nacional, 2 Simples com excesso de sublimite, 4 MEI",
  ).optional(),
  tp_regime_ibs_cbs: Digito("Regime de apuração de IBS/CBS (tpRegimeIBSCBS), opcional").optional(),
  tp_ente_gov: Digito("Compra governamental: tipo de ente (tpEnteGov), opcional").optional(),
  nfse: z
    .object({
      op_simp_nac: Digito("Situação perante o Simples Nacional (opSimpNac)"),
      reg_ap_ibs_cbs_sn: Digito("Regime de apuração do IBS/CBS no Simples (regApIBSCBSSN)").optional(),
      reg_ap_trib_sn: Digito("Regime de apuração dos tributos do Simples (regApTribSN)").optional(),
    })
    .optional()
    .describe("Campos da NFS-e (tipo_documento 91, modo nao_assistido)"),
  aliquotas_efetivas: AliquotasEfetivas.optional(),
  itens: z
    .array(ItemSimples)
    .min(1, "informe ao menos 1 item")
    .describe("Itens da operação (máximo definido pelo servidor, padrão 200)"),
});
export type CalcularSimplesInput = z.infer<typeof calcularSimplesInputSchema>;

// ---- engine payload mapping ---------------------------------------------------------------

type Dict = Record<string, unknown>;

function compact(obj: Dict): Dict {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function par(p: z.infer<typeof ParAliquotas> | undefined): Dict | undefined {
  return p ? { pCBSSN: p.p_cbs_sn, pIBSSN: p.p_ibs_sn } : undefined;
}

function parComIss(p: z.infer<typeof ParComIss> | undefined): Dict | undefined {
  return p ? compact({ ...par(p), semRedistribuicaoISS: par(p.sem_redistribuicao_iss) }) : undefined;
}

/** Maps the tool input to the exact engine payload (no rounding, strings preserved). */
export function buildSimplesPayload(args: CalcularSimplesInput): Dict {
  const classico = args.modo === "classico";
  const itens = args.itens.map((it, i) =>
    compact({
      numero: i + 1,
      cAtivSN: it.cativsn,
      cClassTrib: it.cclasstrib,
      ncm: it.ncm,
      nbs: it.nbs,
      baseCalculo: it.base_calculo,
      valorImpostoSeletivo: it.valor_imposto_seletivo,
      ...(classico
        ? { pIBSSN: it.p_ibs_sn, pCBSSN: it.p_cbs_sn }
        : { tribISSQN: it.trib_issqn, tpRetISSQN: it.tp_ret_issqn, tpBM: it.tp_bm }),
    }),
  );
  const a = args.aliquotas_efetivas;
  return compact({
    id: SIMPLES_OPERACAO_ID,
    versao: VERSAO_LEIAUTE[args.modo],
    data: args.data,
    tpDoc: args.tipo_documento,
    CRT: args.crt,
    tpRegimeIBSCBS: args.tp_regime_ibs_cbs,
    tpEnteGov: args.tp_ente_gov,
    ...(classico
      ? {}
      : {
          opSimpNac: args.nfse?.op_simp_nac,
          regApIBSCBSSN: args.nfse?.reg_ap_ibs_cbs_sn,
          regApTribSN: args.nfse?.reg_ap_trib_sn,
          aliquotasEfetivas: a
            ? compact({
                fatorR: a.fator_r,
                impedimentoSublimite: a.impedimento_sublimite,
                anexoI: par(a.anexo_i),
                anexoII: par(a.anexo_ii),
                anexoIII: parComIss(a.anexo_iii),
                anexoIV: parComIss(a.anexo_iv),
                anexoV: par(a.anexo_v),
              })
            : undefined,
        }),
    itens,
  });
}

// ---- engine response ------------------------------------------------------------------------

interface ErroItem {
  type?: string;
  title?: string;
  code?: string;
  pointer?: string;
  detail?: string;
}
interface TribCalc {
  vIBSSN?: string;
  vCBSSN?: string;
  IS?: { valor?: string };
  totalItem?: string;
  [k: string]: unknown;
}
interface ObjetoSimples {
  nObj: number;
  estadoItem: string;
  motivoEstado?: { codigo?: string; descricao?: string };
  tribCalc?: TribCalc;
  erros?: ErroItem[];
}
interface ResolucaoItem {
  numero: number;
  cAtivSN?: string | null;
  anexoAplicado?: string | null;
  pIBSSN?: string | null;
  pCBSSN?: string | null;
  motivo?: string;
}
export interface SimplesResponse {
  oper?: Dict;
  resolucaoAliquotas?: { itens?: ResolucaoItem[]; avisos?: string[]; [k: string]: unknown };
  objetos?: ObjetoSimples[];
  total?: Record<string, string | undefined>;
  /** HTTP 422 problem+json (erro global). */
  errors?: ErroItem[];
  title?: string;
  detail?: string;
  status?: number;
}

interface Atividade {
  codigo: string;
  descricao: string;
  rotuloAnexo?: string;
  disponivel?: boolean;
  tpDocsAdmissiveis?: string[];
}

/** Best-effort catalogue of activities for the date (validation/help text only; never blocks). */
async function fetchAtividades(
  ctx: AppContext,
  data: string,
  signal: AbortSignal,
): Promise<Atividade[] | null> {
  try {
    const res = await ctx.engines.simples.getJson<Atividade[]>(
      SIMPLES_ROUTES.atividades,
      { data },
      { signal, allowHttpErrors: true, timeoutMs: 5000 },
    );
    return res.ok && Array.isArray(res.body) ? res.body : null;
  } catch {
    return null;
  }
}

const num = (s: string | undefined | null): number | undefined => {
  if (typeof s !== "string" || !DECIMAL_RE.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** pp string → fraction (receipt `valor` is a 0..1 fraction), without float noise. */
function ppToFraction(pp: string | null | undefined): number | undefined {
  const n = num(pp);
  if (n === undefined || n < 0 || n > 100) return undefined;
  return percentPointsToFraction(pp!);
}

const FONTE_USUARIO =
  "Informada pelo usuário (alíquota efetiva do Simples Nacional; o motor não tem alíquotas próprias)";

/** Rates effectively used, as reported by the engine (nao-assistido) or sent per item (classico). */
export function simplesAliquotasUsadas(
  args: CalcularSimplesInput,
  body: SimplesResponse,
  hoje: string,
): AliquotaUsada[] {
  const pares: { cbs?: string | null; ibs?: string | null; anexo?: string | null }[] =
    args.modo === "classico"
      ? args.itens.map((it) => ({ cbs: it.p_cbs_sn, ibs: it.p_ibs_sn }))
      : (body?.resolucaoAliquotas?.itens ?? []).map((r) => ({
          cbs: r.pCBSSN,
          ibs: r.pIBSSN,
          anexo: r.anexoAplicado,
        }));
  const out: AliquotaUsada[] = [];
  const seen = new Set<string>();
  for (const p of pares) {
    for (const [tributo, valorPp] of [
      ["CBS", p.cbs],
      ["IBS", p.ibs],
    ] as const) {
      const valor = ppToFraction(valorPp);
      if (valor === undefined) continue;
      const key = `${tributo}|${valor}|${p.anexo ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        tributo,
        valor,
        vigencia: `${args.data}/${args.data}`,
        fonte: `${FONTE_USUARIO}${p.anexo ? ` — Anexo ${p.anexo}` : ""}${tributo === "IBS" ? " — pIBSSN (IBS unificado)" : " — pCBSSN"}`,
        url_fonte: "",
        data_fonte: hoje,
        situacao: "usuario",
        rates_file_version: null,
      });
    }
  }
  return out;
}

function valoresItem(t: TribCalc | undefined): ResumoItem["valores"] {
  if (!t) return undefined;
  return { CBS: t.vCBSSN, IBS: t.vIBSSN, IS: t.IS?.valor, Total: t.totalItem };
}

function motivoTexto(codigo: string | undefined): string {
  return (codigo && MOTIVO_ESTADO_TEXTS[codigo]) || "motivo indicado pelo motor no campo motivoEstado";
}

const ErroMotorOut = z.object({}).catchall(z.unknown());

export const calcularSimplesOutputSchema = z.object({
  resumo_humano: z.string(),
  modo: z.enum(["nao_assistido", "classico"]),
  rota: z.string(),
  http_status: z.number(),
  operacao: z.record(z.string(), z.unknown()).nullable(),
  resolucao_aliquotas: z.record(z.string(), z.unknown()).nullable(),
  itens: z.array(
    z.object({
      item: z.number(),
      /** Engine status, verbatim (CALCULADO, NAO_CALCULADO, INCONSISTENCIA_ENTRADA, NAO_IMPLEMENTADO, FALHA_TECNICA). */
      status: z.string(),
      motivo_estado: z
        .object({ codigo: z.string().optional(), descricao: z.string().optional(), explicacao: z.string() })
        .optional(),
      atividade: z
        .object({ codigo: z.string(), descricao: z.string().nullable(), anexo: z.string().nullable() })
        .nullable(),
      resolucao_aliquota: z.record(z.string(), z.unknown()).nullable(),
      /** Engine `tribCalc` verbatim (decimal strings). */
      valores: z.record(z.string(), z.unknown()).nullable(),
      erros: z.array(ErroMotorOut),
    }),
  ),
  totais: z.record(z.string(), z.unknown()).nullable(),
  erros_globais: z.array(ErroMotorOut),
  versao_motor_cabecalhos: z.object({ app: z.string().nullable(), base: z.string().nullable() }),
  avisos: z.array(z.string()),
  recibo: ReciboSchema,
});

// ---- tool -------------------------------------------------------------------------------------

export const calcularSimplesTool = defineTool({
  name: "calcular_simples",
  title: "Calcular IBS/CBS no Simples Nacional",
  description:
    "Calcula IBS e CBS de uma operação de empresa do Simples Nacional com o motor oficial da Receita Federal (calculadora-rtc-simples-nacional). Só aceita datas a partir de 2027-01-01. O motor NÃO tem alíquotas próprias do Simples: informe as alíquotas efetivas do contribuinte (em pontos percentuais) — no modo nao_assistido (recomendado) em aliquotas_efetivas por anexo; no modo classico em p_ibs_sn/p_cbs_sn por item. Cada item precisa de cclasstrib, base_calculo e, em geral, da atividade cativsn (define o anexo). Devolve status por item (CALCULADO, NAO_CALCULADO, INCONSISTENCIA_ENTRADA, NAO_IMPLEMENTADO, FALHA_TECNICA) sem reinterpretar, valores do motor como texto e um recibo verificável.",
  inputSchema: calcularSimplesInputSchema,
  outputSchema: calcularSimplesOutputSchema,
  handler: async (args, ctx, extra) => {
    if (args.data < SIMPLES_DATA_MINIMA) {
      throw new ToolUserError(
        "DATA_ANTERIOR_A_2027",
        `O motor oficial do Simples Nacional só calcula operações a partir de 01/01/2027 (antes disso nenhum tipo de documento está habilitado no motor). A data informada foi ${args.data}. Informe uma data igual ou posterior a 2027-01-01. Nenhum cálculo foi feito.`,
      );
    }
    if (args.itens.length > ctx.config.MAX_ITEMS) {
      throw new ToolUserError("ITENS_DEMAIS", `Máximo de ${ctx.config.MAX_ITEMS} itens por cálculo.`);
    }
    if (args.modo === "classico" && args.tipo_documento === "91") {
      throw new ToolUserError(
        "MODO_INCOMPATIVEL",
        "A NFS-e (tipo_documento 91) só é atendida no modo nao_assistido do motor do Simples Nacional.",
      );
    }

    const avisos: string[] = [];
    if (args.modo === "classico") {
      avisos.push(
        "Modo clássico: a rota usada está marcada como obsoleta pelo motor oficial; prefira o modo nao_assistido.",
      );
      const semAliquota = args.itens.filter((it) => it.p_ibs_sn === undefined || it.p_cbs_sn === undefined);
      if (semAliquota.length > 0) {
        avisos.push(
          "Há item sem alíquotas efetivas (p_ibs_sn/p_cbs_sn). O motor do Simples não tem alíquotas próprias e não calculará esse item.",
        );
      }
      if (args.aliquotas_efetivas) avisos.push("aliquotas_efetivas é ignorado no modo classico.");
    } else {
      if (args.itens.some((it) => it.p_ibs_sn !== undefined || it.p_cbs_sn !== undefined)) {
        avisos.push(
          "p_ibs_sn/p_cbs_sn por item são ignorados no modo nao_assistido; use aliquotas_efetivas.",
        );
      }
      if (!args.aliquotas_efetivas) {
        avisos.push(
          "Nenhuma linha de alíquotas efetivas (aliquotas_efetivas) foi informada: o motor só aceita a operação sem ela quando o contribuinte apura IBS/CBS fora do Simples (somente receita).",
        );
      }
    }

    const payload = buildSimplesPayload(args);
    const route = args.modo === "classico" ? SIMPLES_CLASSICO_ROUTE : SIMPLES_NAO_ASSISTIDO_ROUTE;
    const [atividades, run] = await Promise.all([
      fetchAtividades(ctx, args.data, extra.signal),
      executeCalculation<SimplesResponse>(ctx, {
        engine: "simples",
        route,
        payload,
        aliquotasUsadas: [],
        knownIssues: knownIssuesFor("simples"),
        extractStatusItens: extractObjetosStatus,
        acceptStatuses: [422],
        signal: extra.signal,
      }),
    ]);
    const body = run.response.body ?? {};
    const hoje = ctx.now().toISOString().slice(0, 10);
    const aliquotas = simplesAliquotasUsadas(args, body, hoje);
    // Rates are only known after the engine resolved them (nao-assistido); attach them to the receipt.
    const recibo = aliquotas.length > 0 ? { ...run.recibo, aliquotas_usadas: aliquotas } : run.recibo;

    const porCodigo = new Map((atividades ?? []).map((a) => [a.codigo, a]));
    const itens = (body.objetos ?? []).map((o) => {
      const entrada = args.itens[o.nObj - 1];
      const atv = entrada?.cativsn ? porCodigo.get(entrada.cativsn) : undefined;
      if (entrada?.cativsn && atividades && !atv) {
        avisos.push(
          `A atividade cativsn ${entrada.cativsn} do item ${o.nObj} não consta da lista de atividades do motor para a data.`,
        );
      } else if (atv?.tpDocsAdmissiveis && !atv.tpDocsAdmissiveis.includes(args.tipo_documento)) {
        avisos.push(
          `A atividade ${atv.codigo} do item ${o.nObj} não é admitida no documento ${args.tipo_documento} (admitidos: ${atv.tpDocsAdmissiveis.join(", ")}).`,
        );
      }
      return {
        item: o.nObj,
        status: o.estadoItem,
        ...(o.motivoEstado
          ? { motivo_estado: { ...o.motivoEstado, explicacao: motivoTexto(o.motivoEstado.codigo) } }
          : {}),
        atividade: atv
          ? { codigo: atv.codigo, descricao: atv.descricao, anexo: atv.rotuloAnexo ?? null }
          : entrada?.cativsn
            ? { codigo: entrada.cativsn, descricao: null, anexo: null }
            : null,
        resolucao_aliquota: body.resolucaoAliquotas?.itens?.find((r) => r.numero === o.nObj) ?? null,
        valores: o.tribCalc ?? null,
        erros: o.erros ?? [],
      };
    });
    for (const a of body.resolucaoAliquotas?.avisos ?? []) avisos.push(`Motor: ${a}`);

    const http = run.response.status;
    const errosGlobais = http === 422 ? (body.errors ?? []) : [];
    const appHdr = run.response.headers.get("x-calc-app-version");
    const dbHdr = run.response.headers.get("x-calc-db-version");
    if (
      (appHdr && recibo.motor.versao && appHdr !== recibo.motor.versao) ||
      (dbHdr && recibo.motor.versao_base && dbHdr !== recibo.motor.versao_base)
    ) {
      avisos.push("A versão informada nos cabeçalhos da resposta difere da versão consultada do motor.");
    }

    const titulo = `Cálculo no Simples Nacional (motor oficial, modo ${args.modo === "classico" ? "clássico" : "não assistido"}) para ${args.data}.`;
    let resumo: string;
    if (http === 422) {
      const codigos = errosGlobais.map((e) => e.code).filter(Boolean);
      resumo = [
        titulo,
        `O motor recusou a operação inteira (erro global${codigos.length ? `: ${codigos.join(", ")}` : ""}). Nenhum valor foi calculado. Use explicar_status com o código para entender o que corrigir.`,
        MESSAGES.disclaimer,
      ].join("\n");
    } else {
      const t = body.total;
      resumo = buildResumoHumano({
        titulo,
        itens: itens.map((i) => ({
          item: i.item,
          status: i.status,
          descricao: i.atividade?.descricao ? `atividade ${i.atividade.codigo}` : undefined,
          valores: valoresItem(i.valores ?? undefined),
        })),
        totais: t ? { CBS: t.vCBSSNtot, IBS: t.vIBSSNtot, IS: t.totalIs, Total: t.totalTributos } : null,
        avisos: [
          ...itens
            .filter((i) => i.motivo_estado)
            .map((i) => `Item ${i.item} não calculado: ${i.motivo_estado!.explicacao}.`),
          aliquotas.length > 0
            ? "Alíquotas efetivas informadas pelo usuário (fonte: usuário); o motor do Simples não tem alíquotas próprias."
            : "",
        ].filter(Boolean),
      });
    }

    return toolResult({
      resumo_humano: resumo,
      modo: args.modo,
      rota: route,
      http_status: http,
      operacao: body.oper ?? null,
      resolucao_aliquotas: body.resolucaoAliquotas ?? null,
      itens,
      totais: body.total ?? null,
      erros_globais: errosGlobais,
      versao_motor_cabecalhos: { app: appHdr, base: dbHdr },
      avisos,
      recibo,
    });
  },
});
