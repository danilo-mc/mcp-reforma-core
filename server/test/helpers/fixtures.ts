import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../../src/config.ts";

/** Scratch root inside the project (never the OS temp dir). Ignored by git via `.tmp/`. */
export const SCRATCH_ROOT = fileURLToPath(new URL("../../.tmp/", import.meta.url));

export function scratchDir(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeRates(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return dir;
}

/** Repo-root rates/ directory (the real, placeholder-only 2027.yaml). */
export const REPO_RATES_DIR = fileURLToPath(new URL("../../../rates", import.meta.url));

/**
 * Test-only rates fixture. Values are deliberately fake (0.0101, 0.0202…) and do NOT represent
 * any real tax rate.
 */
export const FAKE_VALID_RATES = `
version: "2099-01-01"
entries:
  - tributo: CBS
    vigencia: { inicio: 2027-01-01, fim: 2027-12-31 }
    valor: 0.0101
    situacao: provisoria
    fonte: "Fonte fictícia de teste"
    url_fonte: "https://example.invalid/cbs"
    data_fonte: 2026-01-01
  - tributo: IBS_UF
    vigencia: { inicio: 2027-01-01, fim: 2027-12-31 }
    valor: 0.0202
    situacao: oficial
    fonte: "Fonte fictícia de teste"
    url_fonte: ""
    data_fonte: 2026-01-01
  - tributo: IBS_UF
    uf: SP
    vigencia: { inicio: 2027-01-01, fim: 2027-12-31 }
    valor: 0.0203
    situacao: oficial
    fonte: "Fonte fictícia de teste SP"
    url_fonte: ""
    data_fonte: 2026-01-01
  - tributo: IBS_MUN
    vigencia: { inicio: 2027-01-01, fim: 2027-12-31 }
    valor: 0.0303
    situacao: oficial
    fonte: "Fonte fictícia de teste"
    url_fonte: ""
    data_fonte: 2026-01-01
  - tributo: IS
    produto: bebidas_acucaradas
    vigencia: { inicio: 2027-01-01, fim: 2027-12-31 }
    valor: null # TODO(VALIDAR)
    situacao: provisoria
    fonte: null
    url_fonte: ""
    data_fonte: null
`;

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    LOG_LEVEL: "silent",
    RATES_DIR: REPO_RATES_DIR,
    PDF_LOCAL_DIR: join(SCRATCH_ROOT, "pdf"),
    UPSTREAM_REGULAR_SHA: "f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4",
    UPSTREAM_SIMPLES_SHA: "a926d5a76095ac0295a6612a9a54db7ffead2396",
    ENGINE_RETRIES: "0",
    ...overrides,
  });
}
