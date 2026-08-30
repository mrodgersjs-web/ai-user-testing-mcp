# sandboxed-execution

## ADDED Requirements

### Requirement: Reviewed adapters are the only execution path
Agents MAY read every cataloged source; only adapters with status `reviewed` and an
`allowlisted`/`sandbox_required` policy MAY execute. Execution always uses an ephemeral
home directory and temporary worktree, read-only application source unless a repair task
grants bounded write access, allowlisted argv prefixes, declared network destinations,
and CPU/memory/wall-clock/output limits.

#### Scenario: Unallowlisted command refused before spawn
```gherkin
Given an adapter whose commandAllowlist does not prefix-match the requested argv
When the sandbox attempts execution
Then the run is refused with state blocked and a named preflight failure
And no process is spawned
```

#### Scenario: Forbidden side effects denied
```gherkin
Given a sandboxed run
When the run attempts writes outside its worktree, undeclared network destinations,
secret access, or resource exhaustion
Then each attempt is denied and recorded as evidence
And the run ends in failed or blocked, never passed
```

### Requirement: Fail-closed preflight
Dependency, credential, target, and cost preflight MUST fail closed: missing credential,
unresolvable target, over-budget estimate, or unavailable dependency yields blocked/not_evaluated.

#### Scenario: Missing credential
```gherkin
Given a paid adapter whose credential is absent from the provider store
When suite.run targets it
Then preflight returns blocked with reason credential_missing
And no provider call is made
```

### Requirement: Paid-run budget ceilings
Paid-provider runs MUST be constrained by provider, project, suite, maximum scenarios,
and maximum estimated credits; exceeding any ceiling stops the suite deterministically.

#### Scenario: Credit ceiling hit mid-suite
```gherkin
Given a suite of 20 scenarios on a paid adapter with maxEstimatedCredits reached at scenario 12
When the run proceeds
Then scenarios 13-20 are recorded not_evaluated
And the manifest records consumed <= ceiling
```

### Requirement: Honest terminal states
Run states are queued, running, passed, failed, blocked, not_evaluated, cancelled.
Blocked, unavailable, or not-evaluated MUST NOT be reported as passed anywhere in CLI,
MCP, reports, or ProofPackets.

#### Scenario: Blocked never renders as pass
```gherkin
Given a run in state blocked
When evidence.report or run.wait renders it
Then the displayed status is blocked with failureDetail
And any aggregate summary counts it outside passed
```

### Requirement: Redaction precedes persistence
Secrets and PII are redacted before artifacts persist; every persisted artifact gets a
receipt with sha256 and redacted=true.

#### Scenario: Token in captured log
```gherkin
Given a captured console trace contains a provider API token pattern
When the artifact is persisted
Then the stored file has the token replaced by a redaction marker
And ArtifactReceipt.redacted is true
```
