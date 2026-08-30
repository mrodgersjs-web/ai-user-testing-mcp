/**
 * Resolve parsed catalog entries against the GitHub provider and expand the
 * frozen nested-catalog set into a CatalogLock.
 *
 * Invariants enforced here:
 *  - One entry + one SourcePin per canonical repo, one ProvenanceEdge per origin catalog.
 *  - 403/429/timeout ⇒ rate_limited/unresolved — NEVER dead.
 *  - `dead` requires the SAME not_found observation from TWO independent calls.
 *  - Catalogs discovered inside nested READMEs increment discoveredCatalogCount, never expand.
 *  - A failed clone lookup demotes git_repo→other so the entry stays schema-valid
 *    (git_repo requires a repository block); blocked resources are preserved, never dropped.
 */
import { createHash } from "node:crypto";
import type {
  CatalogEntry,
  CatalogLock,
  NestedCatalogRef,
  ProvenanceEdge,
  ResolutionStatus,
  SourcePin,
} from "./types.js";
import { GitHubApiError, GitHubClient, type RepoInfo, type TreeEntry } from "./fetch.js";
import {
  AWESOME_TESTING_COMMIT,
  AWESOME_TESTING_REPO,
  canonicalizeUrl,
  classifyLink,
  credentialRequirementFor,
  deriveCapabilities,
  entryIdFor,
  extractResourceLinks,
  type ParsedLink,
} from "./parse.js";
import { adoptionTierForRepo, executionPolicyForLicense } from "./policy.js";
import { NESTED_CATALOG_REPOS, type NestedCatalogConfig } from "./nested-catalogs.js";
import { buildLock } from "./lock.js";

/** Placeholder SHA (schema-valid 40-hex) for catalogs whose HEAD could not be fetched. */
export const UNRESOLVED_SHA = "0".repeat(40);

export interface ResolveOptions {
  client: GitHubClient;
  /** Exact README text of the pinned commit (hashed into generatedFrom). */
  readmeMarkdown: string;
  /** Override for tests; defaults to the frozen 11-repo set. */
  nested?: readonly NestedCatalogConfig[];
  pinnedCommit?: string;
  /** ISO timestamp stamped on provider observations (injectable for determinism). */
  now?: string;
}

function statusFromError(e: unknown): ResolutionStatus {
  if (e instanceof GitHubApiError) {
    switch (e.errorClass) {
      case "rate_limited":
        return "rate_limited";
      case "blocked_by_provider":
        return "blocked_by_provider";
      case "not_found":
        return "dead";
      case "unresolved":
        return "unresolved";
    }
  }
  return "unresolved";
}

function noteFromError(e: unknown): string {
  return e instanceof GitHubApiError ? `${e.errorClass} (${e.status ?? "network"})` : String(e);
}

interface Registry {
  entries: CatalogEntry[];
  index: Map<string, CatalogEntry>;
}

function repoKey(owner: string, name: string): string {
  return `repo:${owner.toLowerCase()}/${name.toLowerCase()}`;
}
function entryKey(entry: CatalogEntry): string {
  return entry.targetKind === "git_repo" || entry.targetKind === "awesome_list"
    ? repoKey(...(entry.id.split("--") as [string, string]))
    : `url:${entry.canonicalUrl}`;
}
function linkKey(link: ParsedLink): string {
  const cls = classifyLink(link);
  return cls.cloneTarget && cls.repo ? repoKey(cls.repo.owner, cls.repo.name) : `url:${canonicalizeUrl(link.url)}`;
}

function hasEdge(entry: CatalogEntry, edge: ProvenanceEdge): boolean {
  return entry.provenance.some(
    (p) => p.sourceCatalogId === edge.sourceCatalogId && p.depth === edge.depth && p.urlAsLinked === edge.urlAsLinked,
  );
}

/** Merge a nested (depth-2) link into the registry: existing entry gains an edge, new one is created. */
function mergeNestedLink(reg: Registry, link: ParsedLink, edge: ProvenanceEdge): boolean {
  const key = linkKey(link);
  const cls = classifyLink(link);
  const existing = reg.index.get(key);
  if (existing) {
    if (!hasEdge(existing, edge)) existing.provenance.push(edge);
    for (const c of cls.categories) if (!existing.categories.includes(c)) existing.categories.push(c);
    if (link.description && !existing.description) existing.description = link.description;
    if (cls.targetKind === "awesome_list" && existing.targetKind === "git_repo") existing.targetKind = "awesome_list";
    return false; // already known
  }
  const entry: CatalogEntry = {
    id: entryIdFor(link, cls),
    name: link.name,
    categories: [...cls.categories],
    capabilities: deriveCapabilities(link.name, link.description, cls.categories[0] ?? ""),
    canonicalUrl: canonicalizeUrl(link.url),
    targetKind: cls.targetKind,
    description: link.description,
    provenance: [edge],
    license: { spdx: null, kind: "unknown" },
    credentialRequirement: credentialRequirementFor(link.name, link.description),
    lastValidation: {
      at: edge.discoveredAt,
      method: "manual",
      notes: "discovered via nested catalog; provider check pending",
    },
    redirectHistory: [],
    adoptionTier: adoptionTierForRepo(cls.repo?.name ?? link.name),
    executionPolicy: executionPolicyForLicense({ spdx: null, kind: "unknown" }),
    resolutionStatus: "unresolved",
  };
  if (reg.index.has(entry.id)) entry.id = uniqueId(reg.index, entry.id);
  reg.index.set(key, entry);
  reg.entries.push(entry);
  return true; // new entry
}

function uniqueId(index: Map<string, CatalogEntry>, base: string): string {
  let n = 2;
  let id = base;
  const taken = new Set([...index.values()].map((e) => e.id));
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Fetch provider truth for one clone target and mutate the entry accordingly.
 * Double-confirms not_found with a second independent call before `dead`.
 */
async function resolveCloneTarget(
  client: GitHubClient,
  entry: CatalogEntry,
  repo: { owner: string; name: string },
  now: string,
  depth1: boolean,
  pinSink: SourcePin[],
): Promise<void> {
  let info: RepoInfo;
  try {
    info = await client.getRepo(repo.owner, repo.name);
  } catch (e) {
    if (e instanceof GitHubApiError && e.errorClass === "not_found") {
      let second: "dead" | "active" | ResolutionStatus;
      try {
        await client.getRepo(repo.owner, repo.name);
        second = "active"; // provider disagreed on the re-check — never dead
      } catch (e2) {
        second = statusFromError(e2);
      }
      entry.targetKind = entry.targetKind === "git_repo" ? "other" : entry.targetKind;
      if (second === "dead") {
        entry.resolutionStatus = "dead";
        entry.lastValidation = {
          at: now,
          method: "github_api",
          httpStatus: 404,
          notes: "404 confirmed by two independent observations",
        };
      } else if (second === "active") {
        entry.resolutionStatus = "unresolved";
        entry.lastValidation = {
          at: now,
          method: "github_api",
          notes: "provider disagreed between confirmations; kept for re-resolution",
        };
      } else {
        entry.resolutionStatus = second;
        entry.lastValidation = {
          at: now,
          method: "github_api",
          notes: `re-check observed ${second}`,
        };
      }
      return;
    }
    entry.resolutionStatus = statusFromError(e);
    entry.targetKind = entry.targetKind === "git_repo" ? "other" : entry.targetKind;
    entry.lastValidation = { at: now, method: "github_api", httpStatus: e instanceof GitHubApiError ? e.status : undefined, notes: noteFromError(e) };
    return;
  }

  let sha: string;
  try {
    sha = await client.getCommitSha(repo.owner, repo.name, info.defaultBranch);
  } catch (e) {
    entry.resolutionStatus = statusFromError(e);
    entry.targetKind = entry.targetKind === "git_repo" ? "other" : entry.targetKind;
    entry.lastValidation = { at: now, method: "github_api", httpStatus: e instanceof GitHubApiError ? e.status : undefined, notes: `commit fetch failed: ${noteFromError(e)}` };
    return;
  }

  entry.resolutionStatus = "active";
  entry.license = info.license;
  entry.repository = {
    owner: info.owner,
    name: info.name,
    defaultBranch: info.defaultBranch,
    commitSha: sha,
    submodulePath: `sources/${depth1 ? "direct" : "nested"}/${repo.owner.toLowerCase()}/${entry.id}`,
    reportedSizeKb: info.sizeKb,
  };
  entry.lastValidation = { at: now, method: "github_api", httpStatus: 200 };
  entry.adoptionTier = adoptionTierForRepo(repo.name);
  if (info.archived && entry.adoptionTier === "approved_adapter") entry.adoptionTier = "watchlist";
  entry.executionPolicy = executionPolicyForLicense(info.license, repo.name);
  pinSink.push({
    entryId: entry.id,
    repoUrl: `https://github.com/${info.owner}/${info.name}`,
    owner: info.owner,
    name: info.name,
    defaultBranch: info.defaultBranch,
    commitSha: sha,
    submodulePath: entry.repository.submodulePath,
    gitmodulesName: entry.id,
    shallowCapable: true,
    reportedSizeKb: info.sizeKb,
    pinState: "pinned",
    lastHydratedAt: null,
  });
}

interface NestedOutcome {
  ref: NestedCatalogRef;
  links: Array<{ link: ParsedLink; edge: ProvenanceEdge }>;
}

/** Fetch one nested catalog's full markdown tree at its pinned commit and parse its links. */
async function expandNestedCatalog(
  client: GitHubClient,
  cfg: NestedCatalogConfig,
  now: string,
): Promise<NestedOutcome> {
  const url = `https://github.com/${cfg.owner}/${cfg.repo}`;
  const empty = (status: ResolutionStatus, commit = UNRESOLVED_SHA): NestedOutcome => ({
    ref: { id: cfg.id, url, commit, status, expandedLinkCount: 0, discoveredCatalogCount: 0 },
    links: [],
  });

  let info: RepoInfo;
  try {
    info = await client.getRepo(cfg.owner, cfg.repo);
  } catch (e) {
    if (e instanceof GitHubApiError && e.errorClass === "not_found") {
      try {
        await client.getRepo(cfg.owner, cfg.repo);
        return empty("unresolved"); // second call disagreed
      } catch {
        return empty("dead"); // double 404
      }
    }
    return empty(statusFromError(e));
  }
  let sha: string;
  try {
    sha = await client.getCommitSha(cfg.owner, cfg.repo, info.defaultBranch);
  } catch (e) {
    return empty(statusFromError(e));
  }

  // Tree-wide markdown extraction (ligurio/awesome-software-quality keeps its links
  // outside README): every *.md blob at the pinned commit, README first.
  let mdPaths: string[] = [];
  try {
    const tree: TreeEntry[] = await client.listTree(cfg.owner, cfg.repo, sha);
    mdPaths = tree
      .map((t) => t.path)
      .filter((p) => /\.md$/i.test(p))
      .sort((a, b) => rankMd(a) - rankMd(b) || a.localeCompare(b));
  } catch {
    mdPaths = [];
  }
  if (!mdPaths.some((p) => p.toLowerCase() === "readme.md")) mdPaths.unshift("README.md");

  const links: NestedOutcome["links"] = [];
  let discoveredCatalogCount = 0;
  for (const p of mdPaths.slice(0, 200)) {
    let md: string;
    try {
      md = await client.getFileAt(cfg.owner, cfg.repo, sha, p);
    } catch {
      continue;
    }
    for (const link of extractResourceLinks(md)) {
      const selfLinked =
        classifyLink(link).repo?.owner.toLowerCase() === cfg.owner.toLowerCase() &&
        classifyLink(link).repo?.name.toLowerCase() === cfg.repo.toLowerCase();
      if (selfLinked) continue;
      const cls = classifyLink(link);
      if (cls.targetKind === "awesome_list") discoveredCatalogCount++;
      links.push({
        link,
        edge: {
          sourceCatalogId: cfg.id,
          depth: 2,
          catalogCommit: sha,
          urlAsLinked: link.url,
          discoveredAt: now,
        },
      });
    }
  }
  return {
    ref: { id: cfg.id, url, commit: sha, status: "active", expandedLinkCount: links.length, discoveredCatalogCount },
    links,
  };
}

function rankMd(path: string): number {
  const lower = path.toLowerCase();
  if (lower === "readme.md") return 0;
  return lower.includes("readme") ? 1 : 2;
}

/**
 * Full resolution pass: enrich depth-1 entries, expand nested catalogs (frozen 11),
 * dedup repos across all levels, and emit the CatalogLock with computed statistics.
 */
export async function resolveEntries(parsed: CatalogEntry[], opts: ResolveOptions): Promise<CatalogLock> {
  const now = opts.now ?? new Date().toISOString();
  const pinnedCommit = opts.pinnedCommit ?? AWESOME_TESTING_COMMIT;
  const nestedConfigs = opts.nested ?? NESTED_CATALOG_REPOS;

  const reg: Registry = { entries: parsed.map((e) => ({ ...e })), index: new Map() };
  for (const e of reg.entries) reg.index.set(entryKey(e), e);

  const pins: SourcePin[] = [];

  // Depth 1: enrich every clone target (git_repo + awesome_list carry repo blocks).
  for (const entry of reg.entries) {
    if (entry.targetKind !== "git_repo" && entry.targetKind !== "awesome_list") continue;
    const [owner, name] = entry.id.split("--");
    if (!owner || !name) continue;
    await resolveCloneTarget(opts.client, entry, { owner, name }, now, true, pins);
  }

  // Depth 2: expand the frozen nested set; one entry + one pin per repo across all levels.
  const nestedRefs: NestedCatalogRef[] = [];
  for (const cfg of nestedConfigs) {
    const outcome = await expandNestedCatalog(opts.client, cfg, now);
    nestedRefs.push(outcome.ref);
    for (const { link, edge } of outcome.links) mergeNestedLink(reg, link, edge);
  }
  for (const entry of reg.entries) {
    if (pins.some((p) => p.entryId === entry.id)) continue;
    if (entry.resolutionStatus !== "unresolved") continue; // depth-1 clones already processed
    if (entry.targetKind !== "git_repo" && entry.targetKind !== "awesome_list") continue;
    const [owner, name] = entry.id.split("--");
    if (!owner || !name) continue;
    await resolveCloneTarget(opts.client, entry, { owner, name }, now, false, pins);
  }

  const firstLevelCount = reg.entries.filter((e) => e.provenance.some((p) => p.depth === 1)).length;
  return buildLock({
    entries: reg.entries,
    pins,
    nestedCatalogs: nestedRefs,
    generatedFrom: {
      repo: AWESOME_TESTING_REPO,
      commit: pinnedCommit as CatalogLock["generatedFrom"]["commit"],
      readmeSha256: createHash("sha256").update(opts.readmeMarkdown, "utf8").digest("hex"),
    },
  });
}

