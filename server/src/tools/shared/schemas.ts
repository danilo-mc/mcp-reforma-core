import { z } from "zod";

/** Shared zod pieces for tool input schemas. */

export const DataSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use o formato AAAA-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "data inexistente")
  .describe("Data no formato AAAA-MM-DD");

export const UfSchema = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "use a sigla da UF com 2 letras")
  .transform((s) => s.toUpperCase())
  .describe("Sigla da UF, ex.: SP");

// Clients often send the IBGE code as a JSON number; accept it and normalize to string.
export const MunicipioIbgeSchema = z.preprocess(
  (v) => (typeof v === "number" && Number.isInteger(v) ? String(v) : v),
  z
    .string()
    .regex(/^\d{7}$/, "use o código IBGE do município com 7 dígitos")
    .describe("Código IBGE do município (7 dígitos), ex.: 3550308"),
);

export const ProdutoIsSchema = z
  .string()
  .regex(/^[a-z0-9_]{1,64}$/, "use o identificador do produto em minúsculas, ex.: bebidas_acucaradas")
  .describe("Produto sujeito ao Imposto Seletivo, ex.: bebidas_acucaradas");

/** Enforces MAX_ITEMS on calculation tools (SPEC §9). */
export function itemsLimit<T extends z.ZodType>(item: T, max: number) {
  return z.array(item).min(1, "informe ao menos 1 item").max(max, `máximo de ${max} itens por cálculo`);
}
