import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  expandHomePath,
  HARNESS_VALUES,
  installManifestSchemaPath,
  validateInstallManifest,
  type InstallManifest,
} from "./manifest-format.js";
import { canonicalJson, receiptContentHash, type ReceiptContent } from "./receipts.js";

function baseManifest(): InstallManifest {
  return {
    packageName: "demo-pkg",
    version: "1.0.0",
    harnessTargets: {
      codex: { files: [{ src: "/payload/SKILL.md", dst: "~/.codex/skills/demo/SKILL.md" }] },
    },
  };
}

describe("validateInstallManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m = baseManifest();
    m.harnessTargets.claude = {
      files: [{ src: "~/payload/a.md", dst: "/home/u/.claude/agents/a.md" }],
      configMerge: [{ file: "~/.claude/settings.json", marker: "demo-pkg.entry", block: '"k": 1' }],
      aliases: [{ dst: "~/.claude/agents/alias.md", pointsTo: "/somewhere/real.md" }],
    };
    expect(validateInstallManifest(m)).toEqual({ ok: true, errors: [] });
  });

  it("rejects unknown harness keys", () => {
    const m = baseManifest() as { harnessTargets: Record<string, unknown> } & InstallManifest;
    m.harnessTargets.cursor = { files: [] };
    const r = validateInstallManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("unknown harness");
  });

  it("rejects relative file paths, bad package names, and marker whitespace", () => {
    const m = baseManifest();
    (m as { packageName: string }).packageName = "Bad_Name";
    m.harnessTargets.codex!.files.push({ src: "relative/SKILL.md", dst: "skills/x.md" });
    m.harnessTargets.codex!.configMerge = [{ file: "~/.codex/c.json", marker: "bad marker", block: "" }];
    const r = validateInstallManifest(m);
    expect(r.ok).toBe(false);
    const joined = r.errors.join("\n");
    expect(joined).toContain("packageName");
    expect(joined).toContain("files[1].src");
    expect(joined).toContain("files[1].dst");
    expect(joined).toContain("marker");
  });

  it("rejects a block containing its own delimiter lines", () => {
    const m = baseManifest();
    m.harnessTargets.codex!.configMerge = [
      { file: "~/.codex/c.json", marker: "demo-pkg", block: 'x\nrig-installer:demo-pkg:begin\ny' },
    ];
    expect(validateInstallManifest(m).ok).toBe(false);
  });
});

describe("frozen schema walkup", () => {
  it("resolves schemas/InstallManifest.v1.schema.json and agrees with the checker on harnesses", () => {
    const path = installManifestSchemaPath();
    expect(path, "repo root must be findable from module dir").not.toBeNull();
    const schema = JSON.parse(readFileSync(path!, "utf8")) as {
      $id: string;
      properties: { harnessTargets: { propertyNames: { enum: string[] } } };
    };
    expect(schema.$id).toBe("https://rig-testlab.dev/schemas/InstallManifest/v1");
    expect([...schema.properties.harnessTargets.propertyNames.enum].sort()).toEqual(
      [...HARNESS_VALUES].sort(),
    );
  });
});

describe("expandHomePath", () => {
  it("expands ~ and ~/ and passes absolute paths through", () => {
    expect(expandHomePath("~", "/fake/home")).toBe("/fake/home");
    expect(expandHomePath("~/.codex/skills", "/fake/home")).toBe("/fake/home/.codex/skills");
    expect(expandHomePath("/abs/path", "/fake/home")).toBe("/abs/path");
  });
});

describe("canonicalJson + receipt hashing", () => {
  it("sorts object keys and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 3 } })).toBe('{"a":{"c":3,"d":[2,1]},"b":1}');
  });

  it("receipt hash is insertion-order independent but content-sensitive", () => {
    const contentA: ReceiptContent = {
      schemaVersion: 1,
      packageName: "p",
      version: "1.0.0",
      harness: "codex",
      home: "/h",
      files: [{ dst: "/h/.codex/skills/a.md", sha256: "a".repeat(64) }],
      configMerges: [],
      aliases: [],
    };
    const contentB = {
      aliases: [],
      configMerges: [],
      files: [{ sha256: "a".repeat(64), dst: "/h/.codex/skills/a.md" }],
      home: "/h",
      harness: "codex" as const,
      version: "1.0.0",
      packageName: "p",
      schemaVersion: 1 as const,
    };
    expect(receiptContentHash(contentB)).toBe(receiptContentHash(contentA));
    expect(receiptContentHash({ ...contentA, files: [] })).not.toBe(receiptContentHash(contentA));
  });
});
