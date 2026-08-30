# release-integrity

## ADDED Requirements

### Requirement: Pre-push audit
Before any push: verify the private repository target, exact origin, clean diff, secrets
scan, license report, SBOM, submodule provenance report, and absence of large files. Only
control-repository content (metadata, schemas, adapters, skills, agents, gitlinks) is pushed.

#### Scenario: Private target verified before first push
```gherkin
Given the remote is configured to mrodgersjs-web/ai-user-testing-mcp
When the pre-push audit runs
Then it confirms visibility == private and exact origin match
And any failure blocks the push
```

#### Scenario: No vendored sources in the superproject
```gherkin
Given gitlinks for all pinned sources
When the audit inspects the tree
Then no path under sources/*/ contains committed working-tree files
And no file exceeds GitHub large-file guidance
```

### Requirement: Publication equality
Publication is claimed only when remote `main` equals local HEAD.

#### Scenario: Equality check gates the claim
```gherkin
Given a completed push
When remoteVerification is assembled
Then remoteMain == localHead and privateVerified are both true in the ProofPacket
Otherwise publication is not claimed
```

### Requirement: Weekly refresh without auto-merge
A weekly workflow refreshes upstream commits/metadata, runs the full catalog audit, and
opens a reviewed PR describing added, removed, changed-license, redirected, and
quarantined sources. Merges are human-decided.

#### Scenario: Refresh opens a PR, never merges
```gherkin
Given the weekly workflow executes with an upstream change present
When it completes
Then exactly one PR exists with the delta summary
And no merge commit to main originated from the workflow
```

### Requirement: Signed ProofPacket completion
Completion requires a ProofPacket (schemas/ProofPacket.v1) binding repository commit,
catalog hash, source-pin hash, tests, agent installation receipts, TransformFit smoke
evidence, and private-remote verification; sealed by an independent verifier, never the builder.

#### Scenario: Verifier independence
```gherkin
Given a ProofPacket whose sealedBy equals the builder identity
When evidence.verify checks it
Then the packet is rejected
```
