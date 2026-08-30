import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AWESOME_TESTING_COMMIT,
  canonicalizeUrl,
  classifyLink,
  extractResourceLinks,
  parseFirstLevel,
  slugId,
  type ParsedLink,
} from "./parse.js";
import type { CatalogEntry } from "./types.js";

const FIXTURE = join(import.meta.dirname, "..", "testdata", "awt-README-ff695aa.md");
const md = readFileSync(FIXTURE, "utf8");

function host(u: string): string {
  return /^https?:\/\/([^/?#]+)/i.exec(u)?.[1]?.toLowerCase() ?? "";
}
function byId(entries: CatalogEntry[], id: string): CatalogEntry {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error(`missing entry ${id}`);
  return e;
}

describe("census (ground truth vs pinned README ff695aa)", () => {
  const entries = parseFirstLevel(md, AWESOME_TESTING_COMMIT);

  it("matches the pinned counts exactly", () => {
    const cloneTargets = entries.filter(
      (e) => e.targetKind === "git_repo" || e.targetKind === "awesome_list",
    );
    const orgs = entries.filter((e) => e.targetKind === "github_org");
    const nonGithub = entries.filter((e) => host(e.canonicalUrl) !== "github.com");
    expect(entries.length).toBe(162); // 165 bullets − 3 URL-duplicates
    expect(cloneTargets.length).toBe(73);
    expect(orgs.length).toBe(1);
    expect(nonGithub.length).toBe(88);
    expect(cloneTargets.length + orgs.length + nonGithub.length).toBe(entries.length);
  });

  it("keeps the three double-linked resources as one entry + two provenance edges", () => {
    for (const id of ["karlhorky--learn-to-program"]) {
      const e = byId(entries, id);
      expect(e.provenance.length).toBe(2);
    }
    const polarity = entries.filter((e) => e.canonicalUrl === "https://www.polarity.so/");
    expect(polarity.length).toBe(1);
    expect(polarity[0]!.provenance.length).toBe(2);
    expect(polarity[0]!.categories).toEqual(["API Testing", "UI & End-to-End Testing"]);
    const chaos = entries.filter(
      (e) => e.canonicalUrl === "https://www.manning.com/books/chaos-engineering",
    );
    expect(chaos.length).toBe(1);
    expect(chaos[0]!.provenance.length).toBe(2);
  });

  it("classifies Suggested Awesome Lists as awesome_list (16 unique) with repo ids", () => {
    const lists = entries.filter((e) => e.targetKind === "awesome_list");
    expect(lists.length).toBe(16);
    expect(byId(entries, "minimaxir--big-list-of-naughty-strings").targetKind).toBe("awesome_list");
    expect(byId(entries, "abhivaikar--howtheytest").targetKind).toBe("awesome_list");
    // learn-to-program: git_repo in Training, awesome_list in Useful References → merged to awesome_list
    expect(byId(entries, "karlhorky--learn-to-program").targetKind).toBe("awesome_list");
    expect(byId(entries, "christowolf--awesome-testing-blogs").targetKind).toBe("awesome_list");
    // #readme fragment does not break the repo shape
    expect(byId(entries, "mathiaspaulenko--awesome-behave").targetKind).toBe("awesome_list");
  });

  it("defaults tiers/policies honestly at parse time", () => {
    const promptfoo = byId(entries, "promptfoo--promptfoo");
    expect(promptfoo.adoptionTier).toBe("approved_adapter"); // reviewed set
    expect(promptfoo.executionPolicy).toBe("reference_only"); // license unknown until resolve
    // BeEF is a watchlist candidate, never auto-quarantined
    expect(byId(entries, "beef-beefproject-com").adoptionTier).toBe("watchlist");
    expect(byId(entries, "usebruno--bruno").adoptionTier).toBe("approved_adapter");
  });
  it("pinned paid heuristic: exactly the two 'formerly LambdaTest' entries", () => {
    const paid = entries.filter((e) => e.credentialRequirement === "paid");
    expect(paid.length).toBe(2);
    expect(paid.every((e) => /formerly lambdatest/i.test(e.name))).toBe(true);
  });

  it("skips Contents/badges/anchors and the malformed funapi bullet", () => {
    expect(entries.some((e) => e.canonicalUrl.startsWith("#"))).toBe(false);
    expect(entries.some((e) => host(e.canonicalUrl) === "cdn.rawgit.com")).toBe(false);
    expect(entries.some((e) => e.canonicalUrl.includes("funapi.dev"))).toBe(false);
    expect(entries.some((e) => e.categories.includes("Foreword"))).toBe(false);
    // Contents anchor bullets are the only links in that section
    expect(extractResourceLinks(md).some((l) => l.section === "Contents")).toBe(false);
  });
});

describe("classification rules", () => {
  const link = (url: string, over: Partial<ParsedLink> = {}): ParsedLink => ({
    name: "X",
    url,
    description: "",
    section: "Software",
    subsection: "API Testing",
    ...over,
  });

  it("issue/blob/tree paths are metadata-only, never clone targets", () => {
    for (const url of [
      "https://github.com/o/r/issues/42",
      "https://github.com/o/r/blob/main/README.md",
      "https://github.com/o/r/discussions/7",
      "https://github.com/o/r/releases/tag/v1",
    ]) {
      const cls = classifyLink(link(url));
      expect(cls.cloneTarget, url).toBe(false);
      expect(cls.targetKind, url).toBe("other");
    }
  });

  it("org pages are github_org; category = subsection when present", () => {
    expect(classifyLink(link("https://github.com/OctoMind-dev")).targetKind).toBe("github_org");
    expect(classifyLink(link("https://github.com/a/b")).categories).toEqual(["API Testing"]);
  });

  it("section fallbacks: book/training/blog/newsletter/website", () => {
    expect(classifyLink(link("https://amzn.to/x", { section: "Books" })).targetKind).toBe("book");
    expect(
      classifyLink(
        link("https://dojo.example", { section: "Training (Includes developer training for automation testers)" }),
      ).targetKind,
    ).toBe("training");
    expect(classifyLink(link("https://blog.example", { section: "Blogs" })).targetKind).toBe("blog");
    expect(classifyLink(link("https://news.example", { section: "Newsletters" })).targetKind).toBe("newsletter");
    expect(classifyLink(link("https://saas.example")).targetKind).toBe("website");
  });
});

describe("fixture spot checks", () => {
  const entries = parseFirstLevel(md, AWESOME_TESTING_COMMIT);

  it("Octomind is the single github_org page", () => {
    const octo = byId(entries, "octomind-github-com");
    expect(octo.targetKind).toBe("github_org");
    expect(octo.repository).toBeUndefined();
    expect(octo.canonicalUrl).toBe("https://github.com/OctoMind-dev");
  });

  it("ids are lowercased owner--repo and stable", () => {
    expect(byId(entries, "nikita-filonov--tests-coverage-tool").name).toBe("Tests Coverage Tool");
    expect(byId(entries, "usebruno--bruno").categories).toEqual(["API Testing"]);
    expect(slugId("James Bach-github com")).toBe("james-bach-github-com");
  });

  it("provenance uses the pinned commit and its author date", () => {
    const e = byId(entries, "usebruno--bruno");
    expect(e.provenance[0]).toMatchObject({
      sourceCatalogId: "awesome-testing",
      depth: 1,
      catalogCommit: AWESOME_TESTING_COMMIT,
      urlAsLinked: "https://github.com/usebruno/bruno",
    });
  });

  it("parsing is deterministic", () => {
    expect(parseFirstLevel(md, AWESOME_TESTING_COMMIT)).toEqual(entries);
  });

  it("canonicalizeUrl lowercases host, drops fragments, normalizes root path", () => {
    expect(canonicalizeUrl("https://WWW.Example.com/Path/#frag")).toBe("https://www.example.com/Path");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
  });
});
