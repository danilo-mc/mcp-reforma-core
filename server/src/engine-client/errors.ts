/** Base class for every failure talking to an official engine. Messages are safe to show users. */
export class EngineError extends Error {
  readonly engine: string;
  readonly route: string;
  constructor(engine: string, route: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineError";
    this.engine = engine;
    this.route = route;
  }
}

/** Network error, 502/503/504 after retries, or circuit open. */
export class EngineUnavailableError extends EngineError {
  readonly httpStatus: number | undefined;
  constructor(engine: string, route: string, httpStatus?: number, options?: ErrorOptions) {
    super(
      engine,
      route,
      `O motor oficial "${engine}" está indisponível no momento${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`,
      options,
    );
    this.name = "EngineUnavailableError";
    this.httpStatus = httpStatus;
  }
}

export class CircuitOpenError extends EngineUnavailableError {
  constructor(engine: string, route: string) {
    super(engine, route);
    this.name = "CircuitOpenError";
    this.message = `O motor oficial "${engine}" está temporariamente indisponível (circuito aberto após falhas seguidas).`;
  }
}

export class EngineTimeoutError extends EngineError {
  readonly timeoutMs: number;
  constructor(engine: string, route: string, timeoutMs: number, options?: ErrorOptions) {
    super(engine, route, `O motor oficial "${engine}" não respondeu em ${timeoutMs} ms.`, options);
    this.name = "EngineTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Unexpected 5xx (other than 502/503/504) or a body that is not what was expected (e.g. invalid JSON). */
export class EngineBadResponseError extends EngineError {
  readonly httpStatus: number | undefined;
  constructor(engine: string, route: string, detail: string, httpStatus?: number, options?: ErrorOptions) {
    super(engine, route, `Resposta inesperada do motor oficial "${engine}": ${detail}.`, options);
    this.name = "EngineBadResponseError";
    this.httpStatus = httpStatus;
  }
}

/** Request was cancelled by the caller (e.g. MCP request cancellation). */
export class EngineAbortedError extends EngineError {
  constructor(engine: string, route: string) {
    super(engine, route, "Requisição ao motor cancelada.");
    this.name = "EngineAbortedError";
  }
}
