# catalog-governance

## ADDED Requirements

### Requirement: Pinned-source completeness
The catalog SHALL represent every first-level resource of the pinned Awesome Testing
commit and every direct link of each pinned nested catalog, at exactly one nesting level.

#### Scenario: First-level census
```gherkin
Given catalog.lock.json generated from TheJambo/awesome-testing@ff695aa
When the audit counts first-level entries
Then the count equals the link count parsed from the pinned README (baseline 162)
And no parsed link is missing an entry
```

#### Scenario: Nested expansion stops at one level
```gherkin
Given a nested catalog page contains a link to another awesome-list
When the resolver processes it
Then that second catalog is recorded with discoveredCatalogCount incremented
And its links are NOT expanded
```

### Requirement: Nothing is silently dropped
Every discovered resource MUST have an entry, including dead, redirected, rate-limited,
blocked_by_provider, unresolved, and quarantined ones, each with validation evidence.

#### Scenario: Transient failure is not death
```gherkin
Given a repository fetch returns HTTP 429
When resolution records the outcome
Then resolutionStatus is rate_limited with lastValidation evidence
And resolutionStatus is NOT dead unless a confirmed second observation exists
```

### Requirement: Deduplication keeps provenance
A repository linked from several catalogs MUST produce exactly one entry and one pin,
with one ProvenanceEdge per origin carrying sourceCatalogId, depth, and catalogCommit.

#### Scenario: Same repo, two catalogs
```gherkin
Given big-list-of-naughty-strings is linked by the pinned README and by one nested catalog
When the lock is regenerated
Then there is exactly one CatalogEntry and one SourcePin for it
And provenance contains two edges with distinct sourceCatalogId values
```

### Requirement: License honesty
License resolution MUST record an SPDX result or explicit missing/unknown; missing and
restrictive licenses stay readable references and MUST NOT be executable, linkable into
builds, repackaged, or promoted without review.

#### Scenario: Missing license
```gherkin
Given a resolved repository with no detectable license
When policy assignment runs
Then license.kind is missing
And executionPolicy is reference_only
```
