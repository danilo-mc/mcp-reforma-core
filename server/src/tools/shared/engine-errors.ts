import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Recibo } from "../../receipt/receipt.ts";

/** One engine error (RFC 7807 item of `erros[]` / `errors[]`), in Portuguese field names. */
export interface ErroMotor {
  codigo: string | null;
  titulo: string | null;
  detalhe: string | null;
  /** JSON pointer in the engine payload (e.g. "#/itens/0/cst"). */
  campo: string | null;
}

const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Maps the engine's `erros[]`/`errors[]` to ErroMotor (order as given; normalize first for stable order). */
export function mapErrosMotor(list: unknown): ErroMotor[] {
  if (!Array.isArray(list)) return [];
  return list.map((e: unknown) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return {
      codigo: s(o.code ?? o.codigo),
      titulo: s(o.title ?? o.titulo),
      detalhe: s(o.detail ?? o.mensagem ?? o.descricao),
      campo: s(o.pointer ?? o.campo),
    };
  });
}

/** Plain-language hints for frequent global (HTTP 422) errors. */
const DICAS: Record<string, string> = {
  "REG-018": "Confira se o código IBGE do município (municipio_ibge) pertence à UF informada (uf).",
};

export function dicaErroMotor(codigo: string | null): string {
  return (
    (codigo && DICAS[codigo]) ??
    `Use a ferramenta explicar_status com o código${codigo ? ` ${codigo}` : ""} para ver o significado e o que fazer.`
  );
}

/**
 * Tool error result for an engine "erro global" (HTTP 422 of the observability route): the engine
 * refused the whole calculation. Carries the engine messages (verbatim), hints and the receipt.
 */
export function engineGlobalErrorResult(body: unknown, recibo: Recibo | undefined): CallToolResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const erros = mapErrosMotor(b.errors ?? b.erros).map((e) => ({ ...e, dica: dicaErroMotor(e.codigo) }));
  const linhas = [
    "O motor oficial recusou o cálculo inteiro (erro global); nenhum valor foi calculado.",
    ...erros.map(
      (e) =>
        `• ${e.titulo ?? "Erro"}${e.codigo ? ` (${e.codigo})` : ""}: ${e.detalhe ?? "sem detalhe"} — ${e.dica}`,
    ),
  ];
  if (erros.length === 0 && typeof b.detail === "string") linhas.push(`• ${b.detail}`);
  const mensagem = linhas.join("\n");
  const payload = {
    erro: { codigo: "ERRO_GLOBAL_MOTOR", mensagem, erros_motor: erros },
    ...(recibo ? { recibo } : {}),
  };
  return { isError: true, content: [{ type: "text", text: `${mensagem}\n\n${JSON.stringify(payload)}` }] };
}
