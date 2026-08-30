# mcp-interface

## ADDED Requirements

### Requirement: Stable tool and resource surface
The MCP server (SDK v2, stdio) exposes tools `catalog.search`, `catalog.get`,
`source.hydrate`, `source.read`, `runner.select`, `adapter.health`, `suite.compile`,
`suite.run`, `run.wait`, `evidence.verify` and resources `testing://catalog/index`,
`testing://catalog/{id}`, `testing://capabilities/{tag}`, `testing://source/{id}/manifest`,
`testing://suite/{id}`, `testing://run/{id}`.

#### Scenario: Discovery conformance
```gherkin
Given the server started via stdio with no hydrated sources
When a client lists tools and resources
Then all ten tools and the resource templates are present with valid schemas
And startup succeeded without cloning any source
```

### Requirement: Bounded, honest responses
Invalid input yields structured error envelopes (never a stack trace); path traversal in
`source.read` is rejected; `source.hydrate` respects the confirmation protocol;
`suite.run` returns a runId and completion is observed through `run.wait`.

#### Scenario: Traversal rejected
```gherkin
Given source.read is called with id "../../etc/passwd"
When the server resolves the manifest path
Then it returns an invalid_input error envelope
And no filesystem read occurs outside the sources tree
```

### Requirement: Search latency
Full-catalog search over the generated FTS index MUST answer below 200 ms at p95 locally.

#### Scenario: p95 under budget
```gherkin
Given the full generated index (baseline ≥ 2,800 unique links)
When 200 random queries execute
Then p95 latency is below 200 ms
```
