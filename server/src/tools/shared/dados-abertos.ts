import type { EngineClient, QueryValue } from "../../engine-client/client.ts";
import { EngineBadResponseError } from "../../engine-client/errors.ts";

/**
 * In-memory TTL cache for the regular engine's "dados abertos" GET routes (classification tables).
 * Entries are loaded lazily on first use and shared by all MCP sessions of the process.
 */
export class DadosAbertosCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs = 6 * 60 * 60 * 1000, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * GET JSON through the cache. 404 resolves to `null` (cached: "not found" is a valid answer);
   * other failures are not cached and are thrown.
   */
  async get<T>(
    client: EngineClient,
    path: string,
    query: Record<string, QueryValue>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const key = client.buildUrl(path, query);
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T | null>;
    const value = client
      .getJson<T>(path, query, { allowHttpErrors: true, ...(signal ? { signal } : {}) })
      .then((res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new EngineBadResponseError(client.name, path, `HTTP ${res.status}`, res.status);
        return res.body;
      });
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => this.entries.delete(key));
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Process-wide cache instance. */
export const DADOS_ABERTOS_CACHE = new DadosAbertosCache();
