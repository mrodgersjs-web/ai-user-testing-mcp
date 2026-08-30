# agent-distribution

## ADDED Requirements

### Requirement: Canonical package set
The monorepo is canonical for the `ai-user-testing` skill, the `ai-user-testing-engineer`
implementation agent, the `ai-user-testing-verifier` independent verification agent, and a
managed MCP server named `ai-user-testing`.

### Requirement: Atomic six-harness installer
Installation into Codex, Claude, Hermes, OMP, Orca, and Prime locations is atomic, with
dry-run, check, backup, conflict detection, idempotent reinstall, uninstall, and rollback.

#### Scenario: Idempotent reinstall
```gherkin
Given a harness home where the package is already installed identically
When installer apply runs again
Then it reports no-change per managed path
And no duplicate entries appear in any configuration file
```

#### Scenario: Conflict preserved
```gherkin
Given a target path holding a user-authored file that differs from the managed payload
When installer apply runs
Then it refuses that path, reports a conflict, and leaves the user file byte-identical
And the rest of the install still completes or the whole run rolls back per policy
```

#### Scenario: Rollback restores prior state
```gherkin
Given an install completed into a temporary home
When installer rollback runs with the backup manifest
Then every managed path matches its pre-install state
```

### Requirement: TestSprite compatibility migration
Existing `testsprite-engineering` names become compatibility aliases pointing to the new
canonical package; credentials stay in the existing keychain/provider store and never
enter Git, reports, prompts, logs, or ProofPackets.

#### Scenario: Alias resolves to canonical
```gherkin
Given a harness referencing testsprite-engineering
When the installer migrates it
Then the reference resolves to ai-user-testing and the old skill file is a pointer,
not a divergent copy
```
