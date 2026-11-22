import type { Config } from "../config.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { EngineClient } from "./client.ts";
import { ENGINE_PROBES, ENGINE_REPOS, type EngineName, type EngineProbe } from "./routes.ts";

export type Engines = Record<EngineName, EngineClient>;

export const ENGINE_NAMES: readonly EngineName[] = ["regular", "simples"];

/** Builds an engine client with the shared timeout/retry/circuit-breaker settings. */
export function createEngineClient(
  config: Config,
  name: string,
  baseUrl: string,
  fetchImpl?: typeof fetch,
): EngineClient {
  return new EngineClient({
    name,
    baseUrl,
    timeoutMs: config.ENGINE_TIMEOUT_MS,
    retries: config.ENGINE_RETRIES,
    breaker: new CircuitBreaker({
      threshold: config.ENGINE_BREAKER_THRESHOLD,
      cooldownMs: config.ENGINE_BREAKER_COOLDOWN_MS,
    }),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export function createEngines(config: Config, fetchImpl?: typeof fetch): Engines {
  return {
    regular: createEngineClient(config, "regular", config.ENGINE_REGULAR_URL, fetchImpl),
    simples: createEngineClient(config, "simples", config.ENGINE_SIMPLES_URL, fetchImpl),
  };
}

export interface EngineStatus {
  nome: string;
  repositorio: string;
  /** Pinned upstream commit (UPSTREAM_*_SHA), if known. */
  commit: string | null;
  disponivel: boolean;
  /** Application version reported by the engine (e.g. versaoApp). */
  versao: string | null;
  /** Database version reported by the engine (e.g. versaoDb, "V0059"). */
  versao_base: string | null;
  data_base: string | null;
  latencia_ms: number | null;
  erro: string | null;
}

/** One engine probed by /health, /versao and the `versao` tool (core engines + extension engines). */
export interface EngineProbeTarget {
  nome: string;
  client: EngineClient;
  repositorio: string;
  commit: string | null;
  probe: EngineProbe;
}

export function engineCommit(config: Config, name: EngineName): string | null {
  const sha = name === "regular" ? config.UPSTREAM_REGULAR_SHA : config.UPSTREAM_SIMPLES_SHA;
  return sha ?? null;
}

export function engineRepo(config: Config, name: EngineName): string {
  const repo = name === "regular" ? config.UPSTREAM_REGULAR_REPO : config.UPSTREAM_SIMPLES_REPO;
  return repo || ENGINE_REPOS[name];
}

export function coreProbeTargets(engines: Engines, config: Config): EngineProbeTarget[] {
  return ENGINE_NAMES.map((nome) => ({
    nome,
    client: engines[nome],
    repositorio: engineRepo(config, nome),
    commit: engineCommit(config, nome),
    probe: ENGINE_PROBES[nome],
  }));
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Probes one engine: version route when available (also used as liveness), else the health route. */
export async function probeEngine(target: EngineProbeTarget, timeoutMs = 3000): Promise<EngineStatus> {
  const { client, probe } = target;
  const base: EngineStatus = {
    nome: target.nome,
    repositorio: target.repositorio,
    commit: target.commit,
    disponivel: false,
    versao: null,
    versao_base: null,
    data_base: null,
    latencia_ms: null,
    erro: null,
  };
  try {
    if (probe.versao) {
      const res = await client.getJson<Record<string, unknown>>(probe.versao, undefined, {
        timeoutMs,
        retryable: false,
        allowHttpErrors: true,
      });
      base.latencia_ms = res.latencyMs;
      base.disponivel = res.ok;
      if (res.ok && res.body && typeof res.body === "object") {
        base.versao = str(res.body.versaoApp);
        base.versao_base = str(res.body.versaoDb);
        base.data_base = str(res.body.dataVersaoDb);
      } else if (!res.ok) {
        base.erro = `HTTP ${res.status}`;
      }
    } else {
      const res = await client.request({
        method: "GET",
        path: probe.health,
        responseType: "text",
        timeoutMs,
        retryable: false,
        allowHttpErrors: true,
      });
      base.latencia_ms = res.latencyMs;
      base.disponivel = res.ok;
      if (!res.ok) base.erro = `HTTP ${res.status}`;
    }
  } catch (err) {
    base.erro = (err as Error).message;
  }
  return base;
}

/** Probes all engines in parallel with a small cache so /health and `versao` don't hammer engines. */
export class EngineProber {
  private cache: { at: number; value: EngineStatus[] } | undefined;
  private inflight: Promise<EngineStatus[]> | undefined;
  private readonly targets: EngineProbeTarget[];
  private readonly ttlMs: number;

  constructor(targets: EngineProbeTarget[], ttlMs = 5000) {
    this.targets = [...targets];
    this.ttlMs = ttlMs;
  }

  /** Adds an engine (e.g. from an extension). Invalidates the cache. */
  register(target: EngineProbeTarget): void {
    this.targets.push(target);
    this.cache = undefined;
  }

  names(): string[] {
    return this.targets.map((t) => t.nome);
  }

  async probeAll(force = false): Promise<EngineStatus[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = Promise.all(this.targets.map((t) => probeEngine(t))).finally(() => {
      this.inflight = undefined;
    });
    const value = await this.inflight;
    this.cache = { at: Date.now(), value };
    return value;
  }

  async get(name: string): Promise<EngineStatus> {
    const all = await this.probeAll();
    const s = all.find((x) => x.nome === name);
    if (!s) throw new Error(`motor desconhecido: ${name}`);
    return s;
  }

  /** `recibo.motor` block for receipts. */
  async motor(name: string): Promise<{
    repositorio: string;
    commit: string | null;
    versao: string | null;
    versao_base: string | null;
  }> {
    const s = await this.get(name);
    return { repositorio: s.repositorio, commit: s.commit, versao: s.versao, versao_base: s.versao_base };
  }
}
