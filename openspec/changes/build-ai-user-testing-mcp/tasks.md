# Tasks — build-ai-user-testing-mcp (executable done-contract)

Every task lists its own completion test. A task is done only when its command's output
says so. Gates are non-vacuity: each ships with the planted failure that turns it RED.

## 1. Catalog resolution
- [ ] 1.1 Parse pinned README (`/tmp/awt-ff695aa/README.md`, sha256 recorded) into first-level entries.
  Done-test: `vitest run packages/catalog` — census test asserts baseline counts (162 first-level; 73 resolvable repos; 1 org page).
- [ ] 1.2 Fetch + parse the 11 pinned nested catalogs; record discovered-but-unexpanded catalogs.
  Done-test: nested-catalog unit tests with fixture READMEs + live sync writes `nestedCatalogs` with commits; `discoveredCatalogCount >= 0` and no depth-3 links exist.
- [ ] 1.3 GitHub-API resolution with provider-aware status, retry/backoff, dedup w/ multi-provenance, license + size + default branch + exact SHA.
  Done-test: `rig-testlab catalog verify` exits 0 on live lock; fixture test proves 429 ⇒ `rate_limited`, double-confirmed 404 ⇒ `dead`, org URL ⇒ metadata-only.
- [ ] 1.4 Emit `catalog.lock.json` conforming to `schemas/CatalogLock.v1`.
  Done-test: `rig-testlab catalog verify` validates every entry against the schema (ajv, strict).

## 2. Source pinning
- [ ] 2.1 `git submodule add` pins at `sources/{depth}/{category}/{owner}--{repo}` recorded identically in lock.
  Done-test: `catalog verify` compares lock SHA vs `git ls-tree` gitlink for every pin; planted wrong SHA ⇒ RED.
- [ ] 2.2 Hydration: per-source/category/all, 8 parallel default, depth 1, resumable, disk preflight, explicit all-sources confirmation.
  Done-test: interruption test (kill mid-run, rerun, verify skip/complete, no corruption); preflight refusal test with tiny fake headroom.
- [ ] 2.3 No vendored content in superproject.
  Done-test: audit walk finds no working-tree files under `sources/*`; CI secret/large-file/SBOM/license/submodule-provenance reports green.

## 3. Execution plane
- [ ] 3.1 Sandbox executor: ephemeral home+worktree, argv allowlist, declared network, CPU/mem/wall/output limits, fail-closed preflight.
  Done-test: suite attempts forbidden write/command/path/network/secret/exhaustion ⇒ each denied+recorded.
- [ ] 3.2 Reviewed adapters with passing/planted-failing/unavailable fixtures.
  Done-test: per adapter — fixture pass, planted failure forces deterministic RED, unavailable dependency ⇒ blocked.
- [ ] 3.3 Paid guards (TestSprite/TestMu): provider/project/suite/max-scenarios/max-credits ceilings; CI mocks.
  Done-test: ceiling-mid-suite test yields `not_evaluated` tail and consumed ≤ ceiling.
- [ ] 3.4 Redaction before persistence + ArtifactReceipt sha256.
  Done-test: token-in-log fixture stored redacted; receipt verifies; tampered file ⇒ verify FAILS.

## 4. Interfaces
- [ ] 4.1 MCP server: 10 tools, 6 resources, stdio, error envelopes, cancellation, traversal rejection.
  Done-test: MCP-client conformance suite (spawn via client SDK over stdio) green; planted traversal ⇒ invalid_input.
- [ ] 4.2 `rig-testlab` CLI: all commands + named error classes.
  Done-test: adversarial CLI matrix test (invalid id/redirect/429/timeout/no-disk/interrupted/unavailable tool/malformed lock).
- [ ] 4.3 Search p95 < 200 ms on full index; server starts with zero hydration.
  Done-test: benchmark test on generated index; startup-without-sources test.

## 5. Distribution
- [ ] 5.1 skill + engineer + verifier agent definitions in repo canonical form.
  Done-test: installer dry-run lists the package set for all six harnesses.
- [ ] 5.2 Atomic installer: dry-run/check/backup/conflict/idempotent/uninstall/rollback into temp HOMEs ×6.
  Done-test: `pnpm --filter @rig-testlab/agent-installer test` green incl. rollback byte-equality.
- [ ] 5.3 `testsprite-engineering` → canonical alias migration; credentials untouched.
  Done-test: alias file content = pointer; secret scan finds no key material anywhere in repo/reports/logs.

## 6. TransformFit
- [ ] 6.1 `projects/transformfit/project.yaml` pointer-only manifest.
  Done-test: manifest schema-valid; repo scan shows zero TransformFit application source here.
- [ ] 6.2 Compile + run representative scenarios per platform through `rig-testlab`.
  Done-test: run manifests + evidence receipts; summary math excludes blocked/not_evaluated from passed.

## 7. Release
- [ ] 7.1 Private repo created under mrodgersjs-web, CI + branch protection on main. (Gate-D)
  Done-test: `gh repo view` shows private; required checks + review enforcement green.
- [ ] 7.2 Pre-push audit green; push; `remote main == local HEAD`. (Gate-D)
  Done-test: equality check output recorded verbatim in ProofPacket.remoteVerification.
- [ ] 7.3 Weekly refresh workflow opens reviewed PRs only.
  Done-test: workflow dry-run test asserts PR-open call and absence of merge call.
- [ ] 7.4 Signed ProofPacket (independent sealedBy) binding every artifact hash above.
  Done-test: `rig-testlab evidence verify` on the packet ⇒ PASS; builder-sealed packet ⇒ REJECT.
