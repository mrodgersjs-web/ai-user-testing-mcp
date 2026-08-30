/**
 * Frozen nested-catalog set for the governed catalog.
 *
 * Selection rule: testing-domain curated lists linked from the pinned
 * Awesome Testing commit ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93.
 *
 * The set is EMPIRICALLY FROZEN (measured via `gh api` at current HEADs,
 * 2026-08-30; per-repo main-readme link counts noted). Commits are pinned
 * per-sync at resolve time, never hardcoded here.
 *
 * Excluded by the rule:
 *  - sindresorhus/awesome                      — meta "awesome of awesomes", not testing-domain
 *  - kdeldycke/awesome-falsehood               — data/encoding list, not a testing tools list
 *  - jagracey/Awesome-Unicode                  — encoding list (still a first-level catalog entry)
 *  - minimaxir/big-list-of-naughty-strings     — data list (stays cataloged as a first-level entry)
 *  - karlhorky/learn-to-program                — developer training, not testing-domain
 *  - fityanos/Quality-Assurance-Road-Map       — roadmap (5 links), not a curated tools list
 *
 * NOTE: ligurio/awesome-software-quality is README-index-only (2 links in README; the real
 * link corpus lives across the markdown tree). Link extraction therefore parses ALL *.md
 * files at the pinned commit (README first) for every nested catalog — see resolve.ts.
 */
export interface NestedCatalogConfig {
  owner: string;
  repo: string;
  path: "README.md";
  /** Stable id: `${owner}--${repo}` lowercased (matches ProvenanceEdge sourceCatalogId pattern). */
  id: string;
}

const cfg = (owner: string, repo: string): NestedCatalogConfig => ({
  owner,
  repo,
  path: "README.md",
  id: `${owner}--${repo}`.toLowerCase(),
});

export const NESTED_CATALOG_REPOS: readonly NestedCatalogConfig[] = [
  cfg("ChristoWolf", "awesome-testing-blogs"), // 36 links
  cfg("paragonie", "awesome-appsec"), // 112
  cfg("christian-bromann", "awesome-selenium"), // 100
  cfg("sbilly", "awesome-security"), // 333
  cfg("ligurio", "awesome-software-quality"), // README index-only (2); tree-wide *.md expansion owns the rest
  cfg("tugkanboz", "awesome-ai-testing"), // 171
  cfg("virajkulkarni14", "awesome-cucumber"), // 27
  cfg("aliesbelik", "awesome-jmeter"), // 235
  cfg("be-next", "awesome-performance-engineering"), // 204
  cfg("abhivaikar", "howtheytest"), // 792
  cfg("MathiasPaulenko", "awesome-behave"), // 83
];
