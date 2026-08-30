import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLock, serializeLock, writeLock, readLock } from "./lock.js";
import { validateLock, verifyLock } from "./verify.js";
import { NON_PASSING_STATES, type CatalogEntry, type CatalogLock, type SourcePin } from "./types.js";

const SHA = "a".repeat(39) + "f";

function makeEntry(over: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    name: over.id,
    categories: ["API Testing"],
    capabilities: ["api"],
    canonicalUrl: `https://example.com/${over.id}`,
    targetKind: "website",
    description: "desc",
    provenance: [
      { sourceCatalogId: "awesome-testing", depth: 1, catalogCommit: SHA, urlAsLinked: "https://x", discoveredAt: "2026-08-30T00:00:00Z" },
    ],
    license: { spdx: null, kind: "unknown" },
    credentialRequirement: "none",
    lastValidation: { at: "2026-08-30T00:00:00Z", method: "manual" },
    redirectHistory: [],
    adoptionTier: "reference",
    executionPolicy: "reference_only",
    resolutionStatus: "unresolved",
    ...over,
  };
}

const REPO_ENTRY = makeEntry({
  id: "usebruno--bruno",
  name: "Bruno",
  targetKind: "git_repo",
  canonicalUrl: "https://github.com/usebruno/bruno",
  license: { spdx: "MIT", kind: "permissive" },
  resolutionStatus: "active",
  adoptionTier: "approved_adapter",
  executionPolicy: "allowlisted",
  repository: {
    owner: "usebruno",
    name: "bruno",
    defaultBranch: "main",
    commitSha: SHA,
    submodulePath: "sources/direct/usebruno/usebruno--bruno",
    reportedSizeKb: 4242,
  },
});

const PIN: SourcePin = {
  entryId: "usebruno--bruno",
  repoUrl: "https://github.com/usebruno/bruno",
  owner: "usebruno",
  name: "bruno",
  defaultBranch: "main",
  commitSha: SHA,
  submodulePath: "sources/direct/usebruno/usebruno--bruno",
  gitmodulesName: "usebruno--bruno",
  shallowCapable: true,
  reportedSizeKb: 4242,
  pinState: "pinned",
  lastHydratedAt: null,
};

function makeLock(entries: CatalogEntry[], pins: SourcePin[]): CatalogLock {
  return buildLock({
    entries,
    pins,
    nestedCatalogs: [
      { id: "awesome-testing", url: "https://github.com/TheJambo/awesome-testing", commit: SHA, status: "active", expandedLinkCount: 0, discoveredCatalogCount: 0 },
    ],
    generatedFrom: { repo: "TheJambo/awesome-testing", commit: "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93", readmeSha256: "b".repeat(64) },
  });
}

describe("validateLock (ajv 2020-12, all schemas, formats)", () => {
  it("accepts a real lock", () => {
    const v = validateLock(makeLock([REPO_ENTRY, makeEntry({ id: "plain-site" })], [PIN]));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("rejects a planted bad enum (resolutionStatus 'passed' is not a state)", () => {
    const bad = structuredClone(makeLock([REPO_ENTRY], [PIN]));
    bad.entries[0]!.resolutionStatus = "passed" as CatalogEntry["resolutionStatus"];
    const v = validateLock(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/resolutionStatus/);
  });

  it("NON_PASSING_STATES are not schema enums — none may appear as resolutionStatus either", () => {
    for (const s of NON_PASSING_STATES) {
      const bad = structuredClone(makeLock([REPO_ENTRY], [PIN]));
      bad.entries[0]!.resolutionStatus = s as CatalogEntry["resolutionStatus"];
      expect(validateLock(bad).ok, String(s)).toBe(false);
    }
  });

  it("rejects git_repo without a repository block", () => {
    const bad = structuredClone(makeLock([REPO_ENTRY], [PIN]));
    delete bad.entries[0]!.repository;
    expect(validateLock(bad).ok).toBe(false);
  });

  it("rejects malformed hashes, dates and submodule paths", () => {
    const badSha = structuredClone(makeLock([REPO_ENTRY], [PIN]));
    badSha.generatedFrom.readmeSha256 = "nope";
    expect(validateLock(badSha).ok).toBe(false);

    const badPath = structuredClone(makeLock([REPO_ENTRY], [PIN]));
    badPath.entries[0]!.repository!.submodulePath = "sources/other/x/y";
    expect(validateLock(badPath).ok).toBe(false);

    const badDate = structuredClone(makeLock([REPO_ENTRY], [PIN]));
    badDate.entries[0]!.lastValidation.at = "yesterday";
    expect(validateLock(badDate).ok).toBe(false);
  });

  it("rejects unknown additional properties", () => {
    const bad = structuredClone(makeLock([REPO_ENTRY], [PIN])) as unknown as Record<string, unknown>;
    bad.extra = true;
    expect(validateLock(bad).ok).toBe(false);
  });
});

describe("verifyLock integrity", () => {
  it("flags repository without pin, orphan pins and stat drift", () => {
    const noPin = makeLock([REPO_ENTRY], []);
    expect(verifyLock(noPin).ok).toBe(false);
    const orphanPins = makeLock([makeEntry({ id: "plain-site" })], [PIN]);
    expect(verifyLock(orphanPins).ok).toBe(false);
    const drifted = makeLock([REPO_ENTRY], [PIN]);
    drifted.statistics.firstLevelCount = 99;
    expect(verifyLock(drifted).ok).toBe(false);
    expect(verifyLock(makeLock([REPO_ENTRY], [PIN])).ok).toBe(true);
  });

  it("flags duplicate submodule paths", () => {
    const dup = makeLock([REPO_ENTRY], [PIN, { ...PIN, entryId: "other--thing" }]);
    const v = verifyLock(dup);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/duplicate pin|duplicate submodulePath|missing entry/);
  });
});

describe("byte-stable canonical serialization", () => {
  it("insertion order and key order never change the bytes", () => {
    const lock = makeLock([REPO_ENTRY, makeEntry({ id: "aa-site" }), makeEntry({ id: "zz-site" })], [PIN]);
    const bytes = serializeLock(lock);

    const reordered = makeLock(
      [makeEntry({ id: "zz-site" }), REPO_ENTRY, makeEntry({ id: "aa-site" })],
      [PIN],
    );
    expect(serializeLock(reordered)).toBe(bytes);
    const dir = mkdtempSync(join(tmpdir(), "catlock-"));
    const path = join(dir, "nested", "catalog.lock.json"); // creates parents
    writeLock(lock, path);
    expect(serializeLock(readLock(path))).toBe(bytes);
  });

  it("sorted output: entries by id", () => {
    const lock = makeLock([REPO_ENTRY, makeEntry({ id: "aa-site" })], [PIN]);
    expect(lock.entries.map((e) => e.id)).toEqual(["aa-site", "usebruno--bruno"]);
  });
});
