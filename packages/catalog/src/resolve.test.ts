import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubClient } from "./fetch.js";
import { AWESOME_TESTING_COMMIT, parseFirstLevel } from "./parse.js";
import { resolveEntries, UNRESOLVED_SHA } from "./resolve.js";
import { NESTED_CATALOG_REPOS, type NestedCatalogConfig } from "./nested-catalogs.js";
import { readLock, serializeLock, writeLock } from "./lock.js";
import { validateLock, verifyLock } from "./verify.js";
import type { CatalogEntry, CatalogLock } from "./types.js";

const shaFor = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 40);
const NOW = "2026-08-30T12:00:00.000Z";
const NESTED_DIR = join(import.meta.dirname, "..", "testdata", "nested");
const FIXTURE_MD = join(import.meta.dirname, "..", "testdata", "awt-README-ff695aa.md");

const DEPTH1_MD = `
## Software

### API Testing
- [Bruno](https://github.com/usebruno/bruno) - API client.
- [Keploy](https://github.com/keploy/keploy) - API platform.

### Test Data
- [Ghost Resource](https://github.com/ghost-owner/ghost-repo) - Removed repo.
- [Flaky Resource](https://github.com/flaky-owner/flaky-repo) - Wobbly provider.
- [Throttled Resource](https://github.com/throttled-owner/throttled-repo) - Always busy.
- [No License Resource](https://github.com/nolic-owner/nolic-repo) - Unlicensed.

## Books
- [Some Book](https://amzn.to/some-book) - A book.
`;

interface RepoBehavior {
  status?: number;
  failFirst?: { status: number; count: number };
  licenseSpdx?: string | null;
  defaultBranch?: string;
  size?: number;
  md?: Record<string, string>; // path → content (also defines the tree)
}

function makeServer(behaviors: Record<string, RepoBehavior>) {
  const hitCount = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/(commits|contents|git))?\/?(.*)$/.exec(url.pathname);
    if (!m) return Response.json({ message: "Not Found" }, { status: 404 });
    const [, owner, name, kind, tail] = m;
    const key = `${owner}/${name}`;
    const b = behaviors[key];
    const hits = (hitCount.get(`${key}|${kind ?? "repo"}`) ?? 0) + 1;
    hitCount.set(`${key}|${kind ?? "repo"}`, hits);
    if (!b) return Response.json({ message: "Not Found" }, { status: 404 });
    if (b.failFirst && hits <= b.failFirst.count) {
      return Response.json({ message: "early fail" }, { status: b.failFirst.status });
    }
    if (b.status && b.status !== 200) return Response.json({ message: "fail" }, { status: b.status });
    if (kind === "commits") return Response.json({ sha: shaFor(key) });
    if (kind === "contents") {
      const path = decodeURIComponent(tail!.replace(/^\/+/, ""));
      const content = b.md?.[path];
      if (content === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" });
    }
    if (kind === "git") {
      // trees/<sha> — serve the md map as the blob tree
      const tree = Object.keys(b.md ?? { "README.md": "" }).map((p) => ({
        path: p,
        type: "blob",
        sha: shaFor(`${key}:${p}`),
      }));
      return Response.json({ tree, truncated: false });
    }
    return Response.json({
      owner: { login: owner },
      name,
      default_branch: b.defaultBranch ?? "main",
      size: b.size ?? 100,
      license: b.licenseSpdx === null ? null : { spdx_id: b.licenseSpdx ?? "MIT" },
      archived: false,
      fork: false,
      html_url: `https://github.com/${key}`,
    });
  }) as unknown as typeof fetch;
  return new GitHubClient({ fetchImpl, sleepMs: async () => {} });
}

const TEST_NESTED: readonly NestedCatalogConfig[] = [
  { owner: "fixture-org", repo: "awesome-alpha", path: "README.md", id: "fixture-org--awesome-alpha" },
  { owner: "fixture-org", repo: "awesome-beta", path: "README.md", id: "fixture-org--awesome-beta" },
  { owner: "fixture-org", repo: "plain-list", path: "README.md", id: "fixture-org--plain-list" },
];

function server(): GitHubClient {
  return makeServer({
    "usebruno/bruno": { licenseSpdx: "MIT", size: 4242 },
    "keploy/keploy": { licenseSpdx: "Apache-2.0" },
    "ghost-owner/ghost-repo": { status: 404 },
    "flaky-owner/flaky-repo": { failFirst: { status: 404, count: 1 }, licenseSpdx: "MIT" },
    "throttled-owner/throttled-repo": { status: 429 },
    "nolic-owner/nolic-repo": { licenseSpdx: null },
    "fixture-tools/alpha-widget": {},
    "fixture-tools/beta-tool": {},
    "fixture-tools/gamma-repo": {},
    "fixture-org/awesome-alpha": {
      licenseSpdx: "CC0-1.0",
      md: {
        "README.md": readFileSync(join(NESTED_DIR, "fixture-alpha-README.md"), "utf8"),
        "docs/extra.md": readFileSync(join(NESTED_DIR, "fixture-alpha-extra.md"), "utf8"),
      },
    },
    "fixture-org/awesome-beta": {
      licenseSpdx: "CC0-1.0",
      md: { "README.md": readFileSync(join(NESTED_DIR, "fixture-beta-README.md"), "utf8") },
    },
    "fixture-org/plain-list": {
      licenseSpdx: "CC0-1.0",
      md: { "README.md": readFileSync(join(NESTED_DIR, "fixture-gamma-README.md"), "utf8") },
    },
  });
}

async function resolveTestLock(): Promise<CatalogLock> {
  const parsed = parseFirstLevel(DEPTH1_MD, AWESOME_TESTING_COMMIT);
  return resolveEntries(parsed, {
    client: server(),
    readmeMarkdown: DEPTH1_MD,
    nested: TEST_NESTED,
    now: NOW,
  });
}

function entry(lock: CatalogLock, id: string): CatalogEntry {
  const e = lock.entries.find((x) => x.id === id);
  if (!e) throw new Error(`missing ${id}`);
  return e;
}

describe("resolveEntries", () => {
  const lockP = resolveTestLock();

  it("produces a schema-valid, integrity-clean lock", async () => {
    const lock = await lockP;
    const v = validateLock(lock);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(verifyLock(lock).ok).toBe(true);
    expect(lock.generatedFrom.readmeSha256).toBe(
      createHash("sha256").update(DEPTH1_MD, "utf8").digest("hex"),
    );
  });

  it("dedups a repo discovered at both levels into one entry, one pin, two edges", async () => {
    const lock = await lockP;
    const bruno = entry(lock, "usebruno--bruno");
    expect(bruno.resolutionStatus).toBe("active");
    expect(bruno.provenance.map((p) => `${p.sourceCatalogId}@${p.depth}`).sort()).toEqual([
      "awesome-testing@1",
      "fixture-org--awesome-alpha@2",
    ]);
    expect(bruno.provenance.find((p) => p.depth === 2)!.catalogCommit).toBe(shaFor("fixture-org/awesome-alpha"));
    const pins = lock.pins.filter((p) => p.entryId === "usebruno--bruno");
    expect(pins.length).toBe(1);
    expect(pins[0]!.submodulePath).toBe("sources/direct/usebruno/usebruno--bruno");
    expect(pins[0]!.commitSha).toBe(shaFor("usebruno/bruno"));
  });

  it("depth-2-only repo gets one entry, nested submodule path, edges from both catalogs", async () => {
    const lock = await lockP;
    const alpha = entry(lock, "fixture-tools--alpha-widget");
    expect(alpha.provenance.length).toBe(2);
    expect(alpha.provenance.every((p) => p.depth === 2)).toBe(true);
    const pin = lock.pins.find((p) => p.entryId === "fixture-tools--alpha-widget");
    expect(pin!.submodulePath).toBe("sources/nested/fixture-tools/fixture-tools--alpha-widget");
    expect(lock.pins.filter((p) => p.entryId === "fixture-tools--alpha-widget").length).toBe(1);
  });

  it("parses the whole markdown tree, not just README (extra.md link found)", async () => {
    const lock = await lockP;
    expect(entry(lock, "fixture-tools--gamma-repo").resolutionStatus).toBe("active");
    const alphaRef = lock.nestedCatalogs.find((c) => c.id === "fixture-org--awesome-alpha")!;
    expect(alphaRef.expandedLinkCount).toBe(6); // 4 README + 2 extra.md
    expect(alphaRef.discoveredCatalogCount).toBe(1); // awesome-beta linked, never expanded
    expect(alphaRef.commit).toBe(shaFor("fixture-org/awesome-alpha"));
    const betaRef = lock.nestedCatalogs.find((c) => c.id === "fixture-org--awesome-beta")!;
    expect(betaRef.expandedLinkCount).toBe(3);
    expect(betaRef.discoveredCatalogCount).toBe(0);
    const gammaRef = lock.nestedCatalogs.find((c) => c.id === "fixture-org--plain-list")!;
    expect(gammaRef.expandedLinkCount).toBe(1);
  });

  it("keeps issue links metadata-only at depth 2", async () => {
    const lock = await lockP;
    const issues = lock.entries.find((e) => e.canonicalUrl.includes("/issues/1"));
    expect(issues).toBeDefined();
    expect(issues!.targetKind).toBe("other");
    expect(issues!.repository).toBeUndefined();
    expect(lock.pins.some((p) => p.entryId === issues!.id)).toBe(false);
  });

  it("429 is rate_limited, never dead, and keeps the entry + no pin", async () => {
    const lock = await lockP;
    const t = entry(lock, "throttled-owner--throttled-repo");
    expect(t.resolutionStatus).toBe("rate_limited");
    expect(t.targetKind).toBe("other"); // demoted so the entry stays schema-valid
    expect(lock.pins.some((p) => p.entryId === t.id)).toBe(false);
  });

  it("double 404 → dead with two-observation evidence", async () => {
    const lock = await lockP;
    const g = entry(lock, "ghost-owner--ghost-repo");
    expect(g.resolutionStatus).toBe("dead");
    expect(g.lastValidation.httpStatus).toBe(404);
    expect(g.lastValidation.notes).toMatch(/two independent/);
  });

  it("single 404 + successful re-check is NOT dead", async () => {
    const lock = await lockP;
    const f = entry(lock, "flaky-owner--flaky-repo");
    expect(f.resolutionStatus).toBe("unresolved");
    expect(f.resolutionStatus).not.toBe("dead");
  });

  it("missing license ⇒ reference_only; reviewed+permissive ⇒ allowlisted", async () => {
    const lock = await lockP;
    expect(entry(lock, "nolic-owner--nolic-repo").license.kind).toBe("missing");
    expect(entry(lock, "nolic-owner--nolic-repo").executionPolicy).toBe("reference_only");
    expect(entry(lock, "usebruno--bruno").executionPolicy).toBe("allowlisted");
    expect(entry(lock, "usebruno--bruno").adoptionTier).toBe("approved_adapter");
    expect(entry(lock, "keploy--keploy").executionPolicy).toBe("allowlisted"); // reviewed + Apache-2.0
  });

  it("statistics are computed, not copied", async () => {
    const lock = await lockP;
    expect(lock.statistics.firstLevelCount).toBe(7);
    expect(lock.statistics.uniqueRepos).toBe(lock.pins.length);
    const total = Object.values(lock.statistics.byResolutionStatus).reduce((a, b) => a + b, 0);
    expect(total).toBe(lock.entries.length);
  });

  it("nested catalog 404 double-confirm marks the ref dead without expansion", async () => {
    const parsed = parseFirstLevel(DEPTH1_MD, AWESOME_TESTING_COMMIT);
    const deadServer = makeServer({
      ...{}, // no fixture-org repos → all 404
      "usebruno/bruno": {},
      "keploy/keploy": {},
    });
    const lock = await resolveEntries(parsed, {
      client: deadServer,
      readmeMarkdown: DEPTH1_MD,
      nested: TEST_NESTED,
      now: NOW,
    });
    for (const ref of lock.nestedCatalogs) {
      expect(ref.status).toBe("dead");
      expect(ref.commit).toBe(UNRESOLVED_SHA);
      expect(ref.expandedLinkCount).toBe(0);
    }
    expect(validateLock(lock).ok).toBe(true);
  });

  it("writeLock → readLock is byte-stable round-trip", async () => {
    const lock = await lockP;
    const dir = mkdtempSync(join(tmpdir(), "catlock-"));
    const path = join(dir, "catalog.lock.json");
    const bytes1 = writeLock(lock, path);
    const reread = readLock(path);
    const bytes2 = serializeLock(reread);
    expect(bytes2).toBe(bytes1);
    // independent reorder of the same data serializes identically
    const shuffled: CatalogLock = structuredClone(lock);
    shuffled.entries.reverse();
    shuffled.pins.reverse();
    expect(serializeLock(structuredClone(shuffled))).toBe(bytes1);
  });
});

describe("NESTED_CATALOG_REPOS frozen set", () => {
  it("holds exactly the empirically frozen 11", () => {
    expect(NESTED_CATALOG_REPOS.length).toBe(11);
    expect(NESTED_CATALOG_REPOS.map((c) => `${c.owner}/${c.repo}`)).toContain("ligurio/awesome-software-quality");
    expect(NESTED_CATALOG_REPOS.map((c) => c.id)).toEqual(
      NESTED_CATALOG_REPOS.map((c) => `${c.owner}--${c.repo}`.toLowerCase()),
    );
    for (const c of NESTED_CATALOG_REPOS) expect(c.path).toBe("README.md");
  });
});

describe("full-fixture end-to-end (offline fake, pinned README)", () => {
  it("parses the 162-entry fixture and validates the resolved lock", async () => {
    const md = readFileSync(FIXTURE_MD, "utf8");
    const parsed = parseFirstLevel(md, AWESOME_TESTING_COMMIT);
    expect(parsed.length).toBe(162);
    // Every clone target answers 404 twice in this run → honest `dead`, never dropped.
    const deadOnly = makeServer({});
    const lock = await resolveEntries(parsed, {
      client: deadOnly,
      readmeMarkdown: md,
      nested: [],
      now: NOW,
    });
    expect(validateLock(lock).ok).toBe(true);
    expect(verifyLock(lock).ok).toBe(true);
    expect(lock.entries.length).toBe(162);
    expect(lock.statistics.byResolutionStatus.dead ?? 0).toBe(73 + 0);
    expect(lock.pins.length).toBe(0);
  });
});
