# ai-user-testing-mcp

A governed AI user-testing monorepo: a catalog of reviewable resources pinned
to exact commits, reviewed adapters, a sandboxed runner, and evidence sealed as
a ProofPacket. pnpm workspace, TypeScript throughout.

## Layout

- `catalog.lock.json` - the pinned catalog (1,849 resources, exact commits).
- `adapters/` - reviewed adapters; `agents/`, `skills/`, `sources/` - inputs.
- `apps/`, `packages/` - runnable surfaces and shared libraries.
- `tests/` + `vitest.config.ts` - the test suite; `schemas/` - wire contracts.
- `.github/workflows/ci.yml` - build, tests, catalog verify, gitleaks, gitlink audit.

## Setup and test (exact commands)

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Rules

- A catalog entry without an exact commit is a bug: verify runs `catalog verify`.
- Adapters are reviewed code, not generated filler; new ones need tests.
- Evidence is ProofPacket-shaped: anything a run claims must be re-verifiable.
