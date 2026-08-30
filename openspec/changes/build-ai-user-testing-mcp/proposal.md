# Proposal: build-ai-user-testing-mcp

## Why
No governed surface exists for discovering, pinning, reading, or safely executing the
open-source testing-tool ecosystem. Codex, Claude, Hermes, OMP, Orca, and Prime need one
shared catalog + sandbox + evidence plane so AI user-testing is repeatable, private,
and provable — not an ad-hoc pile of cloned repos.

## What Changes
- Establish `catalog.lock.json` as the committed source of truth for every resource in
  TheJambo/awesome-testing @ `ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93` plus exactly one
  level of its referenced testing catalogs (~2,800 links).
- Pin every resolvable repository as an exact-SHA git submodule under `sources/`;
  websites, books, training, SaaS, and unresolved links stay metadata records.
- Ship versioned schemas (CatalogEntry, ProvenanceEdge, SourcePin, AdapterDescriptor,
  ScenarioSpec, RunManifest, ArtifactReceipt, ProofPacket + CatalogLock envelope).
- Build a sandboxed adapter runtime (ephemeral home/worktree, allowlists, hard limits,
  fail-closed preflight, redaction) with a reviewed adapter set.
- Expose the whole system through the `rig-testlab` CLI, a stdio MCP server, and an
  atomic six-harness agent installer; migrate `testsprite-engineering` behind aliases.
- Connect TransformFit via a pointer-only project manifest; compile and run its suites
  through this system without duplicating its application source.
- Gate release on a signed ProofPacket; weekly refresh PRs are never auto-merged.

## Capabilities
- **New capabilities**: `catalog-governance`, `source-pinning`, `sandboxed-execution`,
  `mcp-interface`, `cli-interface`, `agent-distribution`, `transformfit-connection`,
  `release-integrity`.
- **Modified capabilities**: none (greenfield).

## Impact
- New private repo `mrodgersjs-web/ai-user-testing-mcp` (registered in the workstation
  repository registry; placement check ALLOW).
- `testsprite-engineering` packages in Codex/Claude/Hermes skill roots become aliases.
- Existing TestSprite/TestMu credentials stay in the current keychain/provider store.

## Non-goals
- Vendoring upstream code into Git history; recursive catalog expansion;
  arbitrary third-party execution; public release; credential migration;
  paywalled-content copying; automatic upstream merges.
