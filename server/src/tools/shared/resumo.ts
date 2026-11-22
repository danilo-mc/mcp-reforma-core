import { MESSAGES } from "../../i18n/pt-BR.ts";
import type { AliquotaUsada } from "../../receipt/receipt.ts";
import { NON_NUMERIC_STATUSES } from "../../status.ts";

/**
 * Rules for `resumo_humano` (SPEC §6, §10):
 * 1. If any rate used is `provisoria`, say so explicitly.
 * 2. Items with NAO_IMPLEMENTADO / INCONSISTENCIA_ENTRADA / FALHA_TECNICA never show numbers
 *    (not even their description or engine message, which could contain digits).
 * 3. Values are the engine's, printed without re-rounding.
 */

export interface ResumoItem {
  /** 1-based item number. */
  item: number;
  status: string;
  descricao?: string | undefined;
  /** Values per tributo as returned by the engine (numbers or decimal strings, e.g. { CBS: "12.34" }). */
  valores?: Record<string, number | string | null | undefined> | undefined;
}

export interface ResumoInput {
  /** Opening sentence, e.g. "Cálculo no regime regular para 2027-03-15". */
  titulo: string;
  itens: ResumoItem[];
  /** Totals per tributo as returned by the engine. */
  totais?: Record<string, number | string | null | undefined> | null | undefined;
  aliquotas?: AliquotaUsada[] | undefined;
  avisos?: string[] | undefined;
}

/** Formats a monetary value in pt-BR without re-rounding (keeps every decimal the engine sent). */
export function formatValor(n: number): string {
  return `R$ ${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 20 }).format(n)}`;
}

/**
 * Formats an engine decimal string in pt-BR without converting to float ("1234.50" → "R$ 1.234,50").
 * Returns undefined when the string is not a plain decimal.
 */
export function formatValorDecimal(s: string): string | undefined {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return undefined;
  const [, sinal, int, frac] = m;
  const milhar = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const dec = (frac ?? "").padEnd(2, "0");
  return `${sinal ? "-" : ""}R$ ${milhar},${dec}`;
}

/** Formats a rate fraction as a percentage string without rounding (0.1 → "10%"). */
export function formatPercentual(fracao: number): string {
  const pct = Number((fracao * 100).toPrecision(15));
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 20 }).format(pct)}%`;
}

export function provisionalWarning(aliquotas: AliquotaUsada[] | undefined): string | undefined {
  const prov = (aliquotas ?? []).filter((a) => a.situacao === "provisoria");
  if (prov.length === 0) return undefined;
  return MESSAGES.aliquotaProvisoria([...new Set(prov.map((a) => a.tributo))]);
}

function valoresTexto(valores: ResumoItem["valores"]): string {
  const parts = Object.entries(valores ?? {}).flatMap(([k, v]) => {
    if (typeof v === "number" && Number.isFinite(v)) return [`${k} ${formatValor(v)}`];
    if (typeof v === "string") {
      const f = formatValorDecimal(v);
      return f ? [`${k} ${f}`] : [];
    }
    return [];
  });
  return parts.length > 0 ? parts.join(", ") : "sem valores retornados";
}

export function buildResumoHumano(input: ResumoInput): string {
  const lines: string[] = [input.titulo];
  const prov = provisionalWarning(input.aliquotas);
  if (prov) lines.push(prov);
  for (const it of input.itens) {
    if (NON_NUMERIC_STATUSES.has(it.status)) {
      lines.push(`• Item ${it.item} — ${MESSAGES.semValorPorStatus(it.status)}`);
    } else {
      const desc = it.descricao ? ` (${it.descricao})` : "";
      lines.push(`• Item ${it.item}${desc} — ${it.status}: ${valoresTexto(it.valores)}`);
    }
  }
  if (input.totais && Object.keys(input.totais).length > 0) {
    lines.push(`Totais: ${valoresTexto(input.totais)}`);
  }
  for (const a of input.avisos ?? []) lines.push(a);
  lines.push(MESSAGES.disclaimer);
  return lines.join("\n");
}
