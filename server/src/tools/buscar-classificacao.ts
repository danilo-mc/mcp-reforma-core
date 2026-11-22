import { z } from "zod";
import type { AppContext } from "../context.ts";
import { REGULAR_ROUTES } from "../engine-client/routes.ts";
import { MESSAGES } from "../i18n/pt-BR.ts";
import { knownIssuesFor } from "../receipt/known-issues.ts";
import { KnownIssueSchema } from "../receipt/receipt.ts";
import { DADOS_ABERTOS_CACHE } from "./shared/dados-abertos.ts";
import { toolResult, ToolUserError } from "./shared/result.ts";
import { DataSchema } from "./shared/schemas.ts";
import { scoreDocument, tokenize, type WeightedField } from "./shared/texto.ts";
import { defineTool } from "./types.ts";

export const AVISO_CLASSIFICACAO = "A classificação é responsabilidade de quem emite a nota.";
const MAX_CANDIDATOS = 5;
/** Concurrency of the ncm-aplicavel checks (results are cached). */
const CONCORRENCIA_NCM = 10;
export const CCLASSTRIB_REGRA_GERAL = "000001";

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "");

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- engine shapes (dados abertos) ----
interface SituacaoAninhada {
  codigo?: string;
  descricao?: string;
  classificacoesTributarias?: { codigo?: string; descricao?: string }[];
}
interface ClassificacaoMotor {
  codigo?: string;
  descricao?: string;
  descricaoTratamentoTributario?: string;
  nomenclatura?: string;
  tipoAliquota?: string;
  percentualReducaoCbs?: number;
  percentualReducaoIbsUf?: number;
  percentualReducaoIbsMun?: number;
  tiposDfeClassificacao?: { sigla?: string }[];
}
interface NomenclaturaInfo {
  capitulo?: string;
  posicao?: string;
  subitem?: string;
  item?: string;
  tributadoPeloImpostoSeletivo?: boolean;
}
interface CodigoDescricao {
  codigo?: string;
  ncm?: string;
  descricao?: string;
}

const CandidatoOut = z.object({
  cst: z.string().nullable(),
  cst_descricao: z.string().nullable(),
  cclasstrib: z.string(),
  descricao_oficial: z.string(),
  tratamento_tributario: z.string().nullable(),
  tipo_aliquota: z.string().nullable(),
  nomenclatura: z.string().nullable(),
  percentual_reducao: z.object({
    cbs: z.number().nullable(),
    ibs_uf: z.number().nullable(),
    ibs_mun: z.number().nullable(),
  }),
  documentos: z.array(z.string()),
  /** Applicability of the informed NCM/NBS according to the engine (null = not checked). */
  codigo_aplicavel: z.boolean().nullable(),
  pontuacao: z.number(),
  motivos: z.array(z.string()),
});
type Candidato = z.infer<typeof CandidatoOut>;

const NomenclaturaOut = z.object({
  tipo: z.enum(["NCM", "NBS"]),
  codigo: z.string(),
  encontrado: z.boolean(),
  texto_oficial: z.string().nullable(),
  sujeito_imposto_seletivo: z.boolean().nullable(),
});

const SugestaoOut = z.object({ codigo: z.string(), descricao: z.string() });

export const buscarClassificacaoOutputSchema = z.object({
  data: z.string(),
  consulta: z.object({
    descricao: z.string().nullable(),
    ncm: z.string().nullable(),
    nbs: z.string().nullable(),
    termos: z.array(z.string()),
  }),
  nomenclatura: NomenclaturaOut.nullable(),
  candidatos: z.array(CandidatoOut),
  sugestoes_ncm: z.array(SugestaoOut),
  sugestoes_nbs: z.array(SugestaoOut),
  aviso: z.string(),
  known_issues: z.array(KnownIssueSchema),
  fonte: z.string(),
  resumo_humano: z.string(),
});

const onlyDigits = (s: string) => s.replace(/[.\-\s]/g, "");

async function tabelas(ctx: AppContext, data: string, signal: AbortSignal) {
  const client = ctx.engines.regular;
  const [situacoes, classificacoes] = await Promise.all([
    DADOS_ABERTOS_CACHE.get<SituacaoAninhada[]>(
      client,
      REGULAR_ROUTES.dadosAbertos.situacoesCbsIbs,
      { data },
      signal,
    ),
    DADOS_ABERTOS_CACHE.get<ClassificacaoMotor[]>(
      client,
      REGULAR_ROUTES.dadosAbertos.classificacoesCbsIbs,
      { data },
      signal,
    ),
  ]);
  const cstPorClass = new Map<string, { cst: string; descricao: string | null }>();
  for (const s of situacoes ?? []) {
    for (const c of s.classificacoesTributarias ?? []) {
      if (c.codigo && s.codigo) cstPorClass.set(c.codigo, { cst: s.codigo, descricao: s.descricao ?? null });
    }
  }
  return { cstPorClass, classificacoes: (classificacoes ?? []).filter((c) => !!c.codigo) };
}

function nomenclaturaTexto(info: NomenclaturaInfo | null): string | null {
  if (!info) return null;
  const parts = [info.capitulo, info.posicao, info.subitem ?? info.item].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" › ") : null;
}

function aceitaNomenclatura(c: ClassificacaoMotor, tipo: "NCM" | "NBS"): boolean {
  const n = (c.nomenclatura ?? "").toUpperCase();
  return n === "" || n.includes(tipo) || n.includes("NÃO POSSUI") || n.includes("NAO POSSUI");
}

function sugerir<T extends CodigoDescricao>(
  lista: T[] | null,
  termos: string[],
  codigoDe: (x: T) => string | undefined,
) {
  if (!lista || termos.length === 0) return [];
  return lista
    .map((x) => ({ x, s: scoreDocument(termos, [{ text: x.descricao ?? "", weight: 1 }]) }))
    .filter((r) => r.s.score > 0)
    .sort((a, b) => b.s.score - a.s.score || (codigoDe(a.x) ?? "").localeCompare(codigoDe(b.x) ?? ""))
    .slice(0, MAX_CANDIDATOS)
    .map((r) => ({ codigo: codigoDe(r.x) ?? "", descricao: stripTags(r.x.descricao ?? "") }));
}

export const buscarClassificacaoTool = defineTool({
  name: "buscar_classificacao",
  title: "Buscar classificação tributária (CST e cClassTrib)",
  description:
    "Ajuda a encontrar o CST e o cClassTrib do IBS/CBS a partir de uma descrição em português e/ou de um código NCM (mercadoria) ou NBS (serviço), usando somente as tabelas oficiais expostas pelo motor da Receita Federal (dados abertos). Faz busca textual simples (sem IA) e devolve até 5 candidatos com o texto oficial de cada classificação, o CST correspondente e, quando houver NCM/NBS, se o motor considera o código aplicável. Também sugere códigos NCM/NBS a partir da descrição. Não decide pela pessoa: a classificação é responsabilidade de quem emite a nota; converse com o usuário para escolher.",
  inputSchema: z
    .object({
      descricao: z
        .string()
        .min(2)
        .max(300)
        .optional()
        .describe("Descrição do produto ou serviço em português, ex.: 'água mineral', 'consultoria'"),
      ncm: z
        .string()
        .optional()
        .describe("Código NCM (8 dígitos, pontos opcionais) da mercadoria, se conhecido"),
      nbs: z
        .string()
        .optional()
        .describe("Código NBS (9 dígitos, pontos opcionais) do serviço, se conhecido"),
      data: DataSchema.optional().describe("Data de referência (AAAA-MM-DD) para a vigência; padrão: hoje"),
    })
    .refine((a) => a.descricao || a.ncm || a.nbs, { message: "informe descricao, ncm ou nbs" }),
  outputSchema: buscarClassificacaoOutputSchema,
  handler: async (args, ctx, extra) => {
    const data = args.data ?? ctx.now().toISOString().slice(0, 10);
    const ncm = args.ncm ? onlyDigits(args.ncm) : undefined;
    const nbs = args.nbs ? onlyDigits(args.nbs) : undefined;
    if (ncm !== undefined && !/^\d{8}$/.test(ncm))
      throw new ToolUserError("ENTRADA_INVALIDA", "NCM deve ter 8 dígitos.");
    if (nbs !== undefined && !/^\d{9}$/.test(nbs))
      throw new ToolUserError("ENTRADA_INVALIDA", "NBS deve ter 9 dígitos.");
    if (ncm && nbs) throw new ToolUserError("ENTRADA_INVALIDA", "Informe NCM ou NBS, não ambos.");
    const client = ctx.engines.regular;
    const signal = extra.signal;

    const { cstPorClass, classificacoes } = await tabelas(ctx, data, signal);

    // NCM / NBS official text and links
    let nomenclatura: z.infer<typeof NomenclaturaOut> | null = null;
    let textoCodigo: string | null = null;
    let vinculadosNbs: Set<string> | undefined;
    if (ncm) {
      const info = await DADOS_ABERTOS_CACHE.get<NomenclaturaInfo>(
        client,
        REGULAR_ROUTES.dadosAbertos.ncm,
        { ncm, data },
        signal,
      );
      textoCodigo = nomenclaturaTexto(info);
      nomenclatura = {
        tipo: "NCM",
        codigo: ncm,
        encontrado: info !== null,
        texto_oficial: textoCodigo,
        sujeito_imposto_seletivo: info?.tributadoPeloImpostoSeletivo ?? null,
      };
    } else if (nbs) {
      const [info, vinc] = await Promise.all([
        DADOS_ABERTOS_CACHE.get<NomenclaturaInfo>(
          client,
          REGULAR_ROUTES.dadosAbertos.nbs,
          { nbs, data },
          signal,
        ),
        DADOS_ABERTOS_CACHE.get<string[]>(
          client,
          REGULAR_ROUTES.dadosAbertos.classificacoesPorNbs,
          { nbs, data },
          signal,
        ),
      ]);
      textoCodigo = nomenclaturaTexto(info);
      nomenclatura = {
        tipo: "NBS",
        codigo: nbs,
        encontrado: info !== null,
        texto_oficial: textoCodigo,
        sujeito_imposto_seletivo: info?.tributadoPeloImpostoSeletivo ?? null,
      };
      vinculadosNbs = new Set((vinc ?? []).filter((c) => typeof c === "string"));
    }

    const termosDescricao = args.descricao ? tokenize(args.descricao) : [];
    const termosCodigo = textoCodigo ? tokenize(textoCodigo).filter((t) => !termosDescricao.includes(t)) : [];

    // Universe of candidates
    let universo = classificacoes;
    if (vinculadosNbs) universo = universo.filter((c) => vinculadosNbs.has(c.codigo!));
    else if (ncm) universo = universo.filter((c) => aceitaNomenclatura(c, "NCM"));

    const ranked = universo.map((c) => {
      const cst = cstPorClass.get(c.codigo!);
      const fields: WeightedField[] = [
        { text: c.descricao ?? "", weight: 2 },
        { text: c.descricaoTratamentoTributario ?? "", weight: 1 },
        { text: cst?.descricao ?? "", weight: 0.5 },
      ];
      const d = scoreDocument(termosDescricao, fields);
      const k = scoreDocument(termosCodigo, fields);
      const motivos: string[] = [];
      if (d.termos.length > 0) motivos.push(`termos da descrição encontrados: ${d.termos.join(", ")}`);
      if (k.termos.length > 0)
        motivos.push(`termos do texto oficial do ${ncm ? "NCM" : "NBS"}: ${k.termos.join(", ")}`);
      if (vinculadosNbs) motivos.push("vinculado ao NBS informado (tabela oficial do motor)");
      return { c, cst, score: d.score, motivos };
    });
    ranked.sort((a, b) => b.score - a.score || a.c.codigo!.localeCompare(b.c.codigo!));

    let selecionados = ranked;
    if (!vinculadosNbs && !ncm) selecionados = ranked.filter((r) => r.score > 0);

    // NCM: ask the engine which classifications accept this NCM (ncm-aplicavel) among those that
    // require an NCM, plus text matches and the general rule (000001). Order: accepted + text match,
    // general rule, other accepted classifications.
    const aplicavel = new Map<string, boolean | null>();
    if (ncm && nomenclatura?.encontrado) {
      const especificas = ranked.filter((r) => (r.c.nomenclatura ?? "").toUpperCase() === "NCM");
      const checar = [
        ...new Set([
          ...especificas,
          ...ranked.filter((r) => r.score > 0 || r.c.codigo === CCLASSTRIB_REGRA_GERAL),
        ]),
      ];
      const res = await mapLimit(checar, CONCORRENCIA_NCM, (r) =>
        DADOS_ABERTOS_CACHE.get<{ valido?: boolean }>(
          client,
          REGULAR_ROUTES.dadosAbertos.ncmAplicavel,
          { cClassTrib: r.c.codigo!, ncm, dataOcorrenciaFatoGerador: data },
          signal,
        ),
      );
      res.forEach((r, i) => {
        aplicavel.set(checar[i]!.c.codigo!, r.status === "fulfilled" ? (r.value?.valido ?? null) : null);
      });
      const tier = (r: (typeof ranked)[number]) => {
        const ok = aplicavel.get(r.c.codigo!) === true;
        if (ok && r.score > 0) return 0;
        if (r.c.codigo === CCLASSTRIB_REGRA_GERAL) return 1;
        return 2;
      };
      selecionados = checar
        .filter((r) => aplicavel.get(r.c.codigo!) === true)
        .map((r) => {
          r.motivos.push("NCM aceito por esta classificação segundo o motor (ncm-aplicavel)");
          if (r.c.codigo === CCLASSTRIB_REGRA_GERAL) r.motivos.push("regra geral (tributação integral)");
          return r;
        })
        .sort((a, b) => tier(a) - tier(b) || b.score - a.score || a.c.codigo!.localeCompare(b.c.codigo!));
    } else if (!vinculadosNbs && selecionados.length === 0) {
      const geral = ranked.find((r) => r.c.codigo === CCLASSTRIB_REGRA_GERAL);
      if (geral) {
        geral.motivos.push(
          "regra geral: nenhum regime específico encontrado pela descrição; confirme se a operação não tem tratamento diferenciado",
        );
        selecionados = [geral];
      }
    }
    const candidatos: Candidato[] = selecionados.slice(0, MAX_CANDIDATOS).map((r) => ({
      cst: r.cst?.cst ?? null,
      cst_descricao: r.cst?.descricao ?? null,
      cclasstrib: r.c.codigo!,
      descricao_oficial: r.c.descricao ?? "",
      tratamento_tributario: r.c.descricaoTratamentoTributario ?? null,
      tipo_aliquota: r.c.tipoAliquota ?? null,
      nomenclatura: r.c.nomenclatura ?? null,
      percentual_reducao: {
        cbs: r.c.percentualReducaoCbs ?? null,
        ibs_uf: r.c.percentualReducaoIbsUf ?? null,
        ibs_mun: r.c.percentualReducaoIbsMun ?? null,
      },
      documentos: (r.c.tiposDfeClassificacao ?? []).map((t) => t.sigla ?? "").filter(Boolean),
      codigo_aplicavel: vinculadosNbs ? true : ncm ? (aplicavel.get(r.c.codigo!) ?? null) : null,
      pontuacao: Math.round(r.score * 100) / 100,
      motivos: r.motivos,
    }));

    // NCM / NBS suggestions from the description (only when no code was informed)
    let sugestoesNcm: z.infer<typeof SugestaoOut>[] = [];
    let sugestoesNbs: z.infer<typeof SugestaoOut>[] = [];
    if (!ncm && !nbs && termosDescricao.length > 0) {
      const [listaNcm, listaNbs] = await Promise.all([
        DADOS_ABERTOS_CACHE.get<CodigoDescricao[]>(
          client,
          REGULAR_ROUTES.dadosAbertos.ncmVigentes,
          { data },
          signal,
        ).catch(() => null),
        DADOS_ABERTOS_CACHE.get<CodigoDescricao[]>(
          client,
          REGULAR_ROUTES.dadosAbertos.nbsLista,
          { data },
          signal,
        ).catch(() => null),
      ]);
      sugestoesNcm = sugerir(listaNcm, termosDescricao, (x) => x.ncm);
      sugestoesNbs = sugerir(listaNbs, termosDescricao, (x) => x.codigo);
    }

    const knownIssues = knownIssuesFor("regular_classificacao");
    const linhas: string[] = [
      `Busca de classificação tributária (tabelas oficiais do motor, vigência ${data}).`,
    ];
    if (nomenclatura) {
      linhas.push(
        nomenclatura.encontrado
          ? `${nomenclatura.tipo} ${nomenclatura.codigo}: ${nomenclatura.texto_oficial ?? "sem texto"}${nomenclatura.sujeito_imposto_seletivo ? " (sujeito ao Imposto Seletivo)" : ""}.`
          : `${nomenclatura.tipo} ${nomenclatura.codigo} não encontrado no motor para esta data.`,
      );
    }
    if (candidatos.length === 0) {
      linhas.push(
        "Nenhum candidato encontrado. Tente outra descrição (palavras mais simples) ou informe o NCM/NBS.",
      );
    } else {
      linhas.push("Candidatos (confirme com quem emite a nota):");
      for (const c of candidatos) {
        linhas.push(
          `• CST ${c.cst ?? "?"} / cClassTrib ${c.cclasstrib} — ${c.descricao_oficial}${c.tratamento_tributario ? ` [${c.tratamento_tributario}]` : ""}`,
        );
      }
    }
    if (sugestoesNbs.length > 0)
      linhas.push(`NBS possíveis: ${sugestoesNbs.map((s) => `${s.codigo} (${s.descricao})`).join("; ")}.`);
    if (sugestoesNcm.length > 0)
      linhas.push(`NCM possíveis: ${sugestoesNcm.map((s) => `${s.codigo} (${s.descricao})`).join("; ")}.`);
    linhas.push(
      `Limitações conhecidas das tabelas do motor: ${knownIssues.map((k) => k.id.replace(/^.*#/, "#")).join(", ")} (consultas por NBS/atores podem estar incompletas e listas podem incluir códigos encerrados).`,
    );
    linhas.push(AVISO_CLASSIFICACAO, MESSAGES.disclaimer);

    return toolResult({
      data,
      consulta: {
        descricao: args.descricao ?? null,
        ncm: ncm ?? null,
        nbs: nbs ?? null,
        termos: termosDescricao,
      },
      nomenclatura,
      candidatos,
      sugestoes_ncm: sugestoesNcm,
      sugestoes_nbs: sugestoesNbs,
      aviso: AVISO_CLASSIFICACAO,
      known_issues: knownIssues,
      fonte: "motor oficial do regime regular — dados abertos (classificações tributárias, NCM e NBS)",
      resumo_humano: linhas.join("\n"),
    });
  },
});
