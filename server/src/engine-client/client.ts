import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { context, propagation } from "@opentelemetry/api";
import { getLogger } from "../observability/logger.ts";
import { Metrics } from "../observability/telemetry.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import {
  CircuitOpenError,
  EngineAbortedError,
  EngineBadResponseError,
  EngineTimeoutError,
  EngineUnavailableError,
} from "./errors.ts";

export type QueryValue = string | number | boolean | undefined | null;

export interface EngineRequest {
  method: "GET" | "POST";
  /** Path relative to the engine base URL (see routes.ts). */
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON payload (serialised with JSON.stringify). Mutually exclusive with `body`. */
  json?: unknown;
  /** Raw body (e.g. XML for DANFSe). */
  body?: string | Uint8Array;
  contentType?: string;
  accept?: string;
  /** How to read the response. Default `json`. */
  responseType?: "json" | "text" | "binary";
  /**
   * Retry on network error / 502 / 503 / 504. Default: true for GET, false for POST.
   * Pure calculation POSTs may set `true` (they get at most one retry).
   */
  retryable?: boolean;
  /** When true, non-2xx responses that are not retried are returned instead of thrown. */
  allowHttpErrors?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra headers. */
  headers?: Record<string, string>;
}

export interface EngineResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Raw response text (json/text modes). Exactly what the engine sent. */
  rawText: string | undefined;
  /** Parsed JSON (json mode), the text (text mode) or undefined (binary mode). */
  body: T;
  /** Raw bytes (binary mode). */
  bytes: Buffer | undefined;
  latencyMs: number;
  attempts: number;
  url: string;
}

export interface EngineClientOptions {
  name: string;
  baseUrl: string;
  timeoutMs: number;
  /** Max retries for retryable GETs. */
  retries: number;
  /** Base backoff in ms (exponential, with jitter). */
  backoffMs?: number;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
}

const RETRY_STATUSES = new Set([502, 503, 504]);

export function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

/** W3C trace-context headers from the active OTel context, or a fresh traceparent. */
export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!carrier.traceparent) carrier.traceparent = newTraceparent();
  return carrier;
}

export class EngineClient {
  readonly name: string;
  readonly baseUrl: string;
  readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EngineClientOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries;
    this.backoffMs = options.backoffMs ?? 200;
    this.breaker = options.breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 30_000 });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async getJson<T = unknown>(
    path: string,
    query?: Record<string, QueryValue>,
    opts: Partial<EngineRequest> = {},
  ): Promise<EngineResponse<T>> {
    return this.request<T>({ ...opts, method: "GET", path, query });
  }

  async postJson<T = unknown>(
    path: string,
    payload: unknown,
    opts: Partial<EngineRequest> = {},
  ): Promise<EngineResponse<T>> {
    return this.request<T>({ ...opts, method: "POST", path, json: payload });
  }

  async request<T = unknown>(req: EngineRequest): Promise<EngineResponse<T>> {
    const url = this.buildUrl(req.path, req.query);
    const retryable = req.retryable ?? req.method === "GET";
    const maxRetries = !retryable ? 0 : req.method === "GET" ? this.retries : Math.min(1, this.retries);
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const responseType = req.responseType ?? "json";
    const started = performance.now();
    const log = getLogger();

    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (req.signal?.aborted) throw new EngineAbortedError(this.name, req.path);
      if (!this.breaker.allow()) throw new CircuitOpenError(this.name, req.path);

      const headers: Record<string, string> = {
        accept: req.accept ?? (responseType === "json" ? "application/json" : "*/*"),
        ...traceHeaders(),
        ...req.headers,
      };
      let body: string | Uint8Array | undefined = req.body;
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        headers["content-type"] = req.contentType ?? "application/json";
      } else if (body !== undefined && req.contentType) {
        headers["content-type"] = req.contentType;
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
      const attemptStart = performance.now();

      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: req.method, headers, body, signal });
      } catch (err) {
        const latency = performance.now() - attemptStart;
        Metrics.engineLatency(this.name, req.path, "error", latency);
        if (req.signal?.aborted) throw new EngineAbortedError(this.name, req.path);
        this.breaker.onFailure();
        if (timeoutSignal.aborted) {
          log.warn({ engine: this.name, route: req.path, attempt, timeoutMs }, "engine timeout");
          throw new EngineTimeoutError(this.name, req.path, timeoutMs, { cause: err });
        }
        log.warn(
          { engine: this.name, route: req.path, attempt, err: (err as Error).message },
          "engine network error",
        );
        if (attempt <= maxRetries) {
          await this.backoff(attempt, req.signal);
          continue;
        }
        throw new EngineUnavailableError(this.name, req.path, undefined, { cause: err });
      }

      let rawText: string | undefined;
      let bytes: Buffer | undefined;
      try {
        if (responseType === "binary" && res.ok) bytes = Buffer.from(await res.arrayBuffer());
        else rawText = await res.text();
      } catch (err) {
        this.breaker.onFailure();
        if (req.signal?.aborted) throw new EngineAbortedError(this.name, req.path);
        if (timeoutSignal.aborted)
          throw new EngineTimeoutError(this.name, req.path, timeoutMs, { cause: err });
        throw new EngineBadResponseError(this.name, req.path, "falha ao ler o corpo", res.status, {
          cause: err,
        });
      }
      const latency = performance.now() - attemptStart;
      Metrics.engineLatency(this.name, req.path, res.status, latency);
      log.debug(
        { engine: this.name, route: req.path, status: res.status, latencyMs: Math.round(latency) },
        "engine call",
      );

      if (RETRY_STATUSES.has(res.status)) {
        this.breaker.onFailure();
        if (attempt <= maxRetries) {
          await this.backoff(attempt, req.signal);
          continue;
        }
        throw new EngineUnavailableError(this.name, req.path, res.status);
      }
      if (res.status >= 500) this.breaker.onFailure();
      else this.breaker.onSuccess();

      if (!res.ok && !req.allowHttpErrors && res.status >= 500) {
        throw new EngineBadResponseError(this.name, req.path, `HTTP ${res.status}`, res.status);
      }

      let parsed: unknown = rawText;
      if (responseType === "json" && rawText !== undefined) {
        if (rawText.trim() === "") parsed = null;
        else {
          try {
            parsed = JSON.parse(rawText);
          } catch (err) {
            if (res.ok) {
              throw new EngineBadResponseError(this.name, req.path, "JSON inválido", res.status, {
                cause: err,
              });
            }
            parsed = rawText;
          }
        }
      } else if (responseType === "binary") {
        parsed = undefined;
      }

      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        rawText,
        body: parsed as T,
        bytes,
        latencyMs: Math.round(performance.now() - started),
        attempts: attempt,
        url,
      };
    }
  }

  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const delay = this.backoffMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
    try {
      await sleep(delay, undefined, signal ? { signal } : undefined);
    } catch {
      throw new EngineAbortedError(this.name, "backoff");
    }
  }
}
