import { pino, type Logger } from "pino";

/**
 * Structured logger. Always writes to **stderr** (fd 2) so the stdio MCP transport,
 * which owns stdout, is never corrupted.
 *
 * Privacy rule (SPEC §9): log only tool names, hashes, statuses, latency and versions.
 * The redaction list is a safety net — callers must never pass payloads or XML.
 */
export const REDACT_PATHS = [
  "body",
  "req.body",
  "request.body",
  "payload",
  "xml",
  "pdf",
  "input",
  "input_canonical",
  "args",
  "arguments",
  "*.body",
  "*.payload",
  "*.xml",
  "*.input_canonical",
  "*.arguments",
  'req.headers["authorization"]',
  'req.headers["cookie"]',
];

export function createLogger(level = "info"): Logger {
  return pino(
    {
      level,
      base: { svc: "mcp-reforma" },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ fd: 2, sync: false }),
  );
}

let rootLogger: Logger = pino({ level: "silent" });

export function setLogger(logger: Logger): void {
  rootLogger = logger;
}

export function getLogger(): Logger {
  return rootLogger;
}

export type { Logger };
