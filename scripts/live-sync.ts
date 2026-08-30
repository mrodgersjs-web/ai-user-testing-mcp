/**
 * Dev entrypoint: run the full provider-aware catalog sync against live GitHub
 * and write catalog.lock.json. The CLI (`rig-testlab catalog sync`) wraps the
 * same library; this script exists so the sync can run before the CLI ships.
 *
 * Usage: GH_TOKEN=$(gh auth token) pnpm exec tsx scripts/live-sync.ts [readmePath]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  GitHubClient,
  parseFirstLevel,
  resolveEntries,
  validateLock,
  writeLock,
  AWESOME_TESTING_COMMIT,
  repoRoot,
} from "../packages/catalog/src/index.js";

const root = repoRoot(process.cwd());
const readmePath = resolve(process.argv[2] ?? "/tmp/awt-ff695aa/README.md");
const readme = readFileSync(readmePath, "utf8");

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GH_TOKEN or GITHUB_TOKEN must be set (unauthenticated calls will be rate-limited)");
  process.exit(1);
}

const client = new GitHubClient({ token });
const parsed = parseFirstLevel(readme, AWESOME_TESTING_COMMIT);
console.log(`parsed first-level entries: ${parsed.length}`);

const lock = await resolveEntries(parsed, { client, readmeMarkdown: readme });
const check = validateLock(lock);
if (!check.ok) {
  console.error("lock validation FAILED:", check.errors.slice(0, 20));
  process.exit(2);
}
const path = writeLock(lock, resolve(root, "catalog.lock.json"));
console.log(`wrote ${path}`);
console.log(
  `entries=${lock.entries.length} pins=${lock.pins.length} nested=${lock.nestedCatalogs.length}`,
);
console.log(`status: ${JSON.stringify(lock.statistics.byResolutionStatus)}`);
console.log(`tiers:  ${JSON.stringify(lock.statistics.byAdoptionTier)}`);
