# Design — build-ai-user-testing-mcp

## D1: Submodules, not vendoring
The catalog spans ~1,000+ unique repositories; copying them is multi-GB and violates the
control-repo size guidance. Each resolvable repo becomes a gitlink at an exact SHA under
`sources/{direct|nested}/{category}/{owner}--{repo}`. The superproject stays cloneable in
seconds; `pnpm`/MCP server startup NEVER requires hydrated sources — only the generated
index and lock. Hydration is opt-in per source/category/all with disk preflight.

Rejected: git subtree, vendored zips, mirror remote (no single authority), LFS (wrong tool
for read-only pins).

## D2: One nested level, explicit catalog set
Expansion is exactly the referenced-catalog links present in the pinned commit. Nested
catalogs are pinned by their own commit SHAs at sync time and recorded in
`nestedCatalogs`. Catalogs discovered *inside* nested catalogs bump
`discoveredCatalogCount` and stop. This keeps the closure finite and auditable against
the pinned baseline (162 first-level, ≈2,800 nested links).

## D3: Lock file + generated index split
`catalog.lock.json` (committed) carries entries, provenance, pins, statistics. A local
SQLite `node:sqlite` FTS5 index (gitignored, `.rig-testlab/index.db`) is rebuilt from the
lock deterministically; search p95 target 200 ms holds because rows are narrow
(name, description, categories, capabilities, id) and BM25-ranked. No server daemon.

## D4: Provider-aware resolution honesty
GitHub API (authenticated via `gh auth token`) classifies outcomes: 200→active; 301/302→
redirected with redirectHistory; 403/429→rate_limited (retry w/ backoff, never death);
DNS/timeout→unresolved; double-confirmed 404 or dead HTTP without redirect→dead;
org/user/issue/file/discussion URLs→metadata-only entries. `lastValidation` records
method + httpStatus + timestamp for every outcome. `HEAD` probes never justify `dead` alone.

## D5: Execution isolation
Node spawns into: ephemeral HOME dir + temp git worktree (read-only by default), argv
prefix allowlist check BEFORE spawn, network via declared-destination gate (fail closed;
implementation: sandboxed proxy env + OS-level restrictions where available, documented
limits otherwise), resource ceilings (cpu via wall-clock+poll, memory + output by
`ulimit`-style spawn constraints and pipe caps, kill on breach). Redaction pass over every
persisted artifact (secret regex + entropy scan) before ArtifactReceipt seal.
Blocked/not_evaluated/cancelled are non-passing terminal states enforced at the summary
aggregator — the place where dishonest reporting could creep in.

## D6: Determinism of completion
Every gate ships with a planted-failure regression (rig-adversarial-verification doctrine):
breaking the thing the gate guards must turn CI RED. Final verdict comes from deterministic
code (`evidence verify`), sealed by the verifier agent — builder identity ≠ sealedBy.

## D7: Six-harness install via staged copies
Installer writes into per-harness roots (Codex, Claude, Hermes, OMP, Orca, Prime), each
managed path recorded in a backup manifest written BEFORE any mutation; apply = copy +
config merge with conflict refusal; uninstall = reverse manifest; rollback = restore
manifest. Test-only targets are temp HOMEs — no live-harness writes without the explicit
`install-global` operator command.

## D8: Secrets architecture
Provider credentials resolve from the existing keychain/env-store at execution time only.
Schemas/JSON carry `credentialMode`, never values. Redaction + a `gitleaks`-class secret
scan in pre-push CI guard Git and artifacts.
