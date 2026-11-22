import { createHash } from "node:crypto";

/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * - Object members sorted by key, comparing UTF-16 code units (JS default sort).
 * - No insignificant whitespace.
 * - Strings serialised per ECMAScript JSON.stringify (RFC 8785 §3.2.2.2).
 * - Numbers serialised per ECMAScript Number.prototype.toString (RFC 8785 §3.2.2.3);
 *   NaN/Infinity are rejected. -0 becomes 0.
 * - Lone surrogates are rejected (I-JSON, RFC 7493).
 */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new CanonicalizationError("string com surrogate isolado");
  return JSON.stringify(s);
}

function serialize(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError("número não finito");
      out.push(Object.is(value, -0) ? "0" : String(value));
      return;
    case "string":
      out.push(serializeString(value));
      return;
    case "object": {
      const withToJson = value as { toJSON?: () => unknown };
      if (typeof withToJson.toJSON === "function") {
        serialize(withToJson.toJSON(), out);
        return;
      }
      if (Array.isArray(value)) {
        out.push("[");
        value.forEach((v, i) => {
          if (i > 0) out.push(",");
          serialize(v === undefined || typeof v === "function" ? null : v, out);
        });
        out.push("]");
        return;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
        .sort();
      out.push("{");
      keys.forEach((k, i) => {
        if (i > 0) out.push(",");
        out.push(serializeString(k), ":");
        serialize(obj[k], out);
      });
      out.push("}");
      return;
    }
    default:
      throw new CanonicalizationError(`tipo não serializável: ${typeof value}`);
  }
}

/** Returns the RFC 8785 canonical JSON string of `value`. */
export function canonicalize(value: unknown): string {
  if (value === undefined) throw new CanonicalizationError("valor indefinido");
  const out: string[] = [];
  serialize(value, out);
  return out.join("");
}

/** SHA-256 hex of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex of the canonical JSON of `value`. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
