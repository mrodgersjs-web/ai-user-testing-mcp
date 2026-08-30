# transformfit-connection

## ADDED Requirements

### Requirement: Pointer-only project manifest
`projects/transformfit/project.yaml` contains the repository pointer, supported platforms,
suite locations, required adapters, and source revision. Application source and product
fixtures stay in the TransformFit repository; nothing is duplicated here. Reused
runner/evidence/scenario-schema/persona/vision-oracle/chaos contracts move into this monorepo.

#### Scenario: No duplicated application source
```gherkin
Given the monorepo tree
When it is scanned for TransformFit application code
Then only projects/transformfit/ pointer metadata and reusable contracts exist
```

### Requirement: Representative suite execution
TransformFit's workflow, vision, iOS, accessibility, security, AI, and three-month
simulation suites compile from the project manifest and execute representative scenarios
through `rig-testlab`.

#### Scenario: Compile then run representative scenarios
```gherkin
Given projects/transformfit/project.yaml pointing at the current TransformFit revision
When suite compile runs for each representative platform
And suite run executes one representative scenario per platform
Then every executed run ends in a terminal state with evidence receipts
And no run that was blocked or not_evaluated is summarized as passed
```
