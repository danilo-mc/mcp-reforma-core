import { z } from "zod";

/** Per-item statuses returned by the official engines' observability routes (passed through verbatim). */
export const ITEM_STATUSES = [
  "CALCULADO",
  "CALCULO_SIMULADO",
  "INCONSISTENCIA_ENTRADA",
  "NAO_IMPLEMENTADO",
  "FALHA_TECNICA",
  /** Simples Nacional only: item not calculated, with `motivoEstado` (no CALCULO_SIMULADO there). */
  "NAO_CALCULADO",
] as const;

export const ItemStatusSchema = z.enum(ITEM_STATUSES);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

/** Statuses whose items must never show numeric values in `resumo_humano`. */
export const NON_NUMERIC_STATUSES: ReadonlySet<string> = new Set([
  "NAO_IMPLEMENTADO",
  "INCONSISTENCIA_ENTRADA",
  "FALHA_TECNICA",
  "NAO_CALCULADO",
]);

export function isItemStatus(s: string): s is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(s);
}
