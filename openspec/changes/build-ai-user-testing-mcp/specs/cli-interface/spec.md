# cli-interface

## ADDED Requirements

### Requirement: Command surface
`rig-testlab` provides: `doctor`, `catalog sync|verify|search|show`,
`source status|hydrate`, `adapter list|health|promote`, `suite compile|run`,
`run wait`, `evidence verify|report`, `install-global --check`.

```gherkin
Given a fresh clone without hydrated sources
When rig-testlab doctor runs
Then it reports lock presence/hash, index state, toolchain versions, adapter availability,
 credential presence (never values), and disk headroom
And exit code is zero only when every blocking check passes
```

### Requirement: Adversarial input hardening
Invalid IDs, redirects, GitHub rate limits, timeouts, insufficient disk, interrupted
hydration, unavailable tools, and malformed catalog data each yield a distinct named
error and honest exit codes.

#### Scenario: Malformed lock data fails closed
```gherkin
Given catalog.lock.json fails schema validation
When any catalog command runs
Then the command exits nonzero naming the first violating entry and JSON-pointer path
And no command proceeds on invalid data
```
