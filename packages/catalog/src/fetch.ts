/**
 * Provider-aware GitHub REST client (api.github.com).
 *
 * Error classes (never conflated):
 *   403 / 499            → rate_limited      (NEVER dead, NEVER dropped)
 *   429 after retries    → rate_limited
 *   404                  → not_found         (dead requires double-confirm upstream)
 *   451                  → blocked_by_provider
 *   DNS / timeout / 5xx  → unresolved
 * Exponential backoff (base 1s, max 5 attempts) ONLY on 403 / 429 / 5xx.
 */
import type { LicenseInfo, LicenseKind } from "./types.js";

export type GitHubErrorClass = "rate_limited" | "not_found" | "blocked_by_provider" | "unresolved";

export class GitHubApiError extends Error {
  constructor(
    readonly errorClass: GitHubErrorClass,
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep (ms). Tests pass a recorder. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Total attempts for backoff-eligible statuses. Default 5. */
  maxAttempts?: number;
  /** Per-request wall-clock cap. Default 15s. */
  timeoutMs?: number;
  baseUrl?: string;
}

export interface RepoInfo {
  owner: string;
  name: string;
  defaultBranch: string;
  sizeKb: number;
  license: LicenseInfo;
  archived: boolean;
  fork: boolean;
  htmlUrl: string;
}

export interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

const PERMISSIVE: Record<string, true> = {
  MIT: true, "BSD-2-Clause": true, "BSD-3-Clause": true, "Apache-2.0": true, ISC: true,
  Unlicense: true, "CC0-1.0": true, "0BSD": true, "Python-2.0": true, Zlib: true,
  WTFPL: true, PostgreSQL: true, Ruby: true, "MIT-0": true,
};
const WEAK_PERMISSIVE: Record<string, true> = {
  "MPL-2.0": true, "LGPL-2.1": true, "LGPL-2.1-only": true, "LGPL-3.0": true,
  "LGPL-3.0-only": true, "EPL-1.0": true, "EPL-2.0": true, "CDDL-1.0": true,
  "Artistic-2.0": true,
};
const COPYLEFT: Record<string, true> = {
  "GPL-2.0": true, "GPL-2.0-only": true, "GPL-3.0": true, "GPL-3.0-only": true,
  "AGPL-3.0": true, "AGPL-3.0-only": true, "EUPL-1.1": true, "EUPL-1.2": true,
  "GPL-3.0-or-later": true, "GPL-2.0-or-later": true,
};
const RESTRICTIVE: Record<string, true> = {
  "SSPL-1.1": true, "BUSL-1.1": true, "Elastic-2.0": true, "CPAL-1.0": true, "OSL-3.0": true,
};

export function licenseKindFromSpdx(hasLicenseObject: boolean, spdxId: string | null): LicenseKind {
  if (!hasLicenseObject) return "missing";
  if (spdxId === null || spdxId === "NOASSERTION") return "unknown";
  if (PERMISSIVE[spdxId]) return "permissive";
  if (WEAK_PERMISSIVE[spdxId]) return "weak_permissive";
  if (COPYLEFT[spdxId]) return "copyleft";
  if (RESTRICTIVE[spdxId]) return "restrictive";
  return "unknown";
}

const BACKOFF_STATUSES: Record<number, true> = { 403: true, 429: true, 500: true, 502: true, 503: true, 504: true };
const BASE_BACKOFF_MS = 1000;

interface Jsonish {
  [k: string]: unknown;
}

export class GitHubClient {
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(opts: {
    token?: string;
    fetchImpl?: typeof fetch;
    sleepMs?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    timeoutMs?: number;
    baseUrl?: string;
  } = {}) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepMs = opts.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
  }

  /** One GET with provider-aware classification + bounded backoff. */
  private async requestJson(path: string): Promise<Jsonish> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "rig-testlab-catalog",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let lastStatus = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (cause) {
        // DNS failure / connect timeout: unresolved immediately (no backoff set).
        throw new GitHubApiError("unresolved", `network failure: ${String(cause)}`, url);
      }
      lastStatus = res.status;
      if (res.ok) return (await res.json()) as Jsonish;
      if (res.status === 404) throw new GitHubApiError("not_found", `404 ${path}`, url, 404);
      if (res.status === 451)
        throw new GitHubApiError("blocked_by_provider", `451 legal block ${path}`, url, 451);
      if (res.status === 401)
        throw new GitHubApiError("unresolved", `401 auth failure ${path}`, url, 401);
      const backoffable = lastStatus in BACKOFF_STATUSES;
      if (backoffable && attempt < this.maxAttempts) {
        await this.sleepMs(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }
    if (lastStatus === 403 || lastStatus === 499 || lastStatus === 429) {
      throw new GitHubApiError("rate_limited", `${lastStatus} provider throttling ${path}`, url, lastStatus);
    }
    throw new GitHubApiError("unresolved", `unresolved ${lastStatus} ${path}`, url, lastStatus);
  }

  private static str(o: Jsonish, key: string): string {
    const v = o[key];
    if (typeof v !== "string") throw new GitHubApiError("unresolved", `missing field ${key}`, key);
    return v;
  }

  async getRepo(owner: string, name: string): Promise<RepoInfo> {
    const j = await this.requestJson(`/repos/${owner}/${name}`);
    const licObj = j.license as { spdx_id?: string | null } | null | undefined;
    const spdx = licObj?.spdx_id ?? null;
    return {
      owner: (j.owner as { login?: string } | undefined)?.login ?? owner,
      name: GitHubClient.str(j, "name"),
      defaultBranch: GitHubClient.str(j, "default_branch"),
      sizeKb: typeof j.size === "number" ? j.size : 0,
      license: { spdx: spdx ?? null, kind: licenseKindFromSpdx(licObj != null, spdx ?? null) },
      archived: j.archived === true,
      fork: j.fork === true,
      htmlUrl: GitHubClient.str(j, "html_url"),
    };
  }

  async getCommitSha(owner: string, name: string, branch: string): Promise<string> {
    const j = await this.requestJson(`/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`);
    return GitHubClient.str(j, "sha");
  }

  /** Decoded UTF-8 markdown of README.md at an exact commit. */
  async getReadmeAt(owner: string, name: string, commit: string): Promise<string> {
    return this.getFileAt(owner, name, commit, "README.md");
  }

  async getFileAt(owner: string, name: string, commit: string, path: string): Promise<string> {
    const j = await this.requestJson(
      `/repos/${owner}/${name}/contents/${path}?ref=${commit}`,
    );
    const content = j.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new GitHubApiError("unresolved", `empty contents payload for ${path}`, path);
    }
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  async listTree(owner: string, name: string, commit: string): Promise<TreeEntry[]> {
    const j = await this.requestJson(`/repos/${owner}/${name}/git/trees/${commit}?recursive=1`);
    const tree = Array.isArray(j.tree) ? (j.tree as Jsonish[]) : [];
    return tree
      .filter((t) => t.type === "blob" && typeof t.path === "string")
      .map((t) => ({ path: t.path as string, type: String(t.type), sha: String(t.sha ?? "") }));
  }
}
