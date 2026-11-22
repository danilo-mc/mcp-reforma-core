import { z } from "zod";
import { ItemStatusSchema } from "../status.ts";
import { canonicalize, sha256Hex } from "./jcs.ts";
import { NORMALIZACAO_ID, normalizedOutputSha256 } from "./normalize.ts";
import { assertNoPersonalData } from "./privacy.ts";

export const RECIBO_SCHEMA_ID = "mcp-reforma/recibo@1";

/** Exact disclaimer text mandated by SPEC §6. */
export const AVISO_RECIBO =
  "Estimativa gerada a partir do código aberto da Receita Federal. Ferramenta independente, não oficial. A classificação fiscal e a apuração são responsabilidade do contribuinte.";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data deve estar no formato AAAA-MM-DD");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex inválido");

export const MotorSchema = z.object({
  repositorio: z.string().min(1),
  commit: z.string().nullable(),
  versao: z.string().nullable(),
  versao_base: z.string().nullable(),
  /** Engine route (path relative to the engine base URL) that produced the output; used to reproduce. */
  rota: z.string().min(1).optional(),
});
export type Motor = z.infer<typeof MotorSchema>;

export const AliquotaUsadaSchema = z
  .object({
    /** IBS = unified IBS (e.g. Simples Nacional pIBSSN). */
    tributo: z.enum(["CBS", "IBS_UF", "IBS_MUN", "IS", "IBS"]),
    /** Fraction (0.088 = 8,8 %), except `componente: "ad_rem"` (amount per unit, in R$). */
    valor: z.number().min(0),
    /** Only for IS: ad valorem (fraction, default) or ad rem (R$ per unit). */
    componente: z.enum(["ad_valorem", "ad_rem"]).optional(),
    /** "AAAA-MM-DD/AAAA-MM-DD" */
    vigencia: z.string().regex(/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/),
    fonte: z.string().min(1),
    url_fonte: z.string(),
    data_fonte: isoDate,
    /**
     * oficial|provisoria come from rates/; `usuario` = explicit scenario provided by the user
     * (SPEC §5.1 `cenario_aliquotas` object); `referencia_motor` = engine-internal reference rate
     * (dates before 2027, as reported in the engine response; not injected by the server).
     */
    situacao: z.enum(["oficial", "provisoria", "usuario", "referencia_motor"]),
    rates_file_version: z.string().nullable(),
    uf: z.string().optional(),
    municipio_ibge: z.string().optional(),
    produto: z.string().optional(),
  })
  .refine((a) => a.componente === "ad_rem" || a.valor <= 1, {
    message: "valor deve ser uma fração entre 0 e 1",
    path: ["valor"],
  });
export type AliquotaUsada = z.infer<typeof AliquotaUsadaSchema>;

export const StatusItemSchema = z.object({
  item: z.number().int().min(1),
  status: z.union([ItemStatusSchema, z.string().min(1)]),
});
export type StatusItem = z.infer<typeof StatusItemSchema>;

export const KnownIssueSchema = z.object({
  id: z.string().min(1),
  descricao: z.string().min(1),
  url: z.string().optional(),
  /** Upstream issue state and local observation, e.g. "aberta; não reproduzida em f1eebd7". */
  status: z.string().optional(),
});
export type KnownIssue = z.infer<typeof KnownIssueSchema>;

export const ReciboSchema = z.object({
  schema: z.literal(RECIBO_SCHEMA_ID),
  gerado_em: z.iso.datetime(),
  motor: MotorSchema,
  aliquotas_usadas: z.array(AliquotaUsadaSchema),
  status_itens: z.array(StatusItemSchema),
  known_issues: z.array(KnownIssueSchema),
  /** Full payload effectively sent to the engine (rates included). Never contains personal data. */
  input_canonical: z.unknown(),
  input_canonical_sha256: sha256,
  output_sha256: sha256,
  /**
   * Normalization applied to the JSON engine output before hashing (see receipt/normalize.ts).
   * Absent = hash of the raw output (binary outputs and receipts created before normalization).
   */
  normalizacao: z.literal(NORMALIZACAO_ID).optional(),
  /** DANFSe only: SHA-256 of the received XML and of the generated PDF (neither is stored). */
  xml_sha256: sha256.optional(),
  pdf_sha256: sha256.optional(),
  aviso: z.literal(AVISO_RECIBO),
});
export type Recibo = z.infer<typeof ReciboSchema>;

export interface BuildReceiptInput {
  engine: Motor;
  /** Exact payload sent to the engine (object form). */
  payloadSentToEngine: unknown;
  /** Raw engine response: the raw text (preferred), parsed JSON, or bytes (binary outputs, e.g. PDF). */
  rawEngineResponse: unknown;
  aliquotasUsadas?: AliquotaUsada[];
  statusItens?: StatusItem[];
  knownIssues?: KnownIssue[];
  xmlSha256?: string;
  /** Engine route used (stored in `recibo.motor.rota`). */
  rota?: string;
  now?: Date;
}

/**
 * SHA-256 of the engine output: canonical JSON of the **normalized** output when it is JSON
 * (text or object, see receipt/normalize.ts); raw bytes otherwise (e.g. PDF, non-JSON text).
 */
export function outputSha256(raw: unknown): string {
  return normalizedOutputSha256(raw);
}

/** True when the output is JSON (and therefore hashed after normalization). */
export function isJsonOutput(raw: unknown): boolean {
  if (raw instanceof Uint8Array) return false;
  if (typeof raw !== "string") return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** Legacy (pre-normalization) hash: canonical JSON of the output as received, or raw bytes. */
export function rawOutputSha256(raw: unknown): string {
  if (raw instanceof Uint8Array) return sha256Hex(raw);
  if (typeof raw === "string") {
    try {
      return sha256Hex(canonicalize(JSON.parse(raw)));
    } catch {
      return sha256Hex(raw);
    }
  }
  return sha256Hex(canonicalize(raw));
}

/** Builds and self-validates a receipt (SPEC §6). Throws PersonalDataError on personal data. */
export function buildReceipt(input: BuildReceiptInput): Recibo {
  assertNoPersonalData(input.payloadSentToEngine);
  const canonical = canonicalize(input.payloadSentToEngine);
  const recibo: Recibo = {
    schema: RECIBO_SCHEMA_ID,
    gerado_em: (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    motor: input.rota ? { ...input.engine, rota: input.rota } : input.engine,
    aliquotas_usadas: input.aliquotasUsadas ?? [],
    status_itens: input.statusItens ?? [],
    known_issues: input.knownIssues ?? [],
    input_canonical: JSON.parse(canonical) as unknown,
    input_canonical_sha256: sha256Hex(canonical),
    output_sha256: outputSha256(input.rawEngineResponse),
    ...(isJsonOutput(input.rawEngineResponse) ? { normalizacao: NORMALIZACAO_ID } : {}),
    ...(input.xmlSha256 ? { xml_sha256: input.xmlSha256 } : {}),
    ...(input.rawEngineResponse instanceof Uint8Array
      ? { pdf_sha256: sha256Hex(input.rawEngineResponse) }
      : {}),
    aviso: AVISO_RECIBO,
  };
  const check = verifyReceipt(recibo);
  if (!check.valido) throw new Error(`Recibo inválido: ${check.erros.join("; ")}`);
  return recibo;
}

export interface VerifyResult {
  valido: boolean;
  erros: string[];
  recibo?: Recibo;
}

/**
 * Validates the receipt schema and recomputes `input_canonical_sha256`.
 * When `rawEngineResponse` is given, also checks `output_sha256`.
 */
export function verifyReceipt(candidate: unknown, opts: { rawEngineResponse?: unknown } = {}): VerifyResult {
  const parsed = ReciboSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      valido: false,
      erros: parsed.error.issues.map((i) => `${i.path.join(".") || "recibo"}: ${i.message}`),
    };
  }
  const recibo = parsed.data;
  const erros: string[] = [];
  try {
    if (recibo.input_canonical === undefined) erros.push("input_canonical ausente");
    else if (sha256Hex(canonicalize(recibo.input_canonical)) !== recibo.input_canonical_sha256) {
      erros.push("input_canonical_sha256 não confere com input_canonical");
    }
  } catch (err) {
    erros.push(`input_canonical não canonicalizável: ${(err as Error).message}`);
  }
  const hashOf = recibo.normalizacao ? outputSha256 : rawOutputSha256;
  if (opts.rawEngineResponse !== undefined && hashOf(opts.rawEngineResponse) !== recibo.output_sha256) {
    erros.push("output_sha256 não confere com a resposta do motor");
  }
  return { valido: erros.length === 0, erros, recibo };
}
