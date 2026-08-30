# source-pinning

## ADDED Requirements

### Requirement: Exact-SHA submodule pins
Every resolvable repository SHALL be pinned as a submodule at `sources/{depth}/{category}/{owner}--{repo}`
on an exact commit SHA; the SHA in `.gitmodules`+tree and `catalog.lock.json` MUST be identical.
Org/user/issue/file/discussion URLs are metadata and MUST NOT become clone targets.

#### Scenario: Lock and gitlink agree
```gherkin
Given catalog.lock.json pins are regenerated
When the audit compares each SourcePin.commitSha against git ls-tree for its submodule path
Then every pair is identical
And no repository working-tree content is committed in the superproject
```

### Requirement: Controlled hydration
Hydration SHALL support one source, one category, or all; default to eight parallel jobs
at depth one; be resumable; and preflight disk space before starting. Hydrating all
sources requires explicit confirmation after an estimated disk/time report.

#### Scenario: Interrupted run resumes
```gherkin
Given hydration of category security-testing was interrupted after partial completion
When hydration is re-run for that category
Then already-pinned and already-hydrated sources are skipped without refetching
And the operation completes without corrupting any pin state
```

#### Scenario: Disk preflight fails closed
```gherkin
Given estimated hydration size exceeds available disk headroom
When source hydrate --all is requested without --force-after-estimate
Then the command refuses and reports the estimate
And no partial write occurs
```
