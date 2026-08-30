import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  buildLock,
  validateLock,
  verifyLock,
  serializeLock,
  type CatalogEntry,
  type CatalogLock,
  type SourcePin,
} from "@rig-testlab/catalog";

const sha = (c: string): string =>
  createHash("sha256").update(c).digest("hex").slice(0, 40);

const PROV1 = (url: string, catalogCommit: string) => ({
  sourceCatalogId: "awesome-testing",
  depth: 1 as const,
  catalogCommit,
  urlAsLinked: url,
  discoveredAt: "2026-08-28T21:20:23Z",
});

const CAT_COMMIT = "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93";

function repoEntry(
  id: string,
  name: string,
  owner: string,
  repo: string,
  url: string,
  spdx: string | null,
  kind: CatalogEntry["license"]["kind"],
  tier: CatalogEntry["adoptionTier"],
  policy: CatalogEntry["executionPolicy"],
  status: CatalogEntry["resolutionStatus"],
  sizeKb: number,
  extraProvDepth2 = false,
): CatalogEntry {
  const commit = sha(id);
  const provenance = [PROV1(url, CAT_COMMIT)];
  if (extraProvDepth2) {
    provenance.push({
      sourceCatalogId: "ssharper--awesome-playwright",
      depth: 2 as const,
      catalogCommit: sha("nested").padEnd(40, "0").slice(0, 40),
      urlAsLinked: url,
      discoveredAt: "2026-08-28T21:20:23Z",
    });
  }
  return {
    id,
    name,
    categories: ["test-automation"],
    capabilities: [kind === "restrictive" ? "commercial" : "automation"],
    canonicalUrl: url,
    targetKind: "git_repo",
    description: `${name} — fixture entry.`,
    provenance,
    repository: {
      owner,
      name: repo,
      defaultBranch: "main",
      commitSha: commit,
      submodulePath: `sources/direct/${owner}/${id}`,
      reportedSizeKb: sizeKb,
    },
    license: { spdx, kind },
    credentialRequirement: "none",
    lastValidation: { at: "2026-08-28T21:20:23Z", method: "github_api", httpStatus: 200 },
    redirectHistory: [],
    adoptionTier: tier,
    executionPolicy: policy,
    resolutionStatus: status,
  };
}

function nonRepoEntry(
  id: string,
  name: string,
  url: string,
  targetKind: CatalogEntry["targetKind"],
  license: CatalogEntry["license"],
  policy: CatalogEntry["executionPolicy"],
  tier: CatalogEntry["adoptionTier"],
  status: CatalogEntry["resolutionStatus"],
  credential: CatalogEntry["credentialRequirement"],
  method: CatalogEntry["lastValidation"]["method"] = "http_get",
): CatalogEntry {
  return {
    id,
    name,
    categories: ["resources"],
    capabilities: ["reference"],
    canonicalUrl: url,
    targetKind,
    description: `${name} — fixture entry (non-repository resource).`,
    provenance: [PROV1(url, CAT_COMMIT)],
    license,
    credentialRequirement: credential,
    lastValidation: { at: "2026-08-28T21:20:23Z", method },
    redirectHistory: [],
    adoptionTier: tier,
    executionPolicy: policy,
    resolutionStatus: status,
  };
}

function pinFor(e: CatalogEntry, pinState: SourcePin["pinState"], hydrated: boolean): SourcePin {
  const r = e.repository!;
  return {
    entryId: e.id,
    repoUrl: e.canonicalUrl,
    owner: r.owner,
    name: r.name,
    defaultBranch: r.defaultBranch,
    commitSha: r.commitSha,
    submodulePath: r.submodulePath,
    gitmodulesName: e.id,
    shallowCapable: true,
    reportedSizeKb: r.reportedSizeKb,
    pinState,
    lastHydratedAt: hydrated ? "2026-08-29T06:00:00Z" : null,
  };
}

const cypress = repoEntry("cypress-io--cypress", "Cypress", "cypress-io", "cypress", "https://github.com/cypress-io/cypress", "MIT", "permissive", "core_runner", "allowlisted", "active", 120_000);
const playwright = repoEntry("microsoft--playwright", "Playwright", "microsoft", "playwright", "https://github.com/microsoft/playwright", "Apache-2.0", "permissive", "approved_adapter", "sandbox_required", "active", 90_000, true);
const selenium = repoEntry("seleniumhq--selenium", "Selenium", "seleniumhq", "selenium", "https://github.com/SeleniumHQ/selenium", "Apache-2.0", "permissive", "core_runner", "allowlisted", "active", 400_000);
const bruno = repoEntry("usebruno--bruno", "Bruno", "usebruno", "bruno", "https://github.com/usebruno/bruno", "MIT", "permissive", "approved_adapter", "allowlisted", "redirected", 30_000);
const copyleft = repoEntry("gauge-test--gauge", "Gauge", "getgauge", "gauge", "https://github.com/getgauge/gauge", "GPL-3.0-only", "copyleft", "optional_adapter", "sandbox_required", "active", 25_000);

const dead = nonRepoEntry("qaforums--dead", "QA Forums (dead)", "https://qaforums.example.com", "website", { spdx: null, kind: "unknown" }, "reference_only", "watchlist", "dead", "none", "manual");
const paid = nonRepoEntry("testrig--cloud", "TestRig Cloud", "https://testrig.example.com", "saas", { spdx: null, kind: "restrictive" }, "reference_only", "watchlist", "active", "paid");
const licenseMissing = nonRepoEntry("community--awesome-a11y", "Awesome Accessibility (license missing)", "https://github.com/community/awesome-a11y", "awesome_list", { spdx: null, kind: "missing" }, "reference_only", "reference", "active", "free_account");
const book = nonRepoEntry("art-of-software-testing", "The Art of Software Testing", "https://example.com/aost", "book", { spdx: null, kind: "restrictive" }, "reference_only", "reference", "active", "none", "manual");
const newsletter = nonRepoEntry("testing-trajectory", "The Testing Trajectory", "https://newsletter.example.com", "newsletter", { spdx: null, kind: "unknown" }, "reference_only", "watchlist", "unresolved", "free_account");
const training = nonRepoEntry("appium-training", "Appium Training", "https://training.example.com/appium", "training", { spdx: null, kind: "unknown" }, "reference_only", "watchlist", "rate_limited", "free_account");

const entries = [cypress, playwright, selenium, bruno, copyleft, dead, paid, licenseMissing, book, newsletter, training];
const pins = [
  pinFor(cypress, "pinned", true),
  pinFor(playwright, "pending", false),
  pinFor(selenium, "pinned", true),
  pinFor(bruno, "pinned", false),
  pinFor(copyleft, "failed", false),
];

const lock: CatalogLock = buildLock({
  entries,
  pins,
  nestedCatalogs: [
    {
      id: "ssharper--awesome-playwright",
      url: "https://github.com/ssharper/awesome-playwright",
      commit: sha("awesome-playwright"),
      status: "active",
      expandedLinkCount: 14,
      discoveredCatalogCount: 1,
    },
  ],
  generatedFrom: {
    repo: "TheJambo/awesome-testing",
    commit: "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93",
    readmeSha256: createHash("sha256").update("rig-testlab minimal fixture readme").digest("hex"),
  },
});

const schema = validateLock(lock);
if (!schema.ok) {
  console.error("validateLock FAILED:", schema.errors);
  process.exit(1);
}
const integrity = verifyLock(lock);
if (!integrity.ok) {
  console.error("verifyLock FAILED:", integrity.errors);
  process.exit(1);
}
const out = process.argv[2]!;
mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
writeFileSync(out, serializeLock(lock));
console.log(`OK entries=${lock.entries.length} pins=${lock.pins.length} schema=pass integrity=pass`);
