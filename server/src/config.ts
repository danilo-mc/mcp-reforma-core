import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Server package root (works from both `src/` and `dist/`). */
export const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Default rates directory: `<repo>/rates`, i.e. a sibling of `server/`. */
export const DEFAULT_RATES_DIR = fileURLToPath(new URL("../../rates", import.meta.url));

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Env-parsing helpers (also used by extensions for their own settings).
export const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
export const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
export const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());
export const intWithDefault = (def: number, min = 0) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).default(def));
/** "true"/"1"/"on"/"yes" → true, "false"/"0"/"off"/"no" → false, empty → default. */
export const boolWithDefault = (def: boolean) =>
  z.preprocess((v) => {
    const s = emptyToUndefined(v);
    if (typeof s !== "string") return s;
    const t = s.trim().toLowerCase();
    if (["true", "1", "on", "yes", "sim"].includes(t)) return true;
    if (["false", "0", "off", "no", "nao", "não"].includes(t)) return false;
    return s;
  }, z.boolean().default(def));

export const ConfigSchema = z.object({
  MCP_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(["stdio", "http"]).default("stdio")),
  PORT: intWithDefault(3000, 0).pipe(z.number().max(65535)),
  HOST: z.preprocess(emptyToUndefined, z.string().default("0.0.0.0")),
  /** Comma-separated list of allowed Host headers (DNS rebinding protection). Empty = disabled. */
  ALLOWED_HOSTS: optionalString,
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),

  ENGINE_REGULAR_URL: z.preprocess(emptyToUndefined, z.url().default("http://localhost:8080/api")),
  ENGINE_SIMPLES_URL: z.preprocess(emptyToUndefined, z.url().default("http://localhost:8082/api")),
  ENGINE_TIMEOUT_MS: intWithDefault(10_000, 1),
  ENGINE_RETRIES: intWithDefault(2, 0),
  ENGINE_BREAKER_THRESHOLD: intWithDefault(5, 1),
  ENGINE_BREAKER_COOLDOWN_MS: intWithDefault(30_000, 0),

  FRONT_DOOR_ID: optionalString,
  /**
   * Coarse per-IP limit on /mcp (requests/min). 0 disables it. Behind Claude/ChatGPT connectors all
   * users share the vendors' egress IPs, so with AUTH_MODE=required keep it high or 0 and rely on the
   * per-user quotas of the quota extension.
   */
  RATE_LIMIT_PER_MIN: intWithDefault(60, 0),
  TRUST_PROXY: z.preprocess(emptyToUndefined, z.string().default("1")),
  MAX_BODY_BYTES: intWithDefault(2 * 1024 * 1024, 1024),
  MAX_ITEMS: intWithDefault(200, 1),

  UPSTREAM_REGULAR_REPO: z.preprocess(
    emptyToUndefined,
    z.string().default("ReceitaFederal/calculadora-rtc-regime-regular"),
  ),
  UPSTREAM_SIMPLES_REPO: z.preprocess(
    emptyToUndefined,
    z.string().default("ReceitaFederal/calculadora-rtc-simples-nacional"),
  ),
  UPSTREAM_REGULAR_SHA: optionalString,
  UPSTREAM_SIMPLES_SHA: optionalString,

  APPLICATIONINSIGHTS_CONNECTION_STRING: optionalString,
  SERVER_VERSION: z.preprocess(emptyToUndefined, z.string().default(readPackageVersion())),
  /** ISO timestamp of the image build, injected by the Dockerfile. */
  BUILD_TIME: optionalString,
  RATES_DIR: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_RATES_DIR)),
});

export type Config = z.infer<typeof ConfigSchema> & {
  /** Raw environment the config was loaded from; extensions parse their own settings from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parses an extension's settings from the raw environment, with the same error format as loadConfig. */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Readonly<Record<string, string | undefined>>,
): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Configuração inválida: ${details}`);
  }
  return parsed.data;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Configuração inválida: ${details}`);
  }
  return { ...parsed.data, env: { ...env } };
}
