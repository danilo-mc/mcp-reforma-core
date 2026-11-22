import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_RATES_DIR } from "../config.ts";
import { loadRates, PLACEHOLDER_MARKER } from "./loader.ts";

export interface CheckResult {
  ok: boolean;
  linhas: string[];
}

/**
 * Validates rates/*.yaml.
 * - default: schema + overlaps must be valid; placeholders are allowed but listed.
 * - strict:  also fails on any placeholder entry or any TODO(VALIDAR) marker in the files.
 */
export function runRatesCheck(dir: string, strict: boolean): CheckResult {
  const snap = loadRates(dir, { lenient: true });
  const linhas: string[] = [];
  let ok = true;
  linhas.push(`Diretório: ${dir}`);
  for (const a of snap.arquivos) linhas.push(`Arquivo ${a.arquivo} — version ${a.version}`);
  if (snap.arquivos.length === 0) {
    linhas.push("ERRO: nenhum arquivo de alíquotas encontrado");
    ok = false;
  }
  for (const p of snap.problemas) {
    linhas.push(`ERRO: ${p}`);
    ok = false;
  }
  const pendentes = snap.entries.filter((e) => e.pendente);
  const validas = snap.entries.length - pendentes.length;
  linhas.push(`Entradas: ${snap.entries.length} (${validas} validadas, ${pendentes.length} pendentes)`);
  for (const e of pendentes) {
    const escopo = [e.uf, e.municipio_ibge, e.produto].filter(Boolean).join("/");
    linhas.push(
      `${strict ? "ERRO" : "PENDENTE"}: ${e.arquivo}#${e.indice} ${e.tributo}${escopo ? ` (${escopo})` : ""}: ${e.motivos_pendencia.join(", ")}`,
    );
  }
  if (strict) {
    if (pendentes.length > 0) ok = false;
    for (const a of snap.arquivos.filter((x) => x.contem_marcador)) {
      linhas.push(`ERRO: ${a.arquivo} contém o marcador ${PLACEHOLDER_MARKER}`);
      ok = false;
    }
  }
  linhas.push(ok ? "OK" : "FALHOU");
  return { ok, linhas };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const strict = process.argv.includes("--strict");
  const dirArg = process.argv.find((a) => a.startsWith("--dir="));
  const dir = dirArg ? dirArg.slice(6) : (process.env.RATES_DIR ?? DEFAULT_RATES_DIR);
  const res = runRatesCheck(dir, strict);
  process.stdout.write(`${res.linhas.join("\n")}\n`);
  process.exitCode = res.ok ? 0 : 1;
}
