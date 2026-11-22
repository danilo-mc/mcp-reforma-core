import { z } from "zod";
import { MESSAGES } from "../i18n/pt-BR.ts";
import { MotorSchema } from "../receipt/receipt.ts";
import { verifyReceipt } from "../receipt/receipt.ts";
import { reproduceReceipt } from "./shared/engine-call.ts";
import { toolResult, ToolUserError } from "./shared/result.ts";
import { defineTool } from "./types.ts";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex inválido");

const DiffOut = z.object({
  path: z.string(),
  tipo: z.enum(["alterado", "adicionado", "removido"]),
  antes: z.unknown().optional(),
  depois: z.unknown().optional(),
});

export const reproduzirCalculoOutputSchema = z.object({
  confere: z.boolean(),
  recibo_valido: z.boolean(),
  output_sha256_original: z.string(),
  output_sha256_novo: z.string(),
  diff: z.array(DiffOut),
  motor_original: MotorSchema,
  motor_atual: MotorSchema,
  versoes_compativeis: z.boolean(),
  http_status: z.number(),
  status_itens_novos: z.array(z.object({ item: z.number(), status: z.string() })),
  avisos: z.array(z.string()),
  resumo_humano: z.string(),
});

const AVISO_ALTERACAO_MANUAL =
  "Modo sem recibo: o input_canonical foi informado separadamente; confira se ele é exatamente o do recibo original.";

export const reproduzirCalculoTool = defineTool({
  name: "reproduzir_calculo",
  title: "Reproduzir cálculo a partir do recibo",
  description:
    "Reexecuta no motor oficial o cálculo descrito por um recibo do MCP da Reforma (de calcular_regime_regular ou calcular_simples) e diz se o resultado confere. Verifica o hash da entrada do recibo, reenvia exatamente o input_canonical para a mesma rota do mesmo motor, normaliza a resposta (mcp-reforma/normalizacao@1) e compara o SHA-256 da saída e o status de cada item. Retorna confere true/false, as diferenças (ponteiros JSON) e se a versão do motor em execução é a mesma do recibo. Alternativamente aceita só input_canonical + motor + output_sha256.",
  inputSchema: z
    .object({
      recibo: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Recibo completo (objeto 'recibo' devolvido por calcular_regime_regular ou calcular_simples)",
        ),
      input_canonical: z
        .unknown()
        .optional()
        .describe("Sem recibo: payload canônico enviado ao motor (recibo.input_canonical)"),
      motor: MotorSchema.partial({ commit: true, versao: true, versao_base: true })
        .optional()
        .describe("Sem recibo: bloco 'motor' do recibo (repositorio obrigatório; rota recomendada)"),
      output_sha256: sha256
        .optional()
        .describe("Sem recibo: SHA-256 esperado da saída (recibo.output_sha256)"),
      resposta_motor_original: z
        .unknown()
        .optional()
        .describe("Opcional: resposta original do motor (para listar as diferenças campo a campo)"),
    })
    .refine((a) => a.recibo || (a.input_canonical !== undefined && a.motor && a.output_sha256), {
      message: "informe o recibo, ou input_canonical + motor + output_sha256",
    }),
  outputSchema: reproduzirCalculoOutputSchema,
  handler: async (args, ctx, extra) => {
    const avisos: string[] = [];
    let candidate: unknown = args.recibo;
    if (!candidate) {
      // Build a minimal receipt from the parts, so the same verification path applies.
      const { buildReceipt } = await import("../receipt/receipt.ts");
      const motor = {
        repositorio: args.motor!.repositorio,
        commit: args.motor!.commit ?? null,
        versao: args.motor!.versao ?? null,
        versao_base: args.motor!.versao_base ?? null,
      };
      const base = buildReceipt({
        engine: motor,
        ...(args.motor!.rota ? { rota: args.motor!.rota } : {}),
        payloadSentToEngine: args.input_canonical,
        rawEngineResponse: {},
        now: ctx.now(),
      });
      candidate = { ...base, output_sha256: args.output_sha256!, status_itens: [] };
      avisos.push(AVISO_ALTERACAO_MANUAL);
    } else {
      const check = verifyReceipt(candidate);
      if (!check.valido) {
        throw new ToolUserError(
          "RECIBO_INVALIDO",
          `Recibo inválido (foi alterado ou está incompleto): ${check.erros.join("; ")}. Nenhum cálculo foi refeito.`,
        );
      }
    }
    const semStatus = !args.recibo;
    const rep = await reproduceReceipt(ctx, candidate, extra.signal, args.resposta_motor_original, {
      ...(semStatus ? { extractStatusItens: () => [] } : {}),
    });
    avisos.push(...rep.avisos);

    const linhas = [
      rep.confere
        ? "Reprodução CONFERE: o motor oficial devolveu exatamente o mesmo resultado (hash da saída normalizada e status dos itens iguais)."
        : "Reprodução NÃO CONFERE: o resultado do motor difere do registrado no recibo.",
      `Motor do recibo: ${rep.motor_original.repositorio}@${rep.motor_original.commit ?? "?"} (app ${rep.motor_original.versao ?? "?"}, base ${rep.motor_original.versao_base ?? "?"}); motor atual: @${rep.motor_atual.commit ?? "?"} (app ${rep.motor_atual.versao ?? "?"}, base ${rep.motor_atual.versao_base ?? "?"}).`,
    ];
    if (!rep.confere && rep.diff.length > 0) {
      linhas.push(
        `Diferenças: ${rep.diff
          .slice(0, 10)
          .map((d) => d.path || "/")
          .join(", ")}${rep.diff.length > 10 ? "…" : ""}.`,
      );
    }
    linhas.push(...avisos, MESSAGES.disclaimer);
    return toolResult({
      confere: rep.confere,
      recibo_valido: true,
      output_sha256_original: rep.output_sha256_original,
      output_sha256_novo: rep.output_sha256_novo,
      diff: rep.diff,
      motor_original: rep.motor_original,
      motor_atual: rep.motor_atual,
      versoes_compativeis: rep.versoes_compativeis,
      http_status: rep.http_status,
      status_itens_novos: rep.status_itens_novos.map((s) => ({ item: s.item, status: String(s.status) })),
      avisos,
      resumo_humano: linhas.join("\n"),
    });
  },
});
