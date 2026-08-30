/**
 * `rig-testlab catalog sync|verify|search|show|stats`.
 *
 * sync   — parse pinned README → resolveEntries → writeLock. Token by NAME from
 *          GH_TOKEN/GITHUB_TOKEN env, else `gh auth token` via the injected
 *          command runner; never logged. No token ⇒ GH_TOKEN_MISSING, never a
 *          fake lock. --fixture <readme> runs offline against a committed README.
 * verify — schema/integrity + pins↔gitlink equality via `git ls-tree -r HEAD
 *          sources/`; any mismatch is RED (exit 1), never silenced.
 * search — FTS index cached by lock sha256; rebuild only on byte change.
 * show   — one entry with provenance, pin, and policy.
 * stats  — statistics block plus honest derived counts.
 */
import { readFileSync } from "node:fs";
import {
  AWESOME_TESTING_COMMIT,
  AWESOME_TESTING_REPO,
  parseFirstLevel,
  resolveEntries,
  searchIndex,
  writeLock,
  type CatalogEntry,
  type SourcePin,
} from "@rig-testlab/catalog";
import { defaultMakeGitHubClient, defaultRunCommand, type CommandResult } from "../deps.js";
import type { Ctx } from "../context.js";
import { CommandFailure, UsageError } from "../errors.js";
import { ensureIndex, loadLockFailClosed } from "../guards.js";
import { bool, intOpt, str } from "../opts.js";


const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const CATALOG_HELP = `rig-testlab catalog <subcommand>

  sync    [--fixture <readme.md>] [--out <lock>] [--nested] [--root <dir>] [--json]
          Resolve the pinned Awesome Testing README into catalog.lock.json.
  verify  [--lock <file>] [--fixture <lock>] [--root <dir>] [--json]
          Lock schema/integrity + pins vs gitlink SHAs (git ls-tree sources/).
  search  <query...> [--limit N] [--lock <file>] [--fixture <lock>] [--json]
  show    <entry-id> [--lock <file>] [--fixture <lock>] [--json]
  stats   [--lock <file>] [--fixture <lock>] [--json]

--fixture: sync takes a README; verify/search/show/stats take a lock override.`;

export const catalogSubHelp: Record<string, string> = {
  sync: `${CATALOG_HELP}\n\nsync specifics: without --fixture the README is fetched at the pinned commit; nested-catalog expansion is skipped under --fixture unless --nested.`,
  verify: `${CATALOG_HELP}\n\nverify specifics: pinned pins require an equal gitlink; pending pins may have none; unexpected gitlinks are always RED.`,
  search: CATALOG_HELP,
  show: CATALOG_HELP,
  stats: CATALOG_HELP,
};

export function catalogLockPath(ctx: Ctx): string {
  const path = str(ctx.values, "lock") ?? str(ctx.values, "fixture") ?? ctx.paths.lockPath;
  if (path === undefined) {
    throw new UsageError("ROOT_NOT_FOUND", `${ctx.command}: no repo root (pnpm-workspace.yaml) found; pass --lock <file> or --root <dir>`, ctx.help);
  }
  return path;
}

/** Token by NAME only. Never logs values; presence is reported, content never. */
async function resolveGitHubToken(ctx: Ctx): Promise<string | undefined> {
  const fromEnv = ctx.env.GH_TOKEN ?? ctx.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  const gh = await (ctx.deps.runCommand ?? defaultRunCommand)(["gh", "auth", "token"], {
    cwd: ctx.paths.root ?? ctx.deps.cwd,
  });
  if (gh.code === 0 && gh.stdout.trim().length > 0) return gh.stdout.trim();
  return undefined;
}

export async function catalogSync(ctx: Ctx): Promise<number> {
  const fixture = str(ctx.values, "fixture");
  const outPath = str(ctx.values, "out") ?? ctx.paths.lockPath;
  if (outPath === undefined) {
    throw new UsageError("ROOT_NOT_FOUND", "catalog sync: no repo root; pass --out <lock> or --root <dir>", ctx.help);
  }
  const token = await resolveGitHubToken(ctx);
  if (token === undefined) {
    throw new CommandFailure(
      "GH_TOKEN_MISSING",
      "catalog sync needs GitHub credentials: set GH_TOKEN or GITHUB_TOKEN, or install and authenticate the `gh` CLI. Refusing to resolve without a provider.",
    );
  }
  let readme: string;
  if (fixture !== undefined) {
    try {
      readme = readFileSync(fixture, "utf8");
    } catch (err) {
      throw new CommandFailure("FIXTURE_UNREADABLE", `catalog sync: cannot read --fixture ${fixture}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    const [owner, name] = AWESOME_TESTING_REPO.split("/");
    const client = (ctx.deps.makeGitHubClient ?? defaultMakeGitHubClient)({ token, fetchImpl: ctx.deps.fetchImpl });
    try {
      readme = await client.getReadmeAt(owner!, name!, AWESOME_TESTING_COMMIT);
    } catch (err) {
      throw new CommandFailure(
        "README_FETCH_FAILED",
        `catalog sync: failed to fetch README of ${AWESOME_TESTING_REPO}@${AWESOME_TESTING_COMMIT.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const client = (ctx.deps.makeGitHubClient ?? defaultMakeGitHubClient)({ token, fetchImpl: ctx.deps.fetchImpl });
  const entries = parseFirstLevel(readme);
  const skipNested = fixture !== undefined && !bool(ctx.values, "nested");
  const lock = await resolveEntries(entries, {
    client,
    readmeMarkdown: readme,
    ...(skipNested ? { nested: [] as const } : {}),
    ...(ctx.deps.now === undefined ? {} : { now: ctx.deps.now().toISOString() }),
  });
  const written = writeLock(lock, outPath);
  ctx.rep.line(`wrote ${written}`);
  ctx.rep.line(`entries=${lock.entries.length} pins=${lock.pins.length} nested=${lock.nestedCatalogs.length}`);
  ctx.rep.result("catalog sync", {
    lockPath: written,
    entries: lock.entries.length,
    pins: lock.pins.length,
    nestedCatalogs: lock.nestedCatalogs.length,
    tokenSource: ctx.env.GH_TOKEN !== undefined || ctx.env.GITHUB_TOKEN !== undefined ? "env" : "gh-cli",
  });
  return 0;
}

interface Gitlink {
  path: string;
  sha: string;
}

function parseLsTree(stdout: string): Gitlink[] {
  const links: Gitlink[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const [meta, path] = line.split("\t");
    if (meta === undefined || path === undefined) continue;
    const [mode, type, sha] = meta.split(" ");
    if (type === "commit" && mode === "160000" && sha !== undefined) links.push({ path, sha });
  }
  return links;
}

export async function catalogVerify(ctx: Ctx): Promise<number> {
  const lock = loadLockFailClosed(catalogLockPath(ctx)); // fail-closed: exit 2 before any git call
  const run = ctx.deps.runCommand ?? defaultRunCommand;
  const res: CommandResult = await run(["git", "ls-tree", "-r", "HEAD", "sources/"], {
    cwd: ctx.paths.root ?? ctx.deps.cwd,
  });
  if (res.code !== 0) {
    throw new CommandFailure("GIT_UNAVAILABLE", `catalog verify: git ls-tree failed (exit ${res.code}): ${res.stderr.trim() || "no stderr"}`);
  }
  const gitlinks = new Map(parseLsTree(res.stdout).map((g) => [g.path, g.sha]));
  const failures: string[] = [];
  const notes: string[] = [];
  for (const pin of lock.pins) {
    const gitlink = gitlinks.get(pin.submodulePath);
    gitlinks.delete(pin.submodulePath);
    if (pin.pinState === "pinned") {
      if (gitlink === undefined) failures.push(`MISSING_GITLINK ${pin.entryId}: pinned pin has no gitlink at ${pin.submodulePath}`);
      else if (gitlink !== pin.commitSha) failures.push(`SHA_MISMATCH ${pin.entryId}: lock ${pin.commitSha} != gitlink ${gitlink} at ${pin.submodulePath}`);
    } else if (pin.pinState === "pending") {
      if (gitlink === undefined) notes.push(`PENDING ${pin.entryId}: no gitlink yet at ${pin.submodulePath}`);
      else if (gitlink !== pin.commitSha) failures.push(`SHA_MISMATCH ${pin.entryId}: pending pin ${pin.commitSha} != gitlink ${gitlink} at ${pin.submodulePath}`);
      else notes.push(`PENDING_COMMITTED ${pin.entryId}: gitlink already matches`);
    } else if (gitlink !== undefined) {
      failures.push(`UNPINNED_GITLINK ${pin.submodulePath}: gitlink present for pin state ${pin.pinState}`);
    }
  }
  for (const [path, sha] of gitlinks) {
    failures.push(`UNTRACKED_SOURCE ${path}: gitlink ${sha} owned by no pin`);
  }
  for (const f of failures) ctx.rep.line(`RED   ${f}`);
  for (const n of notes) ctx.rep.line(`note  ${n}`);
  ctx.rep.line(failures.length === 0 ? `verify OK: ${lock.pins.length} pins checked` : `verify FAILED: ${failures.length} problem(s)`);
  ctx.rep.result("catalog verify", { ok: failures.length === 0, pinsChecked: lock.pins.length, failures, notes });
  return failures.length === 0 ? 0 : 1;
}

export async function catalogSearch(ctx: Ctx): Promise<number> {
  const query = ctx.positionals.join(" ").trim();
  if (query.length === 0) throw new UsageError("USAGE", "catalog search: empty query", ctx.help);
  const limit = intOpt(ctx.values, "limit", 10, 1, 500, "catalog search", ctx.help);
  const lockPath = catalogLockPath(ctx);
  const lock = loadLockFailClosed(lockPath);
  if (ctx.paths.indexDb === null || ctx.paths.indexKey === null) {
    throw new UsageError("ROOT_NOT_FOUND", "catalog search: index lives in the repo; pass --root <dir>", ctx.help);
  }
  const state = ensureIndex(lock, lockPath, ctx.paths.indexDb, ctx.paths.indexKey, ctx.deps);
  const hits = searchIndex(state.dbPath, query, limit);
  ctx.rep.line(state.reused ? `index reused (${state.dbPath})` : `index rebuilt: ${state.rows} rows`);
  hits.forEach((hit, i) => ctx.rep.line(`${String(i + 1).padStart(2)}. ${hit.id}  ${hit.name}  score=${hit.score.toFixed(4)}`));
  if (hits.length === 0) ctx.rep.line("no matches");
  ctx.rep.result("catalog search", { query, indexReused: state.reused, hits });
  return 0;
}

export async function catalogShow(ctx: Ctx): Promise<number> {
  const id = ctx.positionals[0];
  if (id === undefined) throw new UsageError("USAGE", "catalog show: <entry-id> required", ctx.help);
  if (!ID_RE.test(id)) {
    throw new UsageError("INVALID_ID", `catalog show: "${id}" does not match ^[a-z0-9][a-z0-9._-]*$`, ctx.help);
  }
  const lock = loadLockFailClosed(catalogLockPath(ctx));
  const entry = lock.entries.find((e) => e.id === id);
  if (entry === undefined) {
    throw new CommandFailure("ENTRY_NOT_FOUND", `catalog show: no entry "${id}" in this lock; try \`rig-testlab catalog search ${id}\``);
  }
  const pin = lock.pins.find((p) => p.entryId === id);
  printEntry(ctx, entry, pin);
  ctx.rep.result("catalog show", { entry, pin: pin ?? null });
  return 0;
}

function printEntry(ctx: Ctx, entry: CatalogEntry, pin: SourcePin | undefined): void {
  ctx.rep.line(`${entry.name}  [${entry.id}]`);
  ctx.rep.line(`  ${entry.canonicalUrl}  (${entry.targetKind})`);
  ctx.rep.line(`  status=${entry.resolutionStatus} tier=${entry.adoptionTier} policy=${entry.executionPolicy}`);
  ctx.rep.line(`  license=${entry.license.spdx ?? "null"}/${entry.license.kind} credentials=${entry.credentialRequirement}`);
  ctx.rep.line(`  ${entry.description}`);
  for (const p of entry.provenance) {
    ctx.rep.line(`  provenance: ${p.sourceCatalogId} depth=${p.depth} @${p.catalogCommit.slice(0, 8)} linked=${p.urlAsLinked}`);
  }
  if (entry.redirectHistory.length > 0) {
    for (const h of entry.redirectHistory) ctx.rep.line(`  redirect: ${h.from} -> ${h.to} (${h.status})`);
  }
  if (entry.repository !== undefined) {
    ctx.rep.line(`  repository: ${entry.repository.owner}/${entry.repository.name} @${entry.repository.commitSha} (${entry.repository.submodulePath})`);
  }
  if (pin !== undefined) {
    ctx.rep.line(`  pin: state=${pin.pinState} size=${pin.reportedSizeKb}KB shallow=${pin.shallowCapable} hydrated=${pin.lastHydratedAt ?? "never"}`);
  }
}

export async function catalogStats(ctx: Ctx): Promise<number> {
  const lock = loadLockFailClosed(catalogLockPath(ctx));
  const pinStates: Record<string, number> = {};
  for (const p of lock.pins) pinStates[p.pinState] = (pinStates[p.pinState] ?? 0) + 1;
  const referenceOnly = lock.entries.filter((e) => e.executionPolicy === "reference_only").length;
  const executable = lock.entries.filter((e) => e.executionPolicy !== "reference_only").length;
  ctx.rep.line(`catalog statistics (${lock.entries.length} entries, ${lock.pins.length} pins)`);
  ctx.rep.line(`  first-level=${lock.statistics.firstLevelCount} uniqueRepos=${lock.statistics.uniqueRepos}`);
  ctx.rep.line(`  resolution: ${Object.entries(lock.statistics.byResolutionStatus).map(([k, v]) => `${k}=${String(v)}`).join(" ")}`);
  ctx.rep.line(`  tiers: ${Object.entries(lock.statistics.byAdoptionTier).map(([k, v]) => `${k}=${String(v)}`).join(" ")}`);
  ctx.rep.line(`  pins by state: ${Object.entries(pinStates).map(([k, v]) => `${k}=${String(v)}`).join(" ")}`);
  ctx.rep.line(`  executable=${executable} reference_only=${referenceOnly} (reference_only sources are never executable)`);
  ctx.rep.result("catalog stats", {
    entries: lock.entries.length,
    pins: lock.pins.length,
    statistics: lock.statistics,
    pinsByState: pinStates,
    executable,
    referenceOnly,
  });
  return 0;
}
