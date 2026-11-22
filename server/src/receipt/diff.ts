export interface DiffEntry {
  /** RFC 6901 JSON pointer. "" = document root. */
  path: string;
  tipo: "alterado" | "adicionado" | "removido";
  antes?: unknown;
  depois?: unknown;
}

export interface CompareResult {
  confere: boolean;
  diff: DiffEntry[];
}

const escapePointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function walk(a: unknown, b: unknown, path: string, out: DiffEntry[], limit: number): void {
  if (out.length >= limit) return;
  const ka = kind(a);
  const kb = kind(b);
  if (ka !== kb) {
    out.push({ path, tipo: "alterado", antes: a, depois: b });
    return;
  }
  if (ka === "array") {
    const aa = a as unknown[];
    const bb = b as unknown[];
    const n = Math.max(aa.length, bb.length);
    for (let i = 0; i < n && out.length < limit; i++) {
      const p = `${path}/${i}`;
      if (i >= aa.length) out.push({ path: p, tipo: "adicionado", depois: bb[i] });
      else if (i >= bb.length) out.push({ path: p, tipo: "removido", antes: aa[i] });
      else walk(aa[i], bb[i], p, out, limit);
    }
    return;
  }
  if (ka === "object") {
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort();
    for (const k of keys) {
      if (out.length >= limit) return;
      const p = `${path}/${escapePointer(k)}`;
      const inA = Object.prototype.hasOwnProperty.call(oa, k) && oa[k] !== undefined;
      const inB = Object.prototype.hasOwnProperty.call(ob, k) && ob[k] !== undefined;
      if (!inA && inB) out.push({ path: p, tipo: "adicionado", depois: ob[k] });
      else if (inA && !inB) out.push({ path: p, tipo: "removido", antes: oa[k] });
      else walk(oa[k], ob[k], p, out, limit);
    }
    return;
  }
  if (!Object.is(a, b) && !(a === 0 && b === 0)) out.push({ path, tipo: "alterado", antes: a, depois: b });
}

/**
 * Structural comparison of two JSON values (e.g. original vs. re-executed engine output).
 * No numeric tolerance: the engine is deterministic and we never re-round.
 */
export function compareOutputs(a: unknown, b: unknown, limit = 200): CompareResult {
  const diff: DiffEntry[] = [];
  walk(a, b, "", diff, limit);
  return { confere: diff.length === 0, diff };
}
