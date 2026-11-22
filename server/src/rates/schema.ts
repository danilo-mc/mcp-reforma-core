import { z } from "zod";

export const TRIBUTOS = ["CBS", "IBS_UF", "IBS_MUN", "IS"] as const;
export const TributoSchema = z.enum(TRIBUTOS);
export type Tributo = z.infer<typeof TributoSchema>;

export const SituacaoSchema = z.enum(["oficial", "provisoria"]);
export type Situacao = z.infer<typeof SituacaoSchema>;

const dateToString = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

export const IsoDateSchema = z.preprocess(
  dateToString,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "data deve estar no formato AAAA-MM-DD")
    .refine(
      (s) =>
        !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
      {
        message: "data inexistente",
      },
    ),
);

export const VigenciaSchema = z
  .object({ inicio: IsoDateSchema, fim: IsoDateSchema })
  .refine((v) => v.inicio <= v.fim, { message: "vigencia.fim anterior a vigencia.inicio" });

const nullableString = z.preprocess(dateToString, z.string().nullable().optional());

/**
 * Lenient entry schema: types are enforced, but `valor`, `fonte`, `data_fonte`, `situacao`, `vigencia`
 * may be missing/null — such entries are *placeholders* (pendentes) and are never used for calculation.
 */
export const RateEntryInputSchema = z
  .object({
    tributo: TributoSchema,
    vigencia: VigenciaSchema.nullable().optional(),
    valor: z
      .number()
      .min(0, "valor deve estar entre 0 e 1")
      .max(1, "valor deve estar entre 0 e 1")
      .nullable()
      .optional(),
    situacao: SituacaoSchema.nullable().optional(),
    fonte: nullableString,
    url_fonte: nullableString,
    data_fonte: z.preprocess(dateToString, IsoDateSchema.nullable().optional()),
    notas: nullableString,
    uf: z
      .string()
      .regex(/^[A-Z]{2}$/, "uf deve ser a sigla com 2 letras maiúsculas")
      .nullable()
      .optional(),
    municipio_ibge: z.preprocess(
      (v) => (typeof v === "number" ? String(v) : v),
      z
        .string()
        .regex(/^\d{7}$/, "municipio_ibge deve ter 7 dígitos")
        .nullable()
        .optional(),
    ),
    produto: nullableString,
  })
  .strict();
export type RateEntryInput = z.infer<typeof RateEntryInputSchema>;

export const RatesFileSchema = z
  .object({
    version: z.preprocess(dateToString, z.string().min(1)),
    descricao: z.string().optional(),
    entries: z.array(z.unknown()),
  })
  .strict();

/** A fully validated entry that may be used for calculation. */
export interface UsableRateFields {
  vigencia: { inicio: string; fim: string };
  valor: number;
  situacao: Situacao;
  fonte: string;
  data_fonte: string;
}

export interface RateEntry {
  tributo: Tributo;
  vigencia: { inicio: string; fim: string } | null;
  valor: number | null;
  situacao: Situacao | null;
  fonte: string | null;
  url_fonte: string;
  data_fonte: string | null;
  notas: string | null;
  uf: string | null;
  municipio_ibge: string | null;
  produto: string | null;
  arquivo: string;
  versao_arquivo: string;
  /** 0-based position in the file's `entries`. */
  indice: number;
  pendente: boolean;
  motivos_pendencia: string[];
}

export type UsableRateEntry = RateEntry & UsableRateFields & { pendente: false };
