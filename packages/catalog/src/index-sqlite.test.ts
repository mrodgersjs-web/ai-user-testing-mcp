import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFtsIndex, searchIndex } from "./index-sqlite.js";
import { buildLock } from "./lock.js";
import type { CatalogEntry, CatalogLock } from "./types.js";

const SHA = "c".repeat(40);

function entry(id: string, name: string, description: string, categories: string[], depth2Origin = false): CatalogEntry {
  return {
    id,
    name,
    categories,
    capabilities: categories.map((c) => c.toLowerCase()),
    canonicalUrl: `https://example.com/${id}`,
    targetKind: "website",
    description,
    provenance: [
      {
        sourceCatalogId: depth2Origin ? "someone--awesome-x" : "awesome-testing",
        depth: depth2Origin ? 2 : 1,
        catalogCommit: SHA,
        urlAsLinked: `https://example.com/${id}`,
        discoveredAt: "2026-08-30T00:00:00Z",
      },
    ],
    license: { spdx: null, kind: "unknown" },
    credentialRequirement: "none",
    lastValidation: { at: "2026-08-30T00:00:00Z", method: "manual" },
    redirectHistory: [],
    adoptionTier: "reference",
    executionPolicy: "reference_only",
    resolutionStatus: "unresolved",
  };
}

function tinyLock(): CatalogLock {
  return buildLock({
    entries: [
      entry("squirrelscan", "squirrelscan", "Audits websites for accessibility, SEO, performance, and security with 260+ rules", ["Accessibility & Usability Testing"]),
      entry("usebruno--bruno", "Bruno", "Open-source API client for exploring and testing APIs", ["API Testing"]),
      entry("nested-only-tool", "Nested Only", "A depth-2 discovery for mock-based testing", ["Service Virtualization"], true),
    ],
    pins: [],
    nestedCatalogs: [],
    generatedFrom: { repo: "TheJambo/awesome-testing", commit: "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93", readmeSha256: "d".repeat(64) },
  });
}

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "fts-")), name);
}

describe("buildFtsIndex / searchIndex", () => {
  it("rows cover every entry plus every provenance edge (≥ unique links)", () => {
    const lock = tinyLock();
    const db = tmpDb("tiny.db");
    const rows = buildFtsIndex(lock, db);
    const uniqueLinks = new Set(lock.entries.flatMap((e) => e.provenance.map((p) => p.urlAsLinked))).size;
    expect(rows).toBe(lock.entries.length + lock.entries.reduce((n, e) => n + e.provenance.length, 0));
    expect(rows).toBeGreaterThanOrEqual(uniqueLinks);
  });

  it("BM25 search finds the accessibility entry and ranks by relevance", () => {
    const db = tmpDb("search.db");
    buildFtsIndex(tinyLock(), db);
    const hits = searchIndex(db, "accessibility", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.id).toBe("squirrelscan");
    expect(hits[0]!.score).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(searchIndex(db, "api", 5).some((h) => h.id === "usebruno--bruno")).toBe(true);
    expect(searchIndex(db, "", 5)).toEqual([]);
  });

  it("depth-2-only links are searchable (index covers nested non-repo links too)", () => {
    const db = tmpDb("nested.db");
    buildFtsIndex(tinyLock(), db);
    expect(searchIndex(db, "discovery", 5).some((h) => h.id === "nested-only-tool")).toBe(true);
  });

  it("p95 query latency < 200ms on a synthetic 5000-row index", () => {
    const entries = Array.from({ length: 5000 }, (_, i) =>
      entry(
        `repo-${i}--tool`,
        `Tool ${i}`,
        i % 2 === 0
          ? `Load and performance harness variant ${i} for distributed systems`
          : `Visual regression snapshot comparator edition ${i}`,
        i % 2 === 0 ? ["Performance & Load Testing"] : ["Visual Testing"],
      ),
    );
    const lock = buildLock({
      entries,
      pins: [],
      nestedCatalogs: [],
      generatedFrom: { repo: "TheJambo/awesome-testing", commit: "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93", readmeSha256: "e".repeat(64) },
    });
    const db = tmpDb("perf.db");
    const build0 = performance.now();
    const rows = buildFtsIndex(lock, db);
    const buildMs = performance.now() - build0;
    expect(rows).toBe(10000); // 5000 entries + 5000 edges
    expect(buildMs).toBeLessThan(5000);

    const queries = ["performance", "visual", "regression", "distributed", "load", "harness", "snapshot", "comparator", "systems", "edition"];
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const hits = searchIndex(db, queries[i % queries.length]!, 20);
      times.push(performance.now() - t0);
      expect(hits.length).toBeGreaterThan(0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(200);
  });
});
