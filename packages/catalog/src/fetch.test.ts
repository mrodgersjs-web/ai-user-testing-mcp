import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubClient, licenseKindFromSpdx } from "./fetch.js";

interface Call {
  url: string;
  headers?: Record<string, string>;
}

interface ResponderOpts {
  token?: string;
  calls?: Call[];
  sleeps?: number[];
}

function responder(
  route: (url: URL, attempt: number) => { status: number; body: unknown },
  opts: ResponderOpts = {},
): { client: GitHubClient; calls: Call[]; sleeps: number[] } {
  const attempts = new Map<string, number>();
  const calls = opts.calls ?? [];
  const sleeps = opts.sleeps ?? [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const n = (attempts.get(url.pathname) ?? 0) + 1;
    attempts.set(url.pathname, n);
    calls.push({ url: url.pathname, headers: (init?.headers ?? {}) as Record<string, string> });
    const { status, body } = route(url, n);
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  const client = new GitHubClient({
    token: opts.token,
    fetchImpl,
    sleepMs: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

const okRepo = {
  owner: { login: "usebruno" },
  name: "bruno",
  default_branch: "main",
  size: 4242,
  license: { spdx_id: "MIT" },
  archived: false,
  fork: false,
  html_url: "https://github.com/usebruno/bruno",
};

describe("GitHubClient mapping", () => {
  it("maps repo payloads and sends the bearer token", async () => {
    const { client, calls } = responder(() => ({ status: 200, body: okRepo }), { token: "ghp_secret" });
    const info = await client.getRepo("usebruno", "bruno");
    expect(info).toMatchObject({
      owner: "usebruno",
      name: "bruno",
      defaultBranch: "main",
      sizeKb: 4242,
      license: { spdx: "MIT", kind: "permissive" },
    });
    expect(calls[0]!.headers!.Authorization).toBe("Bearer ghp_secret");
    expect(calls[0]!.headers!.Accept).toBe("application/vnd.github+json");
    expect(calls.length).toBe(1);
  });

  it("classifies licenses: missing / NOASSERTION / copyleft / restrictive", () => {
    expect(licenseKindFromSpdx(false, null)).toBe("missing");
    expect(licenseKindFromSpdx(true, null)).toBe("unknown");
    expect(licenseKindFromSpdx(true, "NOASSERTION")).toBe("unknown");
    expect(licenseKindFromSpdx(true, "AGPL-3.0")).toBe("copyleft");
    expect(licenseKindFromSpdx(true, "BUSL-1.1")).toBe("restrictive");
    expect(licenseKindFromSpdx(true, "MPL-2.0")).toBe("weak_permissive");
  });

  it("decodes base64 README content at an exact commit", async () => {
    const content = Buffer.from("# Hello\nline two").toString("base64");
    const withNewline = `${content.slice(0, 10)}\n${content.slice(10)}`; // GitHub wraps base64
    const { client } = responder((url) =>
      url.pathname.includes("contents")
        ? { status: 200, body: { content: withNewline, encoding: "base64" } }
        : { status: 404, body: {} },
    );
    const md = await client.getReadmeAt("o", "r", "a".repeat(40));
    expect(md).toBe("# Hello\nline two");
  });

  it("listTree keeps only blobs", async () => {
    const { client } = responder(() => ({
      status: 200,
      body: {
        tree: [
          { path: "README.md", type: "blob", sha: "1" },
          { path: "docs", type: "tree", sha: "2" },
          { path: "docs/guide.md", type: "blob", sha: "3" },
        ],
      },
    }));
    const entries = await client.listTree("o", "r", "b".repeat(40));
    expect(entries.map((e) => e.path)).toEqual(["README.md", "docs/guide.md"]);
  });
});

describe("provider-aware failure classes", () => {
  const errOf = async (fn: () => Promise<unknown>): Promise<GitHubApiError> => {
    try {
      await fn();
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubApiError);
      return e as GitHubApiError;
    }
    throw new Error("expected throw");
  };

  it("404 → not_found immediately, single call (no backoff)", async () => {
    const { client, calls, sleeps } = responder(() => ({ status: 404, body: { message: "Not Found" } }));
    const e = await errOf(() => client.getRepo("a", "b"));
    expect(e.errorClass).toBe("not_found");
    expect(calls.length).toBe(1);
    expect(sleeps.length).toBe(0);
  });

  it("403 → rate_limited after 5 tries with 1s-based exponential backoff", async () => {
    const { client, calls, sleeps } = responder(() => ({ status: 403, body: { message: "rate limited" } }));
    const e = await errOf(() => client.getRepo("a", "b"));
    expect(e.errorClass).toBe("rate_limited");
    expect(calls.length).toBe(5);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it("429 twice then 200 → success (transient throttling is survivable)", async () => {
    const { client, calls, sleeps } = responder((_u, n) =>
      n <= 2 ? { status: 429, body: {} } : { status: 200, body: okRepo },
    );
    const info = await client.getRepo("usebruno", "bruno");
    expect(info.name).toBe("bruno");
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("persistent 5xx → unresolved (never dead), capped attempts", async () => {
    const { client, calls } = responder(() => ({ status: 502, body: {} }));
    const e = await errOf(() => client.getRepo("a", "b"));
    expect(e.errorClass).toBe("unresolved");
    expect(calls.length).toBe(5);
  });

  it("DNS/timeout throw → unresolved with no retry storm", async () => {
    let n = 0;
    const client = new GitHubClient({
      fetchImpl: (async () => {
        n++;
        throw new TypeError("fetch failed: ENOTFOUND api.github.com");
      }) as unknown as typeof fetch,
      sleepMs: async () => {},
    });
    const e = await errOf(() => client.getRepo("a", "b"));
    expect(e.errorClass).toBe("unresolved");
    expect(n).toBe(1);
  });

  it("451 → blocked_by_provider; 499 → rate_limited", async () => {
    const blocked = responder(() => ({ status: 451, body: {} }));
    expect((await errOf(() => blocked.client.getRepo("a", "b"))).errorClass).toBe("blocked_by_provider");
    const gone = responder(() => ({ status: 499, body: {} }));
    expect((await errOf(() => gone.client.getRepo("a", "b"))).errorClass).toBe("rate_limited");
    expect(gone.calls.length).toBe(1);
  });
});
