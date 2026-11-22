import { z } from "zod";
import type { AppContext } from "../context.ts";
import type { EngineClient } from "../engine-client/client.ts";
import { REGULAR_ROUTES } from "../engine-client/routes.ts";
import { MESSAGES } from "../i18n/pt-BR.ts";
import { INJECTION_START_DATE, selectRates } from "../rates/loader.ts";
import type { RateEntry } from "../rates/schema.ts";
import { formatPercentual } from "./shared/resumo.ts";
import { toolResult } from "./shared/result.ts";
import { DataSchema, MunicipioIbgeSchema, ProdutoIsSchema, UfSchema } from "./shared/schemas.ts";
import { defineTool } from "./types.ts";

const AliquotaOut = z.object({
  tributo: z.string(),
  valor: z.number(),
  vigencia: z.string(),
  situacao: z.string(),
  fonte: z.string(),
  url_fonte: z.string(),
  data_fonte: z.string(),
  notas: z.string().nullable(),
  uf: z.string().nullable(),
  municipio_ibge: z.string().nullable(),
  produto: z.string().nullable(),
  versao_arquivo: z.string(),
});

const PendenteOut = z.object({
  tributo: z.string(),
  vigencia: z.string().nullable(),
  situacao: z.string().nullable(),
  motivos: z.array(z.string()),
  notas: z.string().nullable(),
  uf: z.string().nullable(),
  municipio_ibge: z.string().nullable(),
  produto: z.string().nullable(),
  versao_arquivo: z.string(),
});

const ReferenciaMotorOut = z.object({
  consultado: z.boolean(),
  disponivel: z.boolean(),
  uniao: z.unknown().optional(),
  uf: z.unknown().optional(),
  municipio: z.unknown().optional(),
  erros: z.array(z.string()),
});

export const consultarAliquotasOutputSchema = z.object({
  data: z.string(),
  versao_arquivo: z.string().nullable(),
  /** True when the server injects rates/ into the engine for this date (≥ 2027-01-01). */
  injeta_aliquotas_no_motor: z.boolean(),
  aliquotas: z.array(AliquotaOut),
  pendentes: z.array(PendenteOut),
  referencia_motor: ReferenciaMotorOut.nullable(),
  avisos: z.array(z.string()),
  resumo_humano: z.string(),
});

const vig = (e: RateEntry) => (e.vigencia ? `${e.vigencia.inicio}/${e.vigencia.fim}` : null);

async function fetchUfCode(
  client: EngineClient,
  uf: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const res = await client.getJson<{ sigla?: string; codigo?: number }[]>(
    REGULAR_ROUTES.dadosAbertos.ufs,
    undefined,
    {
      signal,
      allowHttpErrors: true,
    },
  );
  if (!res.ok || !Array.isArray(res.body)) return undefined;
  return res.body.find((u) => u.sigla?.toUpperCase() === uf)?.codigo;
}

/** Best-effort read of the engine's own reference rates (dados abertos). Never throws. */
async function referenciaDoMotor(
  ctx: AppContext,
  data: string,
  uf: string | undefined,
  municipio: string | undefined,
  signal: AbortSignal,
): Promise<z.infer<typeof ReferenciaMotorOut>> {
  const client = ctx.engines.regular;
  const out: z.infer<typeof ReferenciaMotorOut> = { consultado: true, disponivel: false, erros: [] };
  const get = async (path: string, query: Record<string, string | number>) => {
    const res = await client.getJson(path, query, { signal, allowHttpErrors: true });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
    return res.body;
  };
  const tasks: Promise<void>[] = [
    get(REGULAR_ROUTES.dadosAbertos.aliquotaUniao, { data }).then((b) => {
      out.uniao = b;
    }),
  ];
  if (uf) {
    tasks.push(
      fetchUfCode(client, uf, signal).then(async (codigoUf) => {
        if (codigoUf === undefined) throw new Error(`UF ${uf} não encontrada no motor`);
        out.uf = await get(REGULAR_ROUTES.dadosAbertos.aliquotaUf, { codigoUf, data });
      }),
    );
  }
  if (municipio) {
    // TODO(VALIDAR): confirm the engine's codigoMunicipio is the 7-digit IBGE code (SPEC §5.1).
    tasks.push(
      get(REGULAR_ROUTES.dadosAbertos.aliquotaMunicipio, { codigoMunicipio: municipio, data }).then((b) => {
        out.municipio = b;
      }),
    );
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === "rejected") out.erros.push((r.reason as Error).message);
  out.disponivel = results.some((r) => r.status === "fulfilled");
  return out;
}

export const consultarAliquotasTool = defineTool({
  name: "consultar_aliquotas",
  title: "Consultar alíquotas",
  description:
    "Lista as alíquotas de CBS, IBS (UF e município) e Imposto Seletivo aplicáveis a uma data, lidas do arquivo versionado de alíquotas do projeto, cada uma com fonte, data da fonte e situação (oficial ou provisória). Entradas ainda não validadas contra a fonte oficial aparecem como pendentes e nunca são usadas em cálculos. Para datas anteriores a 2027-01-01, o motor oficial usa suas próprias alíquotas de referência; nesse caso a ferramenta tenta consultá-las no motor (dados abertos). Não calcula imposto: para isso use as ferramentas de cálculo.",
  inputSchema: z.object({
    data: DataSchema,
    uf: UfSchema.optional(),
    municipio_ibge: MunicipioIbgeSchema.optional(),
    produto: ProdutoIsSchema.optional(),
    consultar_motor: z
      .boolean()
      .default(true)
      .describe("Para datas antes de 2027, consultar também as alíquotas de referência do motor oficial."),
  }),
  outputSchema: consultarAliquotasOutputSchema,
  handler: async (args, ctx, extra) => {
    const snap = ctx.rates.get();
    const sel = selectRates(snap, args.data, args);
    const injeta = args.data >= INJECTION_START_DATE;
    const avisos: string[] = [];

    const aliquotas = sel.aplicaveis.map((e) => ({
      tributo: e.tributo,
      valor: e.valor,
      vigencia: `${e.vigencia.inicio}/${e.vigencia.fim}`,
      situacao: e.situacao,
      fonte: e.fonte,
      url_fonte: e.url_fonte,
      data_fonte: e.data_fonte,
      notas: e.notas,
      uf: e.uf,
      municipio_ibge: e.municipio_ibge,
      produto: e.produto,
      versao_arquivo: e.versao_arquivo,
    }));
    const pendentes = sel.pendentes.map((e) => ({
      tributo: e.tributo,
      vigencia: vig(e),
      situacao: e.situacao,
      motivos: e.motivos_pendencia,
      notas: e.notas,
      uf: e.uf,
      municipio_ibge: e.municipio_ibge,
      produto: e.produto,
      versao_arquivo: e.versao_arquivo,
    }));

    let referencia: z.infer<typeof ReferenciaMotorOut> | null = null;
    if (!injeta) {
      avisos.push(MESSAGES.aliquotasMotor2026);
      if (args.consultar_motor) {
        referencia = await referenciaDoMotor(ctx, args.data, args.uf, args.municipio_ibge, extra.signal);
        if (!referencia.disponivel) {
          avisos.push("Não foi possível consultar as alíquotas de referência no motor oficial agora.");
        }
      }
    }
    if (pendentes.length > 0) avisos.push(MESSAGES.aliquotasPendentes);
    const provisorias = aliquotas.filter((a) => a.situacao === "provisoria").map((a) => a.tributo);
    if (provisorias.length > 0) avisos.push(MESSAGES.aliquotaProvisoria([...new Set(provisorias)]));

    const linhas = [`Alíquotas para ${args.data} (arquivo de alíquotas versão ${sel.version ?? "—"}):`];
    for (const a of aliquotas) {
      const escopo = [a.uf, a.municipio_ibge, a.produto].filter(Boolean).join("/");
      linhas.push(
        `• ${a.tributo}${escopo ? ` (${escopo})` : ""}: ${formatPercentual(a.valor)} — ${a.situacao.toUpperCase()}; fonte: ${a.fonte} (${a.data_fonte}).`,
      );
    }
    for (const p of pendentes) {
      const escopo = [p.uf, p.municipio_ibge, p.produto].filter(Boolean).join("/");
      linhas.push(
        `• ${p.tributo}${escopo ? ` (${escopo})` : ""}: PENDENTE de validação — sem valor publicado.`,
      );
    }
    if (aliquotas.length === 0 && pendentes.length === 0) {
      linhas.push("Nenhuma alíquota do arquivo versionado se aplica a esta data.");
    }
    linhas.push(...avisos);

    return toolResult({
      data: args.data,
      versao_arquivo: sel.version,
      injeta_aliquotas_no_motor: injeta,
      aliquotas,
      pendentes,
      referencia_motor: referencia,
      avisos,
      resumo_humano: linhas.join("\n"),
    });
  },
});
