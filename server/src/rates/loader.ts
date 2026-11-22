import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import type { AliquotaUsada } from "../receipt/receipt.ts";
import {
  RateEntryInputSchema,
  RatesFileSchema,
  type RateEntry,
  type Tributo,
  type UsableRateEntry,
} from "./schema.ts";

export const PLACEHOLDER_MARKER = "TODO(VALIDAR)";
/** From this date on, the server must inject rates from rates/ (SPEC §5.1). */
export const INJECTION_START_DATE = "2027-01-01";

export class RatesConfigError extends Error {
  readonly problemas: string[];
  constructor(problemas: string[]) {
    super(`Arquivo de alíquotas inválido: ${problemas.join("; ")}`);
    this.name = "RatesConfigError";
    this.problemas = problemas;
  }
}

/** Raised when a date ≥ 2027-01-01 requires rates that are still pending validation. */
export class AliquotasNaoValidadasError extends Error {
  readonly data: string;
  readonly tributos: Tributo[];
  constructor(data: string, tributos: Tributo[]) {
    super(
      `As alíquotas de ${tributos.join(", ")} para ${data} ainda não foram validadas contra a fonte oficial ` +
        `(arquivo rates/ com marcação ${PLACEHOLDER_MARKER}). Por segurança, nenhum cálculo é feito com ` +
        `alíquotas não validadas. Tente novamente quando o arquivo de alíquotas for atualizado com fonte e data.`,
    );
    this.name = "AliquotasNaoValidadasError";
    this.data = data;
    this.tributos = tributos;
  }
}

export interface RatesFileInfo {
  arquivo: string;
  version: string;
  /** True if the raw file text contains the TODO(VALIDAR) marker anywhere (incl. comments). */
  contem_marcador: boolean;
}

export interface RatesSnapshot {
  dir: string;
  arquivos: RatesFileInfo[];
  /** Most recent `version` across files (string comparison; versions are ISO dates). */
  version: string | null;
  entries: RateEntry[];
  /** Schema/overlap problems. A non-empty list means the configuration is invalid. */
  problemas: string[];
}

export interface RateFilters {
  uf?: string | undefined;
  municipio_ibge?: string | undefined;
  produto?: string | undefined;
}

function parseFile(path: string, problemas: string[]): { info: RatesFileInfo; entries: RateEntry[] } | null {
  const arquivo = basename(path);
  const text = readFileSync(path, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    problemas.push(`${arquivo}: YAML inválido (${doc.errors.map((e) => e.message).join("; ")})`);
    return null;
  }
  const fileParsed = RatesFileSchema.safeParse(doc.toJS());
  if (!fileParsed.success) {
    problemas.push(
      ...fileParsed.error.issues.map((i) => `${arquivo}: ${i.path.join(".") || "(raiz)"}: ${i.message}`),
    );
    return null;
  }
  const info: RatesFileInfo = {
    arquivo,
    version: fileParsed.data.version,
    contem_marcador: text.includes(PLACEHOLDER_MARKER),
  };

  // Source text of each entry (including inline comments) to detect TODO(VALIDAR) per entry.
  const entriesNode = doc.get("entries", true);
  const entryTexts: string[] = [];
  if (isSeq(entriesNode)) {
    for (const item of entriesNode.items) {
      const range = isMap(item) ? item.range : undefined;
      entryTexts.push(range ? text.slice(range[0], range[2]) : "");
    }
  }

  const entries: RateEntry[] = [];
  fileParsed.data.entries.forEach((raw, indice) => {
    const parsed = RateEntryInputSchema.safeParse(raw);
    if (!parsed.success) {
      problemas.push(
        ...parsed.error.issues.map((i) => `${arquivo}: entries[${indice}].${i.path.join(".")}: ${i.message}`),
      );
      return;
    }
    const e = parsed.data;
    const motivos: string[] = [];
    if (e.valor === null || e.valor === undefined) motivos.push("valor ausente");
    if (!e.fonte || e.fonte.trim() === "") motivos.push("fonte ausente");
    if (!e.data_fonte) motivos.push("data_fonte ausente");
    if (!e.situacao) motivos.push("situacao ausente");
    if (!e.vigencia) motivos.push("vigencia ausente");
    const entryText = entryTexts[indice] ?? "";
    const fieldsText = [e.fonte, e.url_fonte, e.notas].filter(Boolean).join(" ");
    if (entryText.includes(PLACEHOLDER_MARKER) || fieldsText.includes(PLACEHOLDER_MARKER)) {
      motivos.push(`marcado ${PLACEHOLDER_MARKER}`);
    }
    entries.push({
      tributo: e.tributo,
      vigencia: e.vigencia ?? null,
      valor: e.valor ?? null,
      situacao: e.situacao ?? null,
      fonte: e.fonte ?? null,
      url_fonte: e.url_fonte ?? "",
      data_fonte: e.data_fonte ?? null,
      notas: e.notas ?? null,
      uf: e.uf ?? null,
      municipio_ibge: e.municipio_ibge ?? null,
      produto: e.produto ?? null,
      arquivo,
      versao_arquivo: info.version,
      indice,
      pendente: motivos.length > 0,
      motivos_pendencia: motivos,
    });
  });
  return { info, entries };
}

const scopeKey = (e: RateEntry) =>
  `${e.tributo}|${e.uf ?? "*"}|${e.municipio_ibge ?? "*"}|${e.produto ?? "*"}`;

export function findOverlaps(entries: RateEntry[]): string[] {
  const problems: string[] = [];
  const groups = new Map<string, RateEntry[]>();
  for (const e of entries) {
    if (!e.vigencia) continue;
    const k = scopeKey(e);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const [k, list] of groups) {
    const sorted = [...list].sort((a, b) => a.vigencia!.inicio.localeCompare(b.vigencia!.inicio));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.vigencia!.inicio <= prev.vigencia!.fim) {
        problems.push(
          `vigências sobrepostas para ${k}: ${prev.arquivo}#${prev.indice} (${prev.vigencia!.inicio}/${prev.vigencia!.fim}) e ` +
            `${cur.arquivo}#${cur.indice} (${cur.vigencia!.inicio}/${cur.vigencia!.fim})`,
        );
      }
    }
  }
  return problems;
}

/**
 * Reads and validates every `*.yaml|*.yml` in `dir`. Throws RatesConfigError on schema problems
 * or overlapping vigências unless `lenient` is set (then problems are returned in the snapshot).
 */
export function loadRates(dir: string, opts: { lenient?: boolean } = {}): RatesSnapshot {
  const problemas: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort();
  } catch {
    problemas.push(`diretório de alíquotas não encontrado: ${dir}`);
    files = [];
  }
  const arquivos: RatesFileInfo[] = [];
  const entries: RateEntry[] = [];
  for (const f of files) {
    const r = parseFile(join(dir, f), problemas);
    if (r) {
      arquivos.push(r.info);
      entries.push(...r.entries);
    }
  }
  problemas.push(...findOverlaps(entries));
  const version =
    arquivos
      .map((a) => a.version)
      .sort()
      .at(-1) ?? null;
  const snapshot: RatesSnapshot = { dir, arquivos, version, entries, problemas };
  if (problemas.length > 0 && !opts.lenient) throw new RatesConfigError(problemas);
  return snapshot;
}

export function isUsable(e: RateEntry): e is UsableRateEntry {
  return !e.pendente;
}

function covers(e: RateEntry, date: string): boolean {
  if (!e.vigencia) return true; // placeholders without vigência are reported for any date
  return e.vigencia.inicio <= date && date <= e.vigencia.fim;
}

function matchesScope(e: RateEntry, f: RateFilters): boolean {
  switch (e.tributo) {
    case "CBS":
      return true;
    case "IBS_UF":
      return !e.uf || !f.uf || e.uf === f.uf.toUpperCase();
    case "IBS_MUN":
      return !e.municipio_ibge || !f.municipio_ibge || e.municipio_ibge === f.municipio_ibge;
    case "IS":
      return !f.produto || !e.produto || e.produto === f.produto;
  }
}

/** Specificity: entries for the exact UF/município/produto win over generic ones. */
function specificity(e: RateEntry): number {
  return (e.uf ? 1 : 0) + (e.municipio_ibge ? 1 : 0) + (e.produto ? 1 : 0);
}

export interface RatesSelection {
  data: string;
  version: string | null;
  /** Usable (validated) entries for the date, most specific per tributo/escopo first. */
  aplicaveis: UsableRateEntry[];
  /** Placeholder entries relevant to the date — listed, never used. */
  pendentes: RateEntry[];
}

export function selectRates(
  snapshot: RatesSnapshot,
  date: string,
  filters: RateFilters = {},
): RatesSelection {
  const relevant = snapshot.entries.filter((e) => covers(e, date) && matchesScope(e, filters));
  const usable = relevant.filter(isUsable);
  const byTributo = new Map<string, UsableRateEntry[]>();
  for (const e of usable) {
    const k = e.tributo === "IS" ? `IS|${e.produto ?? "*"}` : e.tributo;
    byTributo.set(k, [...(byTributo.get(k) ?? []), e]);
  }
  const aplicaveis: UsableRateEntry[] = [];
  for (const list of byTributo.values()) {
    const max = Math.max(...list.map(specificity));
    aplicaveis.push(...list.filter((e) => specificity(e) === max));
  }
  return {
    data: date,
    version: snapshot.version,
    aplicaveis,
    pendentes: relevant.filter((e) => e.pendente),
  };
}

export interface RequiredRates {
  /** False for dates before 2027-01-01: the engine uses its internal reference rates. */
  injetar: boolean;
  selection: RatesSelection;
  aliquotasUsadas: AliquotaUsada[];
}

/**
 * Rates to inject into an engine payload. For dates ≥ 2027-01-01 every required tributo must have a
 * validated entry, otherwise AliquotasNaoValidadasError (never falls back to placeholders).
 */
export function requireRates(
  snapshot: RatesSnapshot,
  date: string,
  filters: RateFilters = {},
  tributos: Tributo[] = ["CBS", "IBS_UF", "IBS_MUN"],
): RequiredRates {
  const selection = selectRates(snapshot, date, filters);
  if (date < INJECTION_START_DATE) return { injetar: false, selection, aliquotasUsadas: [] };
  const missing = tributos.filter((t) => !selection.aplicaveis.some((e) => e.tributo === t));
  if (missing.length > 0) throw new AliquotasNaoValidadasError(date, missing);
  const used = selection.aplicaveis.filter((e) => tributos.includes(e.tributo));
  return { injetar: true, selection, aliquotasUsadas: used.map(toAliquotaUsada) };
}

export function toAliquotaUsada(e: UsableRateEntry): AliquotaUsada {
  return {
    tributo: e.tributo,
    valor: e.valor,
    vigencia: `${e.vigencia.inicio}/${e.vigencia.fim}`,
    fonte: e.fonte,
    url_fonte: e.url_fonte,
    data_fonte: e.data_fonte,
    situacao: e.situacao,
    rates_file_version: e.versao_arquivo,
    ...(e.uf ? { uf: e.uf } : {}),
    ...(e.municipio_ibge ? { municipio_ibge: e.municipio_ibge } : {}),
    ...(e.produto ? { produto: e.produto } : {}),
  };
}

/** Cached loader for the server process (rates are baked into the image). */
export class RatesRepository {
  private snapshot: RatesSnapshot | undefined;
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  get(): RatesSnapshot {
    this.snapshot ??= loadRates(this.dir);
    return this.snapshot;
  }
  reload(): RatesSnapshot {
    this.snapshot = undefined;
    return this.get();
  }
}
