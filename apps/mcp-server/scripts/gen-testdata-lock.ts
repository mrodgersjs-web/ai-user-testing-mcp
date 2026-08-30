/**
 * One-off generator for testdata/catalog.lock.minimal.json (12 entries:
 * 2 awesome_list, 1 github_org, 1 dead, 1 saas, 1 website, 1 blog, 5 git_repo).
 * Run from apps/mcp-server: node --import tsx scripts/gen-testdata-lock.ts
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildLock, validateLock, writeLock } from "@rig-testlab/catalog";
import type { CatalogEntry, ProvenanceEdge, SourcePin } from "@rig-testlab/catalog";

const COMMIT = "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93";

function edge(sourceCatalogId: string, depth: 1 | 2, url: string): ProvenanceEdge {
  return { sourceCatalogId, depth, catalogCommit: COMMIT, urlAsLinked: url, discoveredAt: "2026-08-01T00:00:00Z" };
}

function hex(seed: number): string {
  return seed.toString(16).padStart(8, "0").repeat(5);
}

interface RepoSpec {
  owner: string;
  repo: string;
  name: string;
  desc: string;
  cats: string[];
  caps: string[];
  spdx: string | null;
  kind: "permissive" | "weak_permissive" | "copyleft" | "restrictive" | "missing" | "unknown";
  dead?: boolean;
  list?: boolean;
  pinState?: SourcePin["pinState"];
  nested?: string;
}

function repoEntry(s: RepoSpec): CatalogEntry {
  const id = `${s.owner.toLowerCase()}--${s.repo.toLowerCase()}`;
  const sha = hex(id.length * 7919 + id.charCodeAt(0));
  const url = `https://github.com/${s.owner}/${s.repo}`;
  const provenance = [edge("awesome-testing", 1, url)];
  if (s.nested !== undefined) provenance.push(edge(s.nested, 2, url));
  return {
    id,
    name: s.name,
    categories: s.cats,
    capabilities: s.caps,
    canonicalUrl: url,
    targetKind: s.list === true ? "awesome_list" : "git_repo",
    description: s.desc,
    provenance,
    repository: {
      owner: s.owner,
      name: s.repo,
      defaultBranch: "main",
      commitSha: sha,
      submodulePath: `sources/direct/${s.owner.toLowerCase()}/${id}`,
      reportedSizeKb: 1200 + id.length * 37,
    },
    license: { spdx: s.spdx, kind: s.kind },
    credentialRequirement: "none",
    lastValidation: s.dead === true
      ? { at: "2026-08-02T00:00:00Z", method: "github_api", httpStatus: 404, notes: "not_found (two independent observations)" }
      : { at: "2026-08-02T00:00:00Z", method: "github_api", httpStatus: 200 },
    redirectHistory: [],
    adoptionTier: s.dead === true ? "quarantined" : "watchlist",
    executionPolicy: "reference_only",
    resolutionStatus: s.dead === true ? "dead" : "active",
  };
}

function repoPin(s: RepoSpec, state: SourcePin["pinState"]): SourcePin {
  const entry = repoEntry(s);
  return {
    entryId: entry.id,
    repoUrl: `https://github.com/${s.owner}/${s.repo}.git`,
    owner: s.owner,
    name: s.repo,
    defaultBranch: "main",
    commitSha: entry.repository!.commitSha,
    submodulePath: entry.repository!.submodulePath,
    gitmodulesName: entry.id,
    shallowCapable: true,
    reportedSizeKb: entry.repository!.reportedSizeKb,
    pinState: state,
    lastHydratedAt: null,
  };
}

const repos: RepoSpec[] = [
  { owner: "seleniumhq", repo: "selenium", name: "Selenium", desc: "Widely used browser automation framework driving real browsers through the WebDriver protocol", cats: ["browser tools"], caps: ["browser-automation", "selenium", "webdriver"], spdx: "Apache-2.0", kind: "permissive" },
  { owner: "puppeteer", repo: "puppeteer", name: "Puppeteer", desc: "Node library controlling Chrome and Firefox over the Chrome DevTools Protocol", cats: ["browser tools"], caps: ["browser-automation", "cdp", "screenshot"], spdx: "Apache-2.0", kind: "permissive" },
  { owner: "microsoft", repo: "playwright", name: "Playwright", desc: "End-to-end testing framework for Chromium, WebKit, and Firefox with trace viewer", cats: ["e2e testing"], caps: ["e2e-testing", "browser-automation", "tracing"], spdx: "Apache-2.0", kind: "permissive" },
  { owner: "cypress-io", repo: "cypress", name: "Cypress", desc: "Frontend end-to-end test runner executing in the browser with time-travel debugging", cats: ["e2e testing"], caps: ["e2e-testing", "video"], spdx: "MIT", kind: "permissive" },
  { owner: "vitest-dev", repo: "vitest", name: "Vitest", desc: "Fast unit test runner powered by Vite with watch mode and coverage", cats: ["unit testing"], caps: ["unit-testing", "coverage"], spdx: "MIT", kind: "permissive" },
  { owner: "webdriverio", repo: "webdriverio", name: "WebdriverIO", desc: "Dead entry kept to exercise honest dead resolution", cats: ["browser tools"], caps: ["browser-automation"], spdx: null, kind: "missing", dead: true },
  { owner: "thejambo", repo: "awesome-testing", name: "Awesome Testing", desc: "Curated awesome list of software testing tools, books, and training", cats: ["awesome lists"], caps: ["catalog", "curated-list"], spdx: "CC0-1.0", kind: "permissive", list: true },
  { owner: "nikoleglakov", repo: "awesome-playwright", name: "Awesome Playwright", desc: "Curated list of Playwright resources, reporters, and helpers", cats: ["awesome lists"], caps: ["catalog", "playwright"], spdx: "MIT", kind: "permissive", list: true, nested: "playwright-community--playwright-test" },
];

const entries: CatalogEntry[] = [
  ...repos.map(repoEntry),
  (() => {
    const e = repoEntry(repos[0]!);
    void e;
    return {
      id: "microsoft--github-org",
      name: "Microsoft (GitHub org)",
      categories: ["organizations"],
      capabilities: ["organization", "microsoft-ecosystem"],
      canonicalUrl: "https://github.com/microsoft",
      targetKind: "github_org" as const,
      description: "GitHub organization page — metadata-only reference, not a clonable repository",
      provenance: [edge("awesome-testing", 1, "https://github.com/microsoft")],
      license: { spdx: null, kind: "unknown" as const },
      credentialRequirement: "none" as const,
      lastValidation: { at: "2026-08-02T00:00:00Z", method: "http_get" as const, httpStatus: 200 },
      redirectHistory: [],
      adoptionTier: "reference" as const,
      executionPolicy: "reference_only" as const,
      resolutionStatus: "active" as const,
    };
  })(),
  {
    id: "katalon--www",
    name: "Katalon Platform",
    categories: ["commercial platforms"],
    capabilities: ["test-management", "recorder"],
    canonicalUrl: "https://www.katalon.com",
    targetKind: "website",
    description: "Commercial test automation platform website with free-tier sign-up",
    provenance: [edge("awesome-testing", 1, "https://www.katalon.com")],
    license: { spdx: null, kind: "restrictive" },
    credentialRequirement: "free_account",
    lastValidation: { at: "2026-08-02T00:00:00Z", method: "http_get", httpStatus: 200 },
    redirectHistory: [],
    adoptionTier: "watchlist",
    executionPolicy: "reference_only",
    resolutionStatus: "active",
  },
  {
    id: "browserstack--www",
    name: "BrowserStack",
    categories: ["commercial platforms"],
    capabilities: ["device-cloud", "cross-browser"],
    canonicalUrl: "https://www.browserstack.com",
    targetKind: "saas",
    description: "Paid cloud device and browser grid for running automated test suites",
    provenance: [edge("awesome-testing", 1, "https://www.browserstack.com")],
    license: { spdx: null, kind: "restrictive" },
    credentialRequirement: "paid",
    lastValidation: { at: "2026-08-02T00:00:00Z", method: "http_get", httpStatus: 200 },
    redirectHistory: [],
    adoptionTier: "watchlist",
    executionPolicy: "reference_only",
    resolutionStatus: "active",
  },
  {
    id: "ministryoftesting--blog",
    name: "Ministry of Testing",
    categories: ["blogs"],
    capabilities: ["community", "testing-practice"],
    canonicalUrl: "https://ministryoftesting.com",
    targetKind: "blog",
    description: "Testing community blog, newsletter, and conference content",
    provenance: [edge("awesome-testing", 1, "https://ministryoftesting.com")],
    license: { spdx: null, kind: "unknown" },
    credentialRequirement: "none",
    lastValidation: { at: "2026-08-02T00:00:00Z", method: "http_get", httpStatus: 200 },
    redirectHistory: [],
    adoptionTier: "reference",
    executionPolicy: "reference_only",
    resolutionStatus: "active",
  },
];

const pins: SourcePin[] = [
  ...repos
    .filter((r) => r.owner !== "webdriverio")
    .map((r) => repoPin(r, "pending")),
  repoPin(repos.find((r) => r.dead === true)!, "failed"),
  {
    entryId: "microsoft--github-org",
    repoUrl: "https://github.com/microsoft",
    owner: "microsoft",
    name: "github.com",
    defaultBranch: "HEAD",
    commitSha: "0".repeat(40),
    submodulePath: "sources/direct/microsoft/github--microsoft",
    gitmodulesName: "microsoft--github-org",
    shallowCapable: false,
    reportedSizeKb: 0,
    pinState: "skipped_nonrepo",
    lastHydratedAt: null,
  },
];

const lock = buildLock({
  entries,
  pins,
  nestedCatalogs: [
    {
      id: "awesome-testing",
      url: "https://github.com/TheJambo/awesome-testing",
      commit: COMMIT,
      status: "active",
      expandedLinkCount: entries.length,
      discoveredCatalogCount: 1,
    },
    {
      id: "playwright-community--playwright-test",
      url: "https://github.com/playwright-community/playwright-test",
      commit: "0".repeat(40),
      status: "unresolved",
      expandedLinkCount: 1,
      discoveredCatalogCount: 0,
    },
  ],
  generatedFrom: {
    repo: "TheJambo/awesome-testing",
    commit: COMMIT,
    readmeSha256: createHash("sha256").update("# Awesome Testing — minimal fixture readme\n").digest("hex"),
  },
});

const verdict = validateLock(lock);
if (!verdict.ok) {
  console.error("INVALID LOCK:", verdict.errors.slice(0, 8));
  process.exit(1);
}

writeLock(lock, join(import.meta.dirname, "..", "testdata", "catalog.lock.minimal.json"));
console.log(`wrote ${entries.length} entries, ${pins.length} pins; validateLock ok`);
