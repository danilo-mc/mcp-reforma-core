import { z } from "zod";
import type { AppContext } from "../context.ts";
import { REGULAR_ROUTES, SIMPLES_ROUTES } from "../engine-client/routes.ts";
import { MESSAGES, STATUS_TEXTS } from "../i18n/pt-BR.ts";
import { isItemStatus } from "../status.ts";
import { toolResult } from "./shared/result.ts";
import { defineTool } from "./types.ts";

export const explicarStatusOutputSchema = z.object({
  codigo: z.string(),
  tipo: z.enum(["status", "erro_motor", "desconhecido"]),
  titulo: z.string(),
  explicacao: z.string(),
  o_que_fazer: z.string(),
  fonte: z.enum(["mcp-reforma", "motor-oficial", "nenhuma"]),
  motor: z.enum(["regular", "simples"]).nullable(),
  motor_disponivel: z.boolean().nullable(),
  resumo_humano: z.string(),
});
type Out = z.infer<typeof explicarStatusOutputSchema>;

const CODE_RE = /^[A-Z]{2,6}-\d{1,5}$/;

/** Which engine catalogues a code, by prefix (REG-… → regular, VSN-… → simples). */
export function engineForCode(codigo: string): "regular" | "simples" | undefined {
  if (codigo.startsWith("REG-")) return "regular";
  if (codigo.startsWith("VSN-")) return "simples";
  return undefined;
}

interface ErroDescricao {
  codigo?: string;
  titulo?: string;
  descricao?: string;
}

async function lookup(
  ctx: AppContext,
  motor: "regular" | "simples",
  codigo: string,
  signal: AbortSignal,
): Promise<{ found?: ErroDescricao; available: boolean }> {
  const client = ctx.engines[motor];
  const path = motor === "regular" ? REGULAR_ROUTES.erros : SIMPLES_ROUTES.erros;
  try {
    const res = await client.getJson<ErroDescricao>(path, { codigo }, { signal, allowHttpErrors: true });
    if (res.ok && res.body && typeof res.body === "object" && (res.body.titulo || res.body.descricao)) {
      return { found: res.body, available: true };
    }
    return { available: res.status < 500 };
  } catch {
    return { available: false };
  }
}

export const explicarStatusTool = defineTool({
  name: "explicar_status",
  title: "Explicar status ou código de erro",
  description:
    "Explica em português simples um status de item devolvido pelo motor oficial (CALCULADO, CALCULO_SIMULADO, INCONSISTENCIA_ENTRADA, NAO_IMPLEMENTADO, FALHA_TECNICA e, no Simples Nacional, NAO_CALCULADO) ou um código de erro do motor (ex.: REG-011 do regime regular, VSN-001 do Simples Nacional), e diz o que o usuário pode fazer. Códigos de erro são consultados no catálogo oficial do próprio motor.",
  inputSchema: z.object({
    codigo: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe("Status do item (ex.: NAO_IMPLEMENTADO) ou código de erro do motor (ex.: REG-011, VSN-001)"),
    motor: z
      .enum(["regular", "simples"])
      .optional()
      .describe("Motor que gerou o código, se souber. Por padrão é inferido pelo prefixo (REG-, VSN-)."),
  }),
  outputSchema: explicarStatusOutputSchema,
  handler: async (args, ctx, extra) => {
    const codigo = args.codigo.toUpperCase();
    let out: Omit<Out, "resumo_humano">;

    if (isItemStatus(codigo)) {
      const t = STATUS_TEXTS[codigo];
      out = {
        codigo,
        tipo: "status",
        titulo: t.titulo,
        explicacao: t.significado,
        o_que_fazer: t.o_que_fazer,
        fonte: "mcp-reforma",
        motor: null,
        motor_disponivel: null,
      };
    } else {
      const motores: ("regular" | "simples")[] = args.motor
        ? [args.motor]
        : engineForCode(codigo)
          ? [engineForCode(codigo)!]
          : CODE_RE.test(codigo)
            ? ["regular", "simples"]
            : [];
      let found: { motor: "regular" | "simples"; d: ErroDescricao } | undefined;
      let anyAvailable: boolean | null = motores.length > 0 ? false : null;
      for (const m of motores) {
        const r = await lookup(ctx, m, codigo, extra.signal);
        if (r.available) anyAvailable = true;
        if (r.found) {
          found = { motor: m, d: r.found };
          break;
        }
      }
      if (found) {
        out = {
          codigo,
          tipo: "erro_motor",
          titulo: found.d.titulo ?? codigo,
          explicacao: found.d.descricao ?? found.d.titulo ?? "",
          o_que_fazer:
            "Corrija o dado indicado e repita o cálculo. Se não souber qual classificação usar, a ferramenta buscar_classificacao pode ajudar; a decisão final é de quem emite a nota.",
          fonte: "motor-oficial",
          motor: found.motor,
          motor_disponivel: true,
        };
      } else {
        const indisponivel = anyAvailable === false;
        out = {
          codigo,
          tipo: "desconhecido",
          titulo: "Código não encontrado",
          explicacao: MESSAGES.codigoDesconhecido(codigo),
          o_que_fazer: indisponivel
            ? "O catálogo de erros do motor oficial está indisponível agora; tente novamente em instantes."
            : "Confira o código. Se ele veio de um cálculo, use a mensagem retornada junto do item.",
          fonte: "nenhuma",
          motor: motores.length === 1 ? motores[0]! : null,
          motor_disponivel: anyAvailable,
        };
      }
    }

    const resumo = `${out.codigo} — ${out.titulo}\n${out.explicacao}\nO que fazer: ${out.o_que_fazer}`;
    return toolResult({ ...out, resumo_humano: resumo });
  },
});
