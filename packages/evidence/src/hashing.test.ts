import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Bytes, sha256File } from "./index.js";

let dir: string;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("produces identical output for equal objects with different insertion order", () => {
    const x = { z: [1, { n: 1, m: 2 }], a: "hi" };
    const y = JSON.parse('{"a":"hi","z":[1,{"m":2,"n":1}]}');
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it("preserves array order", () => {
    expect(canonicalJson({ a: [2, 1, 3] })).toBe('{"a":[2,1,3]}');
  });

  it("omits undefined object members (JSON parity)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects NaN, Infinity, functions, symbols, BigInt and circular refs", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson(() => 1)).toThrow(/not serializable/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/not serializable/);
    expect(() => canonicalJson(Symbol("s"))).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/);
  });

  it("rejects non-plain wrappers instead of silently stringifying them", () => {
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
  });
});

describe("sha256", () => {
  it("matches the FIPS 180-4 vector for 'abc'", () => {
    expect(sha256Bytes("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("sha256File hashes full file bytes, equal to hashing the same bytes", async () => {
    dir = await mkdtemp(join(tmpdir(), "evidence-hash-"));
    const path = join(dir, "payload.bin");
    const bytes = new Uint8Array([0, 1, 255, 254, 7]);
    await writeFile(path, bytes);
    expect(await sha256File(path)).toBe(sha256Bytes(bytes));
  });
});
