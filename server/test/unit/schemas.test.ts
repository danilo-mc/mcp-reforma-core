import { describe, expect, it } from "vitest";
import { MunicipioIbgeSchema } from "../../src/tools/shared/schemas.ts";

describe("MunicipioIbgeSchema", () => {
  it("aceita string de 7 dígitos", () => {
    expect(MunicipioIbgeSchema.parse("3550308")).toBe("3550308");
  });

  it("aceita número inteiro e normaliza para string", () => {
    expect(MunicipioIbgeSchema.parse(3550308)).toBe("3550308");
  });

  it("rejeita códigos inválidos", () => {
    expect(MunicipioIbgeSchema.safeParse("355030").success).toBe(false);
    expect(MunicipioIbgeSchema.safeParse(355030.5).success).toBe(false);
    expect(MunicipioIbgeSchema.safeParse("abc1234").success).toBe(false);
  });
});
