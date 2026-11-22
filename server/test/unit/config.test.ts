import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boolWithDefault, ConfigError, intWithDefault, loadConfig, parseEnv } from "../../src/config.ts";

describe("config", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.MCP_TRANSPORT).toBe("stdio");
    expect(c.PORT).toBe(3000);
    expect(c.MAX_ITEMS).toBe(200);
    expect(c.RATE_LIMIT_PER_MIN).toBe(60);
    expect(c.SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(c.RATES_DIR).toMatch(/rates$/);
  });

  it("coerces numbers and treats empty strings as unset", () => {
    const c = loadConfig({ PORT: "8081", MAX_ITEMS: "10", FRONT_DOOR_ID: "", ENGINE_TIMEOUT_MS: "" });
    expect(c.PORT).toBe(8081);
    expect(c.MAX_ITEMS).toBe(10);
    expect(c.FRONT_DOOR_ID).toBeUndefined();
    expect(c.ENGINE_TIMEOUT_MS).toBe(10_000);
  });

  it("rejects invalid values with a Portuguese message", () => {
    expect(() => loadConfig({ MCP_TRANSPORT: "sse" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ ENGINE_REGULAR_URL: "not a url" })).toThrow(/ENGINE_REGULAR_URL/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
  });

  it("keeps the raw environment for extensions (parseEnv)", () => {
    const c = loadConfig({ FEATURE_X: "on", PORT: "3001" });
    expect(c.env.FEATURE_X).toBe("on");
    expect(parseEnv(z.object({ FEATURE_X: boolWithDefault(false) }), c.env).FEATURE_X).toBe(true);
    expect(parseEnv(z.object({ FEATURE_X: boolWithDefault(false) }), {}).FEATURE_X).toBe(false);
    expect(() => parseEnv(z.object({ N: intWithDefault(1, 1) }), { N: "0" })).toThrow(ConfigError);
  });
});
