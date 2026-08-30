---
name: ai-user-testing
description: Run governed AI user-testing for web, iOS, API, data, AI, vision, accessibility, security, and longitudinal scenarios using rig-testlab — a provenanced catalog of vetted testing tools executed only in a fail-closed sandbox. Use for planning representative user journeys, selecting reviewed adapters, compiling executable suites, running them with evidence receipts, and sealing proof packets. NOT for executing arbitrary repository scripts, unreviewed tools, or unbounded paid-provider runs.
metadata:
  version: "1.0.0"
  repo: "mrodgersjs-web/ai-user-testing-mcp"
  compatibility_alias: "testsprite-engineering -> this skill; TestSprite stays a core reviewed adapter"
---

# AI User Testing (rig-testlab)

You are operating the governed testing surface. Three planes, never mixed:
- **Know** what exists → the catalog (`catalog.lock.json`, provenance-pinned).
- **Prove** it works → sandboxed execution with evidence receipts.
- **Repeat** safely on a real project → compiled suites with budgets.

## Hard rules (never violate)

1. Only `reviewed` adapters execute. Cataloged ≠ runnable: reference-only sources are never executed, and arbitrary repository scripts are never run.
2. Every run produces evidence receipts (hashes + redaction flags). `blocked`, `not_evaluated`, `cancelled` are reported as-is — never as passed.
3. Paid providers (TestSprite, TestMu/SmartUI) run only under a declared scenario/credit budget; the runner refuses over-budget without provider calls. Credentials come from the existing keychain/provider store, never the repo.
4. Native iOS proof requires a device/simulator adapter (Appium/XCUITest); TestSprite web evidence never stands in for native gestures, permissions, HealthKit, or native accessibility.
5. No public exposure of third-party material: cite sources, never copy paywalled content.

## Workflow

### 1. Ground in the catalog
```
rig-testlab catalog sync --refresh     # refresh upstream metadata (rate-limit aware)
rig-testlab catalog search "accessibility"
rig-testlab catalog show <id>          # status, provenance, license, execution policy
rig-testlab source status              # pin/hydration states; source hydrate [--all] only when needed (disk estimate + confirmation)
```
Prefer tools whose `executionPolicy` is `allowlisted`/`sandbox_required` with `adoptionTier` core/approved.

### 2. Compile the suite
Author or reuse `projects/<app>/project.yaml` (pointer-only: repo, revision, suite locations) plus scenario specs (persona, steps, expectations, required evidence kinds). Then:
```
rig-testlab suite compile projects/transformfit/project.yaml --out out/suite.json
```
Compile refusals are informative: `unknown_adapter`, `adapter_not_reviewed`, `budget_required`, scenario-cap `not_evaluated`.

### 3. Run with evidence
```
rig-testlab suite run out/suite.json --scenario <id> --budget-scenarios 3 --budget-credits 5
rig-testlab run wait <runId>
rig-testlab evidence verify --run <runId>
rig-testlab evidence report --runs out/runs.json > report.md
```
Each run gets an ephemeral HOME and read-only worktree snapshot, argv-prefix allowlisted commands, declared network only, and CPU/memory/wall/output caps.

### 4. Seal proof
```
rig-testlab doctor            # environment, adapter health, credential presence (by name)
rig-testlab install-global --check   # six-harness install drift; apply only on explicit operator command
```
Release-level claims require a ProofPacket sealed by an independent verifier identity (see schemas/ProofPacket.v1.schema.json): commit hash, catalog hash, pin hash, test results, install receipts, remote `main == HEAD`, private-verified.

## MCP surface
The same capabilities are exposed as an MCP server (`rig-testlab-mcp`, stdio): tools `catalog.search/get`, `source.hydrate/read`, `runner.select`, `adapter.health`, `suite.compile/run`, `run.wait`, `evidence.verify`; resources `testing://catalog/{id}`, `testing://capabilities/{tag}`, `testing://source/{id}/manifest`, `testing://suite/{id}`, `testing://run/{id}`.

## Adapter map (reviewed core)
Web: Cypress (+cypress-axe, WAVE, Vertaa11y). iOS: Appium/XCUITest + iOS Simulator. AI/web-API testing: TestSprite (core, paid), TestMu/SmartUI (optional). AI contracts: promptfoo + Tenro/AgentSkeptic. API: Bruno/OpenAPI. Security: OWASP ZAP + Nuclei. Data: DATAMIMIC, boundary/malformed fixtures. Mocks: MockServer/WireMock/Keploy. Evidence: rrweb, traces, screenshots, reports. See `adapters/*/adapter.json` for exact bounds.
