import { z } from "zod";
import type { AppContext } from "../context.ts";
import { REGULAR_ROUTES } from "../engine-client/routes.ts";
import { MESSAGES } from "../i18n/pt-BR.ts";
import { INJECTION_START_DATE, requireRates } from "../rates/loader.ts";
import type { UsableRateEntry } from "../rates/schema.ts";
import { knownIssuesFor } from "../receipt/known-issues.ts";
import { ReciboSchema, type AliquotaUsada } from "../receipt/receipt.ts";
import { NON_NUMERIC_STATUSES } from "../status.ts";
import { DecimalInputSchema, fractionToPercentPoints, percentPointsToFraction } from "./shared/decimal.ts";
import { executeCalculation, extractObjetosStatus } from "./shared/engine-call.ts";
import { engineGlobalErrorResult, mapErrosMotor } from "./shared/engine-errors.ts";
import { buildResumoHumano, formatPercentual } from "./shared/resumo.ts";
import { toolResult, ToolUserError } from "./shared/result.ts";
import { DataSchema, itemsLimit, MunicipioIbgeSchema, ProdutoIsSchema, UfSchema } from "./shared/schemas.ts";
import { defineTool } from "./types.ts";

/** Fixed offset used to build `dhFatoGerador` (horário de Brasília). */
export const FUSO_FATO_GERADOR = "-03:00";
export const FONTE_REFERENCIA_MOTOR = "motor (alíquotas de referência internas)";
export const FONTE_USUARIO = "usuario";

const digits = (s: string) => s.replace(/[.\-\s]/g, "");

const NcmSchema = z
  .string()
  .transform(digits)
  .pipe(z.string().regex(/^\d{8}$/, "NCM deve ter 8 dígitos"))
  .describe("Código NCM da mercadoria (8 dígitos, pontos opcionais), ex.: 2202.10.00");
const NbsSchema = z
  .string()
  .transform(digits)
  .pipe(z.string().regex(/^\d{9}$/, "NBS deve ter 9 dígitos"))
  .describe("Código NBS do serviço (9 dígitos, pontos opcionais), ex.: 1.1101.10.00");
const CstSchema = z
  .string()
  .regex(/^\d{3}$/, "CST deve ter 3 dígitos")
  .describe("CST do IBS/CBS (3 dígitos), ex.: 000");
const CClassTribSchema = z
  .string()
  .regex(/^\d{6}$/, "cClassTrib deve ter 6 dígitos")
  .describe("Código de classificação tributária (cClassTrib, 6 dígitos), ex.: 000001");
const Valor = DecimalInputSchema;
const FracaoSchema = DecimalInputSchema.refine(
  (v) => Number(v) <= 1,
  "informe a alíquota como fração (0 a 1)",
);

const ImpostoSeletivoInSchema = z
  .object({
    cst: CstSchema.describe("CST do Imposto Seletivo (3 dígitos)"),
    cclasstrib: CClassTribSchema.describe("cClassTrib do Imposto Seletivo (6 dígitos)"),
    valor: Valor.describe("Base de cálculo do Imposto Seletivo em reais"),
    quantidade: Valor.optional().describe("Quantidade tributável do IS"),
    unidade: z.string().min(1).max(6).optional().describe("Unidade tributável do IS, ex.: LT"),
    imposto_informado: Valor.optional().describe("IS já informado pelo contribuinte, em reais (opcional)"),
    produto: ProdutoIsSchema.optional().describe(
      "Produto do IS no arquivo de alíquotas (ex.: bebidas_acucaradas); obrigatório com cenario_aliquotas 'vigente' a partir de 2027",
    ),
  })
  .describe("Grupo do Imposto Seletivo (só para produtos sujeitos ao IS)");

const ItemSchema = z
  .object({
    descricao: z
      .string()
      .max(200)
      .optional()
      .describe("Descrição livre do item (só para exibição; não é enviada ao motor)"),
    ncm: NcmSchema.optional(),
    nbs: NbsSchema.optional(),
    cst: CstSchema,
    cclasstrib: CClassTribSchema,
    valor: Valor.describe("Base de cálculo do IBS/CBS em reais (valor da operação), ex.: 5000.00"),
    quantidade: Valor.optional().describe("Quantidade (opcional)"),
    unidade: z.string().min(1).max(6).optional().describe("Unidade de medida (opcional), ex.: UN"),
    imposto_seletivo: ImpostoSeletivoInSchema.optional(),
  })
  .refine((i) => !(i.ncm && i.nbs), { message: "informe NCM ou NBS, não ambos", path: ["nbs"] });

const CenarioExplicitoSchema = z
  .object({
    cbs: FracaoSchema.describe("Alíquota da CBS como FRAÇÃO decimal (0.088 = 8,8%)"),
    ibs_uf: FracaoSchema.describe("Alíquota do IBS estadual como FRAÇÃO decimal (0.0885 = 8,85%)"),
    ibs_mun: FracaoSchema.describe("Alíquota do IBS municipal como FRAÇÃO decimal"),
    is: z
      .object({
        ad_valorem: FracaoSchema.optional().describe(
          "Alíquota ad valorem do IS como FRAÇÃO decimal (0.13 = 13%)",
        ),
        ad_rem: Valor.optional().describe("Alíquota ad rem do IS em reais por unidade tributável"),
      })
      .optional()
      .describe("Alíquotas do Imposto Seletivo (necessárias se algum item tiver imposto_seletivo)"),
  })
  .describe(
    "Cenário explícito (uso avançado): alíquotas informadas pelo usuário, como FRAÇÕES decimais (0.088 = 8,8%; o servidor converte para os pontos percentuais do motor sem arredondar). Só para datas a partir de 2027. O recibo marca fonte 'usuario'.",
  );

export const CalcularRegimeRegularInputBase = {
  data_fato_gerador: DataSchema.describe("Data do fato gerador (AAAA-MM-DD)"),
  hora: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "use HH:MM ou HH:MM:SS")
    .optional()
    .describe("Hora do fato gerador no horário de Brasília (opcional; padrão 00:00:00)"),
  uf: UfSchema,
  municipio_ibge: MunicipioIbgeSchema,
  modelo_documento: z
    .number()
    .int()
    .min(1)
    .max(999)
    .optional()
    .describe(
      "Modelo do documento fiscal (opcional), ex.: 55 = NF-e, 65 = NFC-e; ativa validações por documento",
    ),
  cenario_aliquotas: z
    .union([z.literal("vigente"), CenarioExplicitoSchema])
    .default("vigente")
    .describe(
      "'vigente' (padrão): em 2026 o motor usa suas alíquotas de referência internas; a partir de 2027 o servidor injeta as alíquotas do arquivo versionado rates/ (se ainda não validadas, nenhum cálculo é feito). Ou um objeto com alíquotas explícitas (frações decimais).",
    ),
};

export type CalcularRegimeRegularArgs = {
  data_fato_gerador: string;
  hora?: string | undefined;
  uf: string;
  municipio_ibge: string;
  modelo_documento?: number | undefined;
  itens: z.infer<typeof ItemSchema>[];
  cenario_aliquotas: "vigente" | z.infer<typeof CenarioExplicitoSchema>;
};

// ---- engine response (only the fields we read; everything else passes through untouched) ----
interface GrupoIBSCBS {
  vBC?: string;
  gIBSUF?: { pIBSUF?: string; vIBSUF?: string };
  gIBSMun?: { pIBSMun?: string; vIBSMun?: string };
  vIBS?: string;
  gCBS?: { pCBS?: string; vCBS?: string };
}
interface ObjetoMotor {
  nObj?: number;
  estadoItem?: string;
  erros?: unknown[];
  tribCalc?: { IBSCBS?: { gIBSCBS?: GrupoIBSCBS }; IS?: { vIS?: string } };
}
export interface RespostaRegular {
  objetos?: ObjetoMotor[];
  total?: {
    tribCalc?: {
      IBSCBSTot?: {
        vBCIBSCBS?: string;
        gIBS?: { gIBSUF?: { vIBSUF?: string }; gIBSMun?: { vIBSMun?: string }; vIBS?: string };
        gCBS?: { vCBS?: string };
      };
      ISTot?: { vIS?: string };
    };
  };
}

const ValoresOut = z.object({
  base_calculo: z.string().nullable(),
  cbs: z.string().nullable(),
  ibs_uf: z.string().nullable(),
  ibs_mun: z.string().nullable(),
  ibs: z.string().nullable(),
  is: z.string().nullable(),
});
type Valores = z.infer<typeof ValoresOut>;

const ErroMotorOut = z.object({
  codigo: z.string().nullable(),
  titulo: z.string().nullable(),
  detalhe: z.string().nullable(),
  campo: z.string().nullable(),
});

export const calcularRegimeRegularOutputSchema = z.object({
  data_fato_gerador: z.string(),
  dh_fato_gerador: z.string(),
  uf: z.string(),
  municipio_ibge: z.string(),
  cenario_aliquotas: z.enum(["referencia_motor", "vigente", "usuario"]),
  itens: z.array(
    z.object({
      item: z.number(),
      descricao: z.string().nullable(),
      status: z.string(),
      /** Engine values (decimal strings, verbatim). Null for NAO_IMPLEMENTADO / INCONSISTENCIA_ENTRADA / FALHA_TECNICA. */
      valores: ValoresOut.nullable(),
      erros: z.array(ErroMotorOut),
      tributos_motor: z.unknown().optional(),
    }),
  ),
  totais: ValoresOut,
  aliquotas_usadas: z.array(z.unknown()),
  avisos: z.array(z.string()),
  avisos_motor: z.record(z.string(), z.string()),
  known_issues: z.array(z.unknown()),
  /** Engine response body exactly as received (parsed JSON). */
  resposta_motor: z.unknown(),
  recibo: ReciboSchema,
  resumo_humano: z.string(),
});

const vigencia = (d: string) => `${d}/${d}`;
const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));

export function dhFatoGerador(data: string, hora?: string): string {
  const h = hora ? (hora.length === 5 ? `${hora}:00` : hora) : "00:00:00";
  return `${data}T${h}${FUSO_FATO_GERADOR}`;
}

interface AliquotasPP {
  cbs: number;
  ibsEstadual: number;
  ibsMunicipal: number;
  impostoSeletivo?: { adValorem?: number; adRem?: number };
}

interface RatesPlan {
  modo: "referencia_motor" | "vigente" | "usuario";
  /** Per-item rates to inject (index-aligned with itens); undefined = do not inject. */
  porItem: (AliquotasPP | undefined)[];
  aliquotasUsadas: AliquotaUsada[];
}

function aliquotaUsuario(
  tributo: AliquotaUsada["tributo"],
  valor: number,
  data: string,
  hoje: string,
  componente?: "ad_valorem" | "ad_rem",
): AliquotaUsada {
  return {
    tributo,
    valor,
    ...(componente ? { componente } : {}),
    vigencia: vigencia(data),
    fonte: FONTE_USUARIO,
    url_fonte: "",
    data_fonte: hoje,
    situacao: "usuario",
    rates_file_version: null,
  };
}

/** Decides which rates go to the engine (none in 2026; rates/ or user scenario from 2027). */
export function planRates(ctx: AppContext, args: CalcularRegimeRegularArgs): RatesPlan {
  const data = args.data_fato_gerador;
  const cen = args.cenario_aliquotas;
  if (data < INJECTION_START_DATE) {
    if (cen !== "vigente") {
      throw new ToolUserError(
        "CENARIO_INVALIDO",
        "Para datas anteriores a 2027-01-01 o motor oficial usa obrigatoriamente as suas alíquotas de referência internas e recusa alíquotas informadas. Use cenario_aliquotas 'vigente'.",
      );
    }
    return { modo: "referencia_motor", porItem: args.itens.map(() => undefined), aliquotasUsadas: [] };
  }
  const temIs = args.itens.some((i) => i.imposto_seletivo);

  if (cen === "vigente") {
    const snap = ctx.rates.get();
    const base = requireRates(snap, data, { uf: args.uf, municipio_ibge: args.municipio_ibge });
    const pick = (t: "CBS" | "IBS_UF" | "IBS_MUN") => base.selection.aplicaveis.find((e) => e.tributo === t)!;
    const geral = {
      cbs: fractionToPercentPoints(pick("CBS").valor),
      ibsEstadual: fractionToPercentPoints(pick("IBS_UF").valor),
      ibsMunicipal: fractionToPercentPoints(pick("IBS_MUN").valor),
    };
    const usadas: AliquotaUsada[] = [...base.aliquotasUsadas];
    const porItem = args.itens.map((it): AliquotasPP => {
      if (!it.imposto_seletivo) return { ...geral };
      const produto = it.imposto_seletivo.produto;
      if (!produto) {
        throw new ToolUserError(
          "PRODUTO_IS_AUSENTE",
          "Com cenario_aliquotas 'vigente', informe imposto_seletivo.produto (ex.: bebidas_acucaradas) para localizar a alíquota do Imposto Seletivo no arquivo de alíquotas, ou use um cenário explícito.",
        );
      }
      const isRates = requireRates(snap, data, { produto }, ["IS"]);
      const e = isRates.selection.aplicaveis.find((x) => x.tributo === "IS") as UsableRateEntry;
      for (const a of isRates.aliquotasUsadas) {
        if (!usadas.some((u) => u.tributo === "IS" && u.produto === a.produto)) usadas.push(a);
      }
      return { ...geral, impostoSeletivo: { adValorem: fractionToPercentPoints(e.valor) } };
    });
    return { modo: "vigente", porItem, aliquotasUsadas: usadas };
  }

  if (temIs && !cen.is?.ad_valorem && !cen.is?.ad_rem) {
    throw new ToolUserError(
      "CENARIO_INCOMPLETO",
      "Há item com Imposto Seletivo: informe cenario_aliquotas.is (ad_valorem como fração e/ou ad_rem em reais por unidade).",
    );
  }
  const hoje = ctx.now().toISOString().slice(0, 10);
  const geral = {
    cbs: fractionToPercentPoints(cen.cbs),
    ibsEstadual: fractionToPercentPoints(cen.ibs_uf),
    ibsMunicipal: fractionToPercentPoints(cen.ibs_mun),
  };
  const isPP =
    cen.is && temIs
      ? {
          ...(cen.is.ad_valorem !== undefined
            ? { adValorem: fractionToPercentPoints(cen.is.ad_valorem) }
            : {}),
          ...(cen.is.ad_rem !== undefined ? { adRem: Number(cen.is.ad_rem) } : {}),
        }
      : undefined;
  const usadas: AliquotaUsada[] = [
    aliquotaUsuario("CBS", Number(cen.cbs), data, hoje),
    aliquotaUsuario("IBS_UF", Number(cen.ibs_uf), data, hoje),
    aliquotaUsuario("IBS_MUN", Number(cen.ibs_mun), data, hoje),
  ];
  if (isPP && cen.is?.ad_valorem !== undefined) {
    usadas.push(aliquotaUsuario("IS", Number(cen.is.ad_valorem), data, hoje, "ad_valorem"));
  }
  if (isPP && cen.is?.ad_rem !== undefined) {
    usadas.push(aliquotaUsuario("IS", Number(cen.is.ad_rem), data, hoje, "ad_rem"));
  }
  const porItem = args.itens.map((it): AliquotasPP =>
    it.imposto_seletivo && isPP ? { ...geral, impostoSeletivo: isPP } : { ...geral },
  );
  return { modo: "usuario", porItem, aliquotasUsadas: usadas };
}

/** Maps the Portuguese tool input to the regular engine payload (OperacaoInput). */
export function buildRegularPayload(
  args: CalcularRegimeRegularArgs,
  porItem: (AliquotasPP | undefined)[],
): Record<string, unknown> {
  return {
    id: "mcp-reforma",
    versao: "0.0.1",
    dhFatoGerador: dhFatoGerador(args.data_fato_gerador, args.hora),
    municipio: Number(args.municipio_ibge),
    uf: args.uf,
    ...(args.modelo_documento !== undefined ? { tpDoc: args.modelo_documento } : {}),
    itens: args.itens.map((it, i) => {
      const is = it.imposto_seletivo;
      const aliq = porItem[i];
      return {
        numero: i + 1,
        ...(it.ncm ? { ncm: it.ncm } : {}),
        ...(it.nbs ? { nbs: it.nbs } : {}),
        cst: it.cst,
        cClassTrib: it.cclasstrib,
        baseCalculo: Number(it.valor),
        ...(it.quantidade !== undefined ? { quantidade: Number(it.quantidade) } : {}),
        ...(it.unidade ? { unidade: it.unidade } : {}),
        ...(is
          ? {
              impostoSeletivo: {
                cst: is.cst,
                cClassTrib: is.cclasstrib,
                baseCalculo: Number(is.valor),
                ...(is.quantidade !== undefined ? { quantidade: Number(is.quantidade) } : {}),
                ...(is.unidade ? { unidade: is.unidade } : {}),
                ...(is.imposto_informado !== undefined
                  ? { impostoInformado: Number(is.imposto_informado) }
                  : {}),
              },
            }
          : {}),
        ...(aliq ? { aliquotasNominais: aliq } : {}),
      };
    }),
  };
}

export function valoresItem(o: ObjetoMotor): Valores {
  const g = o.tribCalc?.IBSCBS?.gIBSCBS;
  return {
    base_calculo: g?.vBC ?? null,
    cbs: g?.gCBS?.vCBS ?? null,
    ibs_uf: g?.gIBSUF?.vIBSUF ?? null,
    ibs_mun: g?.gIBSMun?.vIBSMun ?? null,
    ibs: g?.vIBS ?? null,
    is: o.tribCalc?.IS?.vIS ?? null,
  };
}

export function totaisRegular(body: RespostaRegular): Valores {
  const t = body.total?.tribCalc;
  const ibscbs = t?.IBSCBSTot;
  return {
    base_calculo: ibscbs?.vBCIBSCBS ?? null,
    cbs: ibscbs?.gCBS?.vCBS ?? null,
    ibs_uf: ibscbs?.gIBS?.gIBSUF?.vIBSUF ?? null,
    ibs_mun: ibscbs?.gIBS?.gIBSMun?.vIBSMun ?? null,
    ibs: ibscbs?.gIBS?.vIBS ?? null,
    is: t?.ISTot?.vIS ?? null,
  };
}

/** Nominal reference rates reported by the engine for 2026 items (pCBS / pIBSUF / pIBSMun). */
export function aliquotasReferenciaMotor(body: RespostaRegular, data: string): AliquotaUsada[] {
  const seen = new Map<string, AliquotaUsada>();
  for (const o of body.objetos ?? []) {
    if (!o.estadoItem || NON_NUMERIC_STATUSES.has(o.estadoItem)) continue;
    const g = o.tribCalc?.IBSCBS?.gIBSCBS;
    const pares: [AliquotaUsada["tributo"], string | undefined][] = [
      ["CBS", g?.gCBS?.pCBS],
      ["IBS_UF", g?.gIBSUF?.pIBSUF],
      ["IBS_MUN", g?.gIBSMun?.pIBSMun],
    ];
    for (const [tributo, p] of pares) {
      if (p === undefined) continue;
      const valor = percentPointsToFraction(p);
      const k = `${tributo}|${valor}`;
      if (!seen.has(k)) {
        seen.set(k, {
          tributo,
          valor,
          vigencia: vigencia(data),
          fonte: FONTE_REFERENCIA_MOTOR,
          url_fonte: "",
          data_fonte: data,
          situacao: "referencia_motor",
          rates_file_version: null,
        });
      }
    }
  }
  return [...seen.values()];
}

const resumoValores = (v: Valores | null) =>
  v ? { CBS: v.cbs, "IBS UF": v.ibs_uf, "IBS município": v.ibs_mun, IS: v.is } : undefined;

export function calcularRegimeRegularTool(ctx: AppContext) {
  const maxItens = ctx.config.MAX_ITEMS;
  return defineTool({
    name: "calcular_regime_regular",
    title: "Calcular CBS, IBS e IS (regime regular)",
    description:
      "Calcula CBS, IBS (UF e município) e Imposto Seletivo de uma operação no regime regular usando EXCLUSIVAMENTE o motor oficial de código aberto da Receita Federal (rota de observabilidade). Devolve, por item, o status do motor (CALCULADO, CALCULO_SIMULADO, INCONSISTENCIA_ENTRADA, NAO_IMPLEMENTADO, FALHA_TECNICA) e os valores exatamente como o motor calculou (texto decimal, sem arredondar), os totais do motor e um recibo verificável (hash da entrada e da saída, versões e fonte de cada alíquota). Em 2026 o motor usa as alíquotas de referência internas; a partir de 2027 as alíquotas vêm do arquivo versionado do projeto (ou de um cenário explícito informado pelo usuário, como frações decimais). Se não souber CST/cClassTrib, use antes buscar_classificacao. Nunca calcule impostos de cabeça: mostre o resumo_humano e as fontes do recibo.",
    inputSchema: z.object({
      ...CalcularRegimeRegularInputBase,
      itens: itemsLimit(ItemSchema, maxItens).describe(`Itens da operação (1 a ${maxItens})`),
    }),
    outputSchema: calcularRegimeRegularOutputSchema,
    handler: async (args, ctx2, extra) => {
      const plan = planRates(ctx2, args);
      const payload = buildRegularPayload(args, plan.porItem);
      const knownIssues = knownIssuesFor("regular");
      const run = await executeCalculation<RespostaRegular>(ctx2, {
        engine: "regular",
        route: REGULAR_ROUTES.calcular,
        payload,
        aliquotasUsadas: plan.aliquotasUsadas,
        knownIssues,
        extractStatusItens: extractObjetosStatus,
        signal: extra.signal,
        acceptStatuses: [422],
      });
      if (run.response.status === 422) return engineGlobalErrorResult(run.response.body, run.recibo);

      const body = run.response.body ?? {};
      let recibo = run.recibo;
      if (plan.modo === "referencia_motor") {
        const ref = aliquotasReferenciaMotor(body, args.data_fato_gerador);
        if (ref.length > 0) recibo = { ...recibo, aliquotas_usadas: ref };
      }
      const normalizada = run.saidaNormalizada as RespostaRegular | undefined;
      const objetos = body.objetos ?? [];
      const itens = objetos.map((o, idx) => {
        const n = typeof o.nObj === "number" ? o.nObj : idx + 1;
        const status = o.estadoItem ?? "DESCONHECIDO";
        const numeric = !NON_NUMERIC_STATUSES.has(status);
        const erros = normalizada?.objetos?.[idx]?.erros ?? o.erros;
        return {
          item: n,
          descricao: args.itens[n - 1]?.descricao ?? null,
          status,
          valores: numeric ? valoresItem(o) : null,
          erros: mapErrosMotor(erros),
          ...(o.tribCalc ? { tributos_motor: o.tribCalc } : {}),
        };
      });
      const totais = totaisRegular(body);

      const avisos: string[] = [];
      if (plan.modo === "referencia_motor") {
        const ref = recibo.aliquotas_usadas;
        avisos.push(
          ref.length > 0
            ? `Data anterior a 2027: o motor usou as suas alíquotas de referência internas (${ref
                .map((a) => `${a.tributo} ${formatPercentual(a.valor)}`)
                .join(", ")}); o servidor não injetou alíquotas.`
            : `${MESSAGES.aliquotasMotor2026} A resposta do motor não informou as alíquotas aplicadas (nenhum item calculado com alíquota).`,
        );
      } else if (plan.modo === "usuario") {
        avisos.push(
          "Alíquotas informadas pelo usuário (cenário explícito, não oficiais); o motor marca o resultado como simulado.",
        );
      }
      if (run.avisosMotor["x-warning-dados-simulados"]) {
        avisos.push(
          `Aviso do motor (x-warning-dados-simulados: ${run.avisosMotor["x-warning-dados-simulados"]}): o cálculo usa dados informados/simulados, não oficiais.`,
        );
      }
      const comErro = itens.filter((i) => NON_NUMERIC_STATUSES.has(i.status)).length;
      if (comErro > 0) {
        avisos.push(
          "Itens sem valor: veja os erros do motor em itens[].erros e use explicar_status com o código para saber o que fazer.",
        );
      }
      avisos.push(
        `Problemas conhecidos do motor anotados no recibo (sem correção pelo servidor): ${knownIssues.map((k) => k.id.replace(/^.*#/, "#")).join(", ")}.`,
      );

      const resumo = buildResumoHumano({
        titulo: `Cálculo no regime regular pelo motor oficial — fato gerador ${args.data_fato_gerador}, ${args.uf}, município IBGE ${args.municipio_ibge}.`,
        itens: itens.map((i) => ({
          item: i.item,
          status: i.status,
          descricao: i.descricao ?? undefined,
          valores: resumoValores(i.valores),
        })),
        totais: resumoValores(totais),
        aliquotas: recibo.aliquotas_usadas,
        avisos,
      });

      return toolResult({
        data_fato_gerador: args.data_fato_gerador,
        dh_fato_gerador: String(payload.dhFatoGerador),
        uf: args.uf,
        municipio_ibge: args.municipio_ibge,
        cenario_aliquotas: plan.modo,
        itens,
        totais,
        aliquotas_usadas: recibo.aliquotas_usadas,
        avisos,
        avisos_motor: run.avisosMotor,
        known_issues: recibo.known_issues,
        resposta_motor: body,
        recibo,
        resumo_humano: resumo,
      });
    },
  });
}

/** Exposed for tests: numeric helper kept explicit to show values are never re-rounded. */
export const _internals = { num };
