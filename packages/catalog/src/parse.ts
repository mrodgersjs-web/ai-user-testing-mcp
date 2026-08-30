/**
 * Markdown parser for the pinned Awesome Testing README.
 *
 * Ground truth (fixture testdata/awt-README-ff695aa.md, commit ff695aa):
 *   165 strict `- [name](url)` bullets → 3 URL-duplicates merge → EXACTLY
 *   162 unique first-level resources: 73 owner/repo clone-targets,
 *   1 github_org (OctoMind-dev), 88 non-github. The duplicates are
 *   karlhorky/learn-to-program, www.polarity.so and the manning.com
 *   "Chaos Engineering" book — each linked twice, kept as ONE entry with
 *   TWO provenance edges.
 *   The malformed `- [funapi] (https://funapi.dev)` bullet (space between
 *   `]` and `(` is not a CommonMark link) is intentionally NOT parsed.
 */
import type { CatalogEntry, CredentialRequirement, ProvenanceEdge, TargetKind } from "./types.js";
import { adoptionTierForRepo, executionPolicyForLicense } from "./policy.js";

export const AWESOME_TESTING_REPO = "TheJambo/awesome-testing";
export const AWESOME_TESTING_COMMIT = "ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93";
/** Author date of the pinned commit (meta.json); used as deterministic discovery time. */
export const AWESOME_TESTING_COMMIT_TIME = "2026-08-28T21:20:23Z";
export const AWESOME_TESTING_CATALOG_ID = "awesome-testing";

/** Sections that carry no resources. */
export const SKIP_SECTIONS: readonly string[] = [
  "Foreword",
  "Contents",
  "Contributing",
  "Code of Conduct",
  "License",
];

export interface ParsedLink {
  name: string;
  /** URL exactly as written in the bullet, trimmed but otherwise untouched. */
  url: string;
  description: string;
  /** Text of the enclosing `##` heading. */
  section: string;
  /** Text of the enclosing `###` heading, when present. */
  subsection: string | null;
}

export interface RepoTarget {
  owner: string;
  name: string;
}

const BULLET =
  /^[ \t]*[-*+][ \t]+\[([^\]]+)\]\(([^\s)]+)(?:[ \t]+["'][^"']*["'])?\)[ \t]*(?:[-–—:][ \t]?(.*?))?[ \t]*$/;
const HEADING = /^(#{2,3})[ \t]+(.*?)[ \t]*$/;
const IMAGE_BULLET = /^[ \t]*[-*+][ \t]+!\[/;

/** `## Training (Includes developer training...)` → `Training`. */
function headingTitle(raw: string): string {
  return raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * URLs in the wild are not always RFC 3986 URIs (unicode paths, `{}` template
 * placeholders, stray spaces). The lock schema requires `format: uri`, so every
 * extracted link is normalized: WHATWG URL first (punycode host, percent
 * encoding), encodeURI fallback, then a final pass for ASCII characters that
 * are legal in HTML links but illegal in URIs.
 */
const URI_ILLEGAL_ASCII = /[ "<>\\^`{|}]/g;
export function sanitizeLinkUrl(url: string): string {
  let out = url;
  if (/[^\x21-\x7e]/.test(out)) {
    try {
      out = new URL(out).href;
    } catch {
      out = encodeURI(out);
    }
  }
  out = out.replace(URI_ILLEGAL_ASCII, (c) => encodeURIComponent(c));
  // A second `#` inside the fragment is not a legal URI character; only the
  // first `#` is the fragment delimiter (e.g. gitter room links).
  const hashIdx = out.indexOf("#");
  if (hashIdx >= 0) {
    out = out.slice(0, hashIdx + 1) + out.slice(hashIdx + 1).replace(/#/g, "%23");
  }
  return out;
}

/** Extract every resource bullet outside skipped sections. */
export function extractResourceLinks(readmeMarkdown: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  let section: string | null = null;
  let subsection: string | null = null;
  for (const line of readmeMarkdown.split("\n")) {
    const h = HEADING.exec(line);
    if (h) {
      if (h[1] === "##") {
        section = h[2]!.trim();
        subsection = null;
      } else {
        subsection = headingTitle(h[2]!);
      }
      continue;
    }
    if (section === null || SKIP_SECTIONS.includes(section)) continue;
    if (IMAGE_BULLET.test(line)) continue; // badge / image bullets
    const m = BULLET.exec(line);
    if (!m) continue; // malformed links (e.g. `[name] (url)`) are not links
    const url = m[2]!.trim();
    if (url.startsWith("#") || url.startsWith("mailto:")) continue; // anchor-only
    out.push({
      name: m[1]!.trim(),
      url: sanitizeLinkUrl(url),
      description: (m[3] ?? "").trim(),
      section,
      subsection,
    });
  }
  return out;
}

/** Lowercase-slug per CatalogEntry id pattern ^[a-z0-9][a-z0-9._-]*$. */
export function slugId(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "");
  return /^[a-z0-9]/.test(s) ? s : `x-${s}`;
}

export function urlHost(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1]! : "";
}

/** Canonical dedup key: host lowercased, fragment dropped, root path normalized to '/'. */
export function canonicalizeUrl(url: string): string {
  const bare = url.split("#")[0]!.trim();
  const m = /^(https?:\/\/)([^/?#]+)(\/[^?#]*)?\/?$/i.exec(bare);
  if (!m) return bare.toLowerCase();
  let path = m[3] ?? "/";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return `${m[1]!.toLowerCase()}${m[2]!.toLowerCase()}${path}`;
}

export function parseGitHubTarget(url: string): { segments: string[] } | null {
  const host = urlHost(url).toLowerCase();
  if (host !== "github.com") return null;
  const path = url.slice(url.indexOf("github.com") + "github.com".length);
  const segments = path
    .split("#")[0]!
    .split("?")[0]!
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith(".md"));
  return { segments };
}

const METADATA_ONLY_SEGMENTS: Record<string, true> = {
  issues: true,
  discussions: true,
  pull: true,
  pulls: true,
  blob: true,
  tree: true,
  commits: true,
  releases: true,
  actions: true,
  security: true,
  stargazers: true,
  graphs: true,
  wiki: true,
};

const AWESOME_LIST_SECTION = "Suggested Awesome Lists";

function looksLikeAwesomeList(link: ParsedLink, repo: RepoTarget): boolean {
  if (link.section === AWESOME_LIST_SECTION) return true;
  const repoName = repo.name.toLowerCase();
  if (/^awesome[-_]/.test(repoName) || repoName === "howtheytest") return true;
  return /awesome (list|collection)/i.test(link.description);
}

export interface ClassifiedLink {
  targetKind: TargetKind;
  repo: RepoTarget | null;
  /** Categories this entry belongs to (subsection wins over section). */
  categories: string[];
  /** True when the entry is a clone target (owner/repo shape). */
  cloneTarget: boolean;
}

export function classifyLink(link: ParsedLink): ClassifiedLink {
  const category = link.subsection ?? headingTitle(link.section);
  const categories = [category];
  const gh = parseGitHubTarget(link.url);
  if (gh) {
    const segs = gh.segments;
    if (segs.length >= 2 && !(segs[0]!.toLowerCase() in METADATA_ONLY_SEGMENTS)) {
      const repo = { owner: segs[0]!, name: segs[1]! };
      if (segs.length > 2) {
        // 2-3 extra path segments (issues/blob/…): metadata-only, never a clone target.
        return { targetKind: "other", repo: null, categories, cloneTarget: false };
      }
      const kind: TargetKind = looksLikeAwesomeList(link, repo) ? "awesome_list" : "git_repo";
      return { targetKind: kind, repo, categories, cloneTarget: true };
    }
    if (segs.length === 1) {
      return { targetKind: "github_org", repo: null, categories, cloneTarget: false };
    }
    return { targetKind: "other", repo: null, categories, cloneTarget: false };
  }
  const host = urlHost(link.url).toLowerCase();
  if (host.endsWith(".github.io") || host === "raw.githubusercontent.com") {
    return { targetKind: "other", repo: null, categories, cloneTarget: false };
  }
  const section = headingTitle(link.section);
  if (section === "Books") return { targetKind: "book", repo: null, categories, cloneTarget: false };
  if (section.startsWith("Training"))
    return { targetKind: "training", repo: null, categories, cloneTarget: false };
  if (section === "Blogs") return { targetKind: "blog", repo: null, categories, cloneTarget: false };
  if (section === "Newsletters")
    return { targetKind: "newsletter", repo: null, categories, cloneTarget: false };
  return { targetKind: "website", repo: null, categories, cloneTarget: false };
}

export function entryIdFor(link: ParsedLink, cls: ClassifiedLink): string {
  if (cls.repo) return `${cls.repo.owner}--${cls.repo.name}`.toLowerCase();
  const host = urlHost(link.url).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/g, "");
  return slugId(`${link.name}-${host}`);
}

const CAPABILITY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["api", /\bapi\b|\brest\b|\bhttp\b|\bgrpc\b|swagger|openapi|webhook/i],
  ["security", /security|vulnerab|penetration|owasp|\bxss\b|scanner/i],
  ["ai", /\bai\b|\bllm\b|\bagents?\b|\bgpt\b|prompt/i],
  ["mocking", /mock|stub|fake|dummy|virtual/i],
  ["visual-regression", /visual|screenshot|pixel|golden/i],
  ["e2e", /\be2e\b|end[- ]to[- ]end/i],
  ["mobile", /mobile|\bios\b|android|flutter|\bxctest\b/i],
  ["performance", /performance|load test|stress|throughput/i],
  ["accessibility", /accessib|wcag|\ba11y\b|screen reader|color ?blind/i],
  ["test-data", /test data|synthetic|pseudonym|seed/i],
  ["session-replay", /record|replay/i],
  ["web3", /ethereum|solidity|smart contract|web3|blockchain/i],
  ["bdd", /\bbdd\b|gherkin|cucumber|behave/i],
  ["framework", /framework|runner|toolkit/i],
  ["ci-cd", /ci\/cd|github action|\bci\b/i],
  ["browser-automation", /browser|chrome|playwright|selenium|webdriver/i],
  ["test-management", /test case management|tcms/i],
  ["monitoring", /monitor|alert/i],
];

export function deriveCapabilities(name: string, description: string, category: string): string[] {
  const haystack = `${name} ${description} ${category}`;
  const tags: string[] = [];
  for (const [tag, re] of CAPABILITY_PATTERNS) if (re.test(haystack)) tags.push(tag);
  return tags;
}

/** Deterministic paid heuristic (test-pinned at exactly 2 hits on the fixture). */
export function credentialRequirementFor(name: string, description: string): CredentialRequirement {
  const hay = `${name} ${description}`;
  if (/formerly lambdatest/i.test(hay)) return "paid";
  if (/\bpricing\b|\bpremium\b|commercial license|\bpaid\b/i.test(hay)) return "paid";
  return "none";
}

/** targetKind merge precedence when one URL is discovered in two shapes. */
const KIND_PRECEDENCE: Partial<Record<TargetKind, number>> = { awesome_list: 3, git_repo: 2 };
function mergeKind(a: TargetKind, b: TargetKind): TargetKind {
  return (KIND_PRECEDENCE[b] ?? 1) > (KIND_PRECEDENCE[a] ?? 1) ? b : a;
}

/**
 * Parse the pinned README into depth-1 CatalogEntry skeletons (deduped by
 * canonical identity, one entry + N provenance edges per repeated link).
 * repository/license/validation fields are enriched later by resolve().
 */
export function parseFirstLevel(
  readmeMarkdown: string,
  pinnedCommit: string = AWESOME_TESTING_COMMIT,
): CatalogEntry[] {
  const links = extractResourceLinks(readmeMarkdown);
  const byKey = new Map<string, CatalogEntry>();
  const entryKeyOf = (cls: ClassifiedLink, link: ParsedLink): string =>
    cls.cloneTarget && cls.repo
      ? `repo:${cls.repo.owner.toLowerCase()}/${cls.repo.name.toLowerCase()}`
      : `url:${canonicalizeUrl(link.url)}`;

  for (const link of links) {
    const cls = classifyLink(link);
    const key = entryKeyOf(cls, link);
    const edge: ProvenanceEdge = {
      sourceCatalogId: AWESOME_TESTING_CATALOG_ID,
      depth: 1,
      catalogCommit: pinnedCommit,
      urlAsLinked: link.url,
      discoveredAt: AWESOME_TESTING_COMMIT_TIME,
    };
    const existing = byKey.get(key);
    if (existing) {
      for (const c of cls.categories) if (!existing.categories.includes(c)) existing.categories.push(c);
      if (link.description && !existing.description) existing.description = link.description;
      existing.targetKind = mergeKind(existing.targetKind, cls.targetKind);
      existing.provenance.push(edge);
      continue;
    }
    const id = entryIdFor(link, cls);
    byKey.set(key, {
      id,
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
        at: AWESOME_TESTING_COMMIT_TIME,
        method: "manual",
        notes: "parsed from pinned README; provider check pending",
      },
      redirectHistory: [],
      adoptionTier: adoptionTierForRepo(cls.repo?.name ?? link.name),
      executionPolicy: executionPolicyForLicense({ spdx: null, kind: "unknown" }),
      resolutionStatus: "unresolved",
    });
  }

  // Guarantee id-uniqueness even for exotic name collisions.
  const used = new Set<string>();
  for (const entry of byKey.values()) {
    let id = entry.id;
    let n = 2;
    while (used.has(id)) id = `${entry.id}-${n++}`;
    entry.id = id;
    used.add(id);
  }
  return [...byKey.values()];
}
