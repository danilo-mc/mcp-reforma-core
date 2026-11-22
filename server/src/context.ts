import type { Logger } from "pino";
import type { Config } from "./config.ts";
import { coreProbeTargets, createEngines, EngineProber, type Engines } from "./engine-client/engines.ts";
import { extensions as defaultExtensions } from "./extensions/index.ts";
import type { Extension } from "./extensions/types.ts";
import { getLogger } from "./observability/logger.ts";
import { RatesRepository } from "./rates/loader.ts";

/** Everything a tool handler may use. Built once per process; shared by all MCP sessions. */
export interface AppContext {
  config: Config;
  engines: Engines;
  prober: EngineProber;
  rates: RatesRepository;
  logger: Logger;
  now: () => Date;
  startedAt: Date;
  /** Enabled extensions, in order. */
  extensions: readonly Extension[];
  /** Per-context state owned by extensions (keyed by extension name). */
  ext: Map<string, unknown>;
  /** fetch used for outbound HTTP (engines, extensions). */
  fetchImpl?: typeof fetch | undefined;
}

export interface ContextOverrides {
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  proberTtlMs?: number;
  /** Candidate extensions (default: `src/extensions/index.ts`); each still honours `enabled()`. */
  extensions?: readonly Extension[];
  /** Test/runtime overrides passed to each extension's `init`, keyed by extension name. */
  extensionOptions?: Record<string, unknown>;
}

/** Builds the app context. Loads and validates rates eagerly (invalid rates = boot failure). */
export function createContext(config: Config, overrides: ContextOverrides = {}): AppContext {
  const engines = createEngines(config, overrides.fetchImpl);
  const rates = new RatesRepository(config.RATES_DIR);
  rates.get();
  const candidates = overrides.extensions ?? defaultExtensions;
  const ctx: AppContext = {
    config,
    engines,
    prober: new EngineProber(coreProbeTargets(engines, config), overrides.proberTtlMs),
    rates,
    logger: overrides.logger ?? getLogger(),
    now: overrides.now ?? (() => new Date()),
    startedAt: new Date(),
    extensions: candidates.filter((e) => e.enabled?.(config) ?? true),
    ext: new Map(),
    fetchImpl: overrides.fetchImpl,
  };
  for (const e of ctx.extensions) e.init?.(ctx, overrides);
  return ctx;
}

/** Runs the extensions' async startup (migrations etc.). */
export async function startExtensions(ctx: AppContext): Promise<void> {
  for (const e of ctx.extensions) await e.start?.(ctx);
}

/** Runs the extensions' shutdown hooks; never throws. */
export async function stopExtensions(ctx: AppContext): Promise<void> {
  for (const e of [...ctx.extensions].reverse()) {
    try {
      await e.stop?.(ctx);
    } catch (err) {
      ctx.logger.warn({ ext: e.name, err: (err as Error).message }, "falha ao encerrar extensão");
    }
  }
}
