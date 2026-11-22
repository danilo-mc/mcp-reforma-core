import { canonicalize, sha256Hex } from "./jcs.ts";

/**
 * Normalization applied to JSON engine outputs before hashing (`recibo.output_sha256`).
 * The raw engine response is never modified; only the hashed/compared view is normalized.
 *
 * Rules (mcp-reforma/normalizacao@1):
 * 1. `timestamp` is removed from problem+json objects (objects that also have `title` and
 *    `status` or `detail`) — e.g. the HTTP 422 "erro global" body of the regular engine.
 * 2. `type` values that are absolute http(s) URLs keep only path + query + fragment: the engine
 *    builds them from the request `Host` header (`http://engine-regular/api/...?codigo=REG-005`).
 * 3. Arrays under the keys `erros` / `errors` are sorted by (code|codigo, pointer|campo,
 *    title|titulo, detail|mensagem, canonical JSON): their order is not deterministic upstream.
 * Everything else (values, decimal strings, other arrays) is kept exactly as received.
 */
export const NORMALIZACAO_ID = "mcp-reforma/normalizacao@1";

const ERROR_ARRAY_KEYS = new Set(["erros", "errors"]);
const ABSOLUTE_URL = /^https?:\/\/[^/?#]*/i;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function isProblemDetail(o: Record<string, unknown>): boolean {
  return "title" in o && ("status" in o || "detail" in o);
}

const str = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return canonicalize(v);
};

function errorSortKey(e: unknown): string[] {
  if (!isObject(e)) return ["", "", "", "", canonicalize(e)];
  return [
    str(e.code ?? e.codigo),
    str(e.pointer ?? e.campo),
    str(e.title ?? e.titulo),
    str(e.detail ?? e.mensagem),
    canonicalize(e),
  ];
}

function compareKeys(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Strips scheme and host from absolute http(s) URLs: "http://h/api/x?c=1" → "/api/x?c=1". */
export function stripUrlHost(value: string): string {
  if (!ABSOLUTE_URL.test(value)) return value;
  const rest = value.replace(ABSOLUTE_URL, "");
  return rest === "" ? "/" : rest;
}

function normalizeValue(value: unknown, key: string | undefined): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => normalizeValue(v, undefined));
    if (key !== undefined && ERROR_ARRAY_KEYS.has(key)) {
      return items
        .map((v) => ({ v, k: errorSortKey(v) }))
        .sort((a, b) => compareKeys(a.k, b.k))
        .map((x) => x.v);
    }
    return items;
  }
  if (isObject(value)) {
    const problem = isProblemDetail(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (problem && k === "timestamp") continue;
      if (k === "type" && typeof v === "string") out[k] = stripUrlHost(v);
      else out[k] = normalizeValue(v, k);
    }
    return out;
  }
  return value;
}

/** Returns a normalized deep copy of a parsed JSON engine output (input is not mutated). */
export function normalizeEngineOutput(value: unknown): unknown {
  return normalizeValue(value, undefined);
}

/**
 * Parses an engine output (raw text or already-parsed JSON). Returns `undefined` when it is not JSON
 * (binary or non-JSON text), in which case it must be hashed byte-for-byte.
 */
export function parseEngineJson(raw: unknown): { json: unknown } | undefined {
  if (raw instanceof Uint8Array) return undefined;
  if (typeof raw === "string") {
    try {
      return { json: JSON.parse(raw) as unknown };
    } catch {
      return undefined;
    }
  }
  return { json: raw };
}

/** SHA-256 of the canonical JSON of the normalized output; raw bytes when the output is not JSON. */
export function normalizedOutputSha256(raw: unknown): string {
  const parsed = parseEngineJson(raw);
  if (!parsed) return sha256Hex(raw as string | Uint8Array);
  return sha256Hex(canonicalize(normalizeEngineOutput(parsed.json)));
}
