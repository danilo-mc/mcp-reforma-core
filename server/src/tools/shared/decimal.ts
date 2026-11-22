import { z } from "zod";

/**
 * Exact decimal helpers (string-based; never multiply floats). Used to convert rate fractions
 * (0.088) into the engine's percentage points (8.8) without artifacts such as 8.799999999999999.
 */

const DECIMAL = /^\d+(\.\d+)?$/;

/** Plain decimal representation of a finite non-negative number (expands exponent notation). */
export function decimalString(value: number | string): string {
  if (typeof value === "string") {
    const s = value.trim().replace(",", ".");
    if (!DECIMAL.test(s)) throw new RangeError(`decimal inválido: ${value}`);
    return s;
  }
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`decimal inválido: ${value}`);
  const s = String(value);
  if (!/e/i.test(s)) return s;
  const [mant, expRaw] = s.toLowerCase().split("e") as [string, string];
  const exp = Number(expRaw);
  const [int, frac = ""] = mant.split(".") as [string, string?];
  return shift(`${int}.${frac}`, exp);
}

function trim(intPart: string, fracPart: string): string {
  const i = intPart.replace(/^0+(?=\d)/, "") || "0";
  const f = fracPart.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/** Moves the decimal point of a plain decimal string by `places` (positive = multiply by 10^places). */
export function shift(decimal: string, places: number): string {
  const [int = "0", frac = ""] = decimal.split(".");
  const digits = int + frac;
  let point = int.length + places;
  let d = digits;
  if (point < 0) {
    d = "0".repeat(-point) + d;
    point = 0;
  }
  if (point > d.length) d = d + "0".repeat(point - d.length);
  return trim(d.slice(0, point) || "0", d.slice(point));
}

/** 0.088 → 8.8 (as a JSON number parsed from the exact decimal string). */
export function fractionToPercentPoints(value: number | string): number {
  return Number(shift(decimalString(value), 2));
}

/** "8.40" → 0.084 (fraction, as a number parsed from the exact decimal string). */
export function percentPointsToFraction(value: number | string): number {
  return Number(shift(decimalString(value), -2));
}

/** Number or decimal string (dot or comma), non-negative. Output: the normalized decimal string. */
export const DecimalInputSchema = z
  .union([
    z.number().nonnegative().finite(),
    z.string().regex(/^\s*\d+([.,]\d+)?\s*$/, "use um número decimal"),
  ])
  .transform((v) => decimalString(v));
