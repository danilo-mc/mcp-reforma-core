import { z } from "zod";
import { collectVersionInfo } from "../version-info.ts";
import { toolResult } from "./shared/result.ts";
import { defineTool } from "./types.ts";

const EngineStatusOut = z.object({
  nome: z.string(),
  repositorio: z.string(),
  commit: z.string().nullable(),
  disponivel: z.boolean(),
  versao: z.string().nullable(),
  versao_base: z.string().nullable(),
  data_base: z.string().nullable(),
  latencia_ms: z.number().nullable(),
  erro: z.string().nullable(),
});

export const versaoOutputSchema = z.object({
  servidor: z.object({
    nome: z.string(),
    versao: z.string(),
    build: z.string().nullable(),
    iniciado_em: z.string(),
  }),
  motores: z.array(EngineStatusOut),
  motores_indisponiveis: z.array(z.string()),
  aliquotas: z.object({
    versao_arquivo: z.string().nullable(),
    arquivos: z.array(z.object({ arquivo: z.string(), version: z.string() })),
    entradas_validadas: z.number(),
    entradas_pendentes: z.number(),
  }),
  ultimo_sync: z.object({ aliquotas: z.string().nullable(), build: z.string().nullable() }),
  resumo_humano: z.string(),
});

export const versaoTool = defineTool({
  name: "versao",
  title: "Versões e disponibilidade",
  description:
    "Mostra as versões de tudo o que compõe a resposta: versão do servidor, commits fixados dos motores oficiais da Receita Federal (regime regular, Simples Nacional e demais motores habilitados), versão da base de dados dos motores, versão do arquivo de alíquotas e data do último sincronismo. Informa também se algum motor está indisponível. Não recebe parâmetros.",
  inputSchema: z.object({}),
  outputSchema: versaoOutputSchema,
  handler: async (_args, ctx) => {
    const info = await collectVersionInfo(ctx, true);
    const linhas = [`Servidor mcp-reforma ${info.servidor.versao}.`];
    for (const m of info.motores) {
      const commit = m.commit ? m.commit.slice(0, 12) : "commit não informado";
      const versao = m.versao ? `v${m.versao}` : "versão desconhecida";
      const base = m.versao_base ? `, base ${m.versao_base}` : "";
      linhas.push(
        `• Motor ${m.nome}: ${m.disponivel ? "disponível" : "INDISPONÍVEL"} (${versao}${base}; ${commit}).`,
      );
    }
    linhas.push(
      `Alíquotas: arquivo versão ${info.aliquotas.versao_arquivo ?? "—"} (${info.aliquotas.entradas_validadas} validadas, ${info.aliquotas.entradas_pendentes} pendentes de validação).`,
    );
    if (info.motores_indisponiveis.length > 0) {
      linhas.push(`Atenção: motor(es) indisponível(is): ${info.motores_indisponiveis.join(", ")}.`);
    }
    return toolResult({ ...info, resumo_humano: linhas.join("\n") });
  },
});
