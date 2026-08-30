# ai-user-testing-mcp (private)

Governed AI user-testing monorepo. Catalogs every resource in
[Awesome Testing](https://github.com/TheJambo/awesome-testing) at pinned commit
`ff695aac1126d548eb3bc0ceb3d8a0d4e0b9cf93`, plus exactly one level of its referenced
testing catalogs. Resolvable Git repositories are exact-commit submodule pins under
`sources/`; everything else is a metadata record. Nothing floats against a branch.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/mcp-server` | MCP server (stdio) exposing catalog/source/runner/evidence tools |
| `packages/catalog` | `catalog.lock.json` models, resolver, provenance, SQLite FTS index |
| `packages/cli` | `rig-testlab` CLI |
| `packages/scenario-compiler` | `ScenarioSpec` → `RunManifest` compilation |
| `packages/evidence` | artifact receipts, redaction, ProofPacket seal/verify |
| `packages/agent-installer` | atomic skill/agent/MCP install for six harnesses |
| `adapters/` | reviewed executable adapters (only these may run code) |
| `agents/`, `skills/` | canonical agent profiles and the `ai-user-testing` skill |
| `projects/transformfit` | pointer-only project manifest (source stays in TransformFit repo) |
| `sources/direct`, `sources/nested` | submodule pins: `{depth}/{category}/{owner}--{repo}` |
| `schemas/` | versioned JSON Schemas (CatalogEntry … ProofPacket, v1) |
| `openspec/` | BDD specs, build change, done-contract |

## Governance invariants

- `catalog.lock.json` is the committed source of truth; the FTS index is generated, never committed.
- Every discovered resource is represented — including dead, blocked, redirected,
  rate-limited, unresolved, and quarantined entries. Nothing is silently dropped.
- Cataloged ≠ executable. Only reviewed adapters execute, inside an ephemeral sandbox
  with allowlisted commands, declared network, and hard CPU/memory/duration/output limits.
- Missing-license and restrictive-license projects are readable references only.
- A blocked, unavailable, or not-evaluated run can never be reported as passed.
- API keys never enter Git, reports, prompts, logs, or ProofPackets.

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm --filter @rig-testlab/cli dev -- doctor
```
