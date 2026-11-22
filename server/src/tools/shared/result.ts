import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import {
  EngineAbortedError,
  EngineBadResponseError,
  EngineTimeoutError,
  EngineUnavailableError,
} from "../../engine-client/errors.ts";
import { MESSAGES } from "../../i18n/pt-BR.ts";
import { AliquotasNaoValidadasError, RatesConfigError } from "../../rates/loader.ts";
import { PersonalDataError } from "../../receipt/privacy.ts";

/** Result payload shape shared by every tool: always has a short human summary. */
export type ToolPayload = Record<string, unknown> & { resumo_humano: string };

/**
 * Builds a CallToolResult with both `structuredContent` (for clients/widgets) and a text block
 * (`resumo_humano` + compact JSON) for clients that only read text.
 */
export function toolResult<T extends ToolPayload>(payload: T): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: "text", text: `${payload.resumo_humano}\n\n${JSON.stringify(payload)}` }],
  };
}

/** A user-facing error raised intentionally by a tool (message is already safe pt-BR text). */
export class ToolUserError extends Error {
  readonly codigo: string;
  constructor(codigo: string, message: string) {
    super(message);
    this.name = "ToolUserError";
    this.codigo = codigo;
  }
}

/** Maps any error to an `isError` result with a safe pt-BR message (no stack traces, no payloads). */
export function toolErrorResult(err: unknown): CallToolResult {
  let codigo = "ERRO_INTERNO";
  let mensagem: string = MESSAGES.erroGenerico;
  if (err instanceof ToolUserError) {
    codigo = err.codigo;
    mensagem = err.message;
  } else if (err instanceof AliquotasNaoValidadasError) {
    codigo = "ALIQUOTAS_NAO_VALIDADAS";
    mensagem = err.message;
  } else if (err instanceof PersonalDataError) {
    codigo = "DADOS_PESSOAIS";
    mensagem = err.message;
  } else if (err instanceof EngineTimeoutError) {
    codigo = "MOTOR_TIMEOUT";
    mensagem = err.message;
  } else if (err instanceof EngineUnavailableError) {
    codigo = "MOTOR_INDISPONIVEL";
    mensagem = MESSAGES.motorIndisponivel(err.engine);
  } else if (err instanceof EngineBadResponseError) {
    codigo = "MOTOR_RESPOSTA_INVALIDA";
    mensagem = err.message;
  } else if (err instanceof EngineAbortedError) {
    codigo = "CANCELADO";
    mensagem = err.message;
  } else if (err instanceof RatesConfigError) {
    codigo = "CONFIG_ALIQUOTAS";
    mensagem = "O arquivo de alíquotas do servidor está inválido. Nenhum cálculo foi feito.";
  } else if (err instanceof ZodError) {
    codigo = "ENTRADA_INVALIDA";
    mensagem = `${MESSAGES.erroValidacao} ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
  }
  const payload = { erro: { codigo, mensagem } };
  return {
    isError: true,
    content: [{ type: "text", text: `${mensagem}\n\n${JSON.stringify(payload)}` }],
  };
}
