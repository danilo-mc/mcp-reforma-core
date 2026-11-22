import canonicalizeRef from "canonicalize";
import { describe, expect, it } from "vitest";
import { canonicalize, canonicalSha256, CanonicalizationError, sha256Hex } from "../../src/receipt/jcs.ts";

function fromHexBits(hex: string): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt(`0x${hex}`));
  return dv.getFloat64(0);
}

describe("JCS (RFC 8785)", () => {
  // RFC 8785 Appendix B — IEEE 754 → JSON number serialization samples.
  const numberVectors: [string, string][] = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ];

  it.each(numberVectors)("serializes IEEE754 %s as %s", (hex, expected) => {
    expect(canonicalize(fromHexBits(hex))).toBe(expected);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: Number.NEGATIVE_INFINITY })).toThrow(CanonicalizationError);
  });

  it("matches the RFC 8785 §3.2.2 example (numbers, strings, literals)", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3)", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    const out = canonicalize(input);
    const keys = Object.keys(JSON.parse(out) as object);
    // JSON.parse re-orders integer-like keys first, so check the textual order instead.
    expect(out).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
    expect(keys).toHaveLength(7);
  });

  it("is insensitive to key order and whitespace, nested", () => {
    const a = JSON.parse('{ "b": [ 1, {"z": 1, "a": 2} ], "a": { "y": null, "x": "ü" } }');
    const b = { a: { x: "ü", y: null }, b: [1, { a: 2, z: 1 }] };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"x":"ü","y":null},"b":[1,{"a":2,"z":1}]}');
  });

  it("drops undefined members like JSON and serializes -0 as 0", () => {
    expect(canonicalize({ a: undefined, b: -0 })).toBe('{"b":0}');
    expect(canonicalize([undefined])).toBe("[null]");
  });

  it("handles duplicated keys in source text by last-wins JSON.parse semantics", () => {
    expect(canonicalize(JSON.parse('{"a":1,"a":2}'))).toBe('{"a":2}');
  });

  it("rejects lone surrogates", () => {
    expect(() => canonicalize("\ud800")).toThrow(CanonicalizationError);
    expect(() => canonicalize({ "\udc00": 1 })).toThrow(CanonicalizationError);
  });

  it("agrees with the reference `canonicalize` package on a mixed document", () => {
    const doc = {
      z: [1.5, 2e-7, 1e21, -0, "tab\t", { é: true, e: false }],
      a: { "\u2028": "line sep", nested: { b: null, a: 1.2345678901234567e19 } },
    };
    expect(canonicalize(doc)).toBe(canonicalizeRef(doc));
  });

  it("hashes with SHA-256 hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(canonicalSha256({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
    expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: 2 }));
  });
});
