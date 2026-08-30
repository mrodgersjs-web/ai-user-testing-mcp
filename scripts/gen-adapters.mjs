#!/usr/bin/env node
/**
 * Materialize the reviewed adapter set under adapters/. Deterministic and
 * idempotent: rerunning rewrites identical bytes. Adapter descriptors are the
 * ONLY execution lane into third-party tooling; fixtures are stdlib-only node
 * scripts that emulate the tool so the sandbox contract is testable without
 * the real binary. `["node"]` allowlist rows are the fixture lane — the
 * sandbox (no shell, caps, declared network, ephemeral home) is what isolates.
 *
 * sourceEntryId anchors: real catalog.lock.json entry ids where the tool (or
 * its official site) is cataloged; `mission.core.*` markers where the mission
 * itself designates the tool a core adapter but awesome-testing links only
 * docs/omits it (cypress repo, axe-core, TestSprite); `rig-testlab.first-party.*`
 * for fixture packs authored in this repo. tests/adapters.test.ts asserts
 * every id resolves against lock ∪ the frozen marker set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIMITS = { maxCpuMs: 300_000, maxMemoryMb: 2048, maxWallClockS: 600, maxOutputBytes: 10_485_760 };

/** id, name, sourceEntryId, evidenceKinds, allowlist, network, credentialMode, paid, limitsOverride */
const ADAPTERS = [
  ["cypress", "Cypress (core web runner)", "mission.core.cypress", ["screenshot", "video", "log", "json_report"], [["npx", "cypress", "run"], ["npx", "cypress", "open"], ["node"]], [], "none", false],
  ["cypress-axe", "cypress-axe accessibility", "mission.core.cypress-axe", ["accessibility_tree", "json_report"], [["npx", "cypress", "run"], ["node"]], [], "none", false],
  ["watir", "Watir (Ruby web runner)", "watir-watir-github-io", ["screenshot", "log"], [["bundle", "exec", "rspec"], ["bundle", "exec", "cucumber"], ["node"]], [], "none", false],
  ["appium-xcuitest", "Appium XCUITest (iOS simulator)", "appium-appium-io", ["video", "screenshot", "log"], [["npx", "appium"], ["xcrun", "simctl"], ["node"]], ["127.0.0.1"], "none", false, { maxMemoryMb: 4096 }],
  ["testsprite", "TestSprite (paid web/API verifier)", "mission.core.testsprite", ["video", "console_network_trace", "json_report"], [["npx", "@testsprite/testsprite-cli"], ["testsprite-cli"], ["node"]], ["api.testsprite.com"], "keychain", true, { maxWallClockS: 900 }],
  ["testmu-smartui", "TestMu SmartUI (paid visual grid)", "smartui-by-testmu-ai-formerly-lambdatest--www-testmuai-com", ["screenshot", "json_report"], [["npx", "smartui"], ["node"]], ["api.testmuai.com"], "keychain", true],
  ["promptfoo", "promptfoo AI contracts", "promptfoo--promptfoo", ["model_transcript", "json_report"], [["npx", "promptfoo", "eval"], ["node"]], ["api.openai.com", "api.anthropic.com"], "env_store", false],
  ["tenro", "Tenro AI agent contracts", "tenro-ai--tenro-python", ["model_transcript", "json_report"], [["python", "-m", "tenro"], ["node"]], [], "none", false],
  ["agentskeptic", "AgentSkeptic adversarial evals", "jwekavanagh--agentskeptic", ["model_transcript", "json_report"], [["python", "-m", "agentskeptic"], ["node"]], [], "none", false],
  ["bruno-openapi", "Bruno OpenAPI contract runs", "usebruno--bruno", ["json_report", "log"], [["npx", "@usebruno/cli", "run"], ["node"]], ["127.0.0.1"], "none", false],
  ["owasp-zap", "OWASP ZAP baseline", "zaproxy--zaproxy", ["json_report", "log"], [["docker", "run", "ghcr.io/zaproxy/zaproxy"], ["zap-baseline.py"], ["node"]], ["127.0.0.1"], "none", false],
  ["nuclei", "Nuclei template scanner", "projectdiscovery--nuclei", ["json_report", "log"], [["nuclei", "-target"], ["node"]], ["127.0.0.1", "cloud.projectdiscovery.io"], "none", false],
  ["wave", "WAVE accessibility API", "wave-wave-webaim-org", ["accessibility_tree", "json_report"], [["npx", "wave-cli"], ["node"]], ["wave.webaim.org"], "env_store", false],
  ["vertaa11y", "VertaaUX accessibility CLI", "vertaaux--cli", ["accessibility_tree", "json_report"], [["npx", "@vertaaux/cli"], ["node"]], [], "none", false],
  ["datamimic", "DATAMIMIC data generation", "rapiddweller--datamimic", ["json_report", "log"], [["java", "-jar", "datamimic.jar"], ["node"]], [], "none", false],
  ["blns-boundary", "Big List of Naughty Strings boundary fixtures", "minimaxir--big-list-of-naughty-strings", ["json_report"], [["python", "-m", "blns"], ["node"]], [], "none", false],
  ["malformed-fixtures", "Malformed-JSON parser fixtures (first-party)", "rig-testlab.first-party.malformed-fixtures", ["json_report"], [["node"]], [], "none", false],
  ["mockserver", "MockServer HTTP mocks", "mock-server--mockserver", ["log", "json_report"], [["docker", "run", "mockserver/mockserver"], ["java", "-jar", "mockserver-netty.jar"], ["node"]], ["127.0.0.1"], "none", false],
  ["wiremock", "WireMock HTTP mocks", "wiremock--wiremock", ["log", "json_report"], [["java", "-jar", "wiremock"], ["docker", "run", "wiremock/wiremock"], ["node"]], ["127.0.0.1"], "none", false],
  ["keploy", "Keploy record/replay mocks", "keploy--keploy", ["json_report", "log"], [["keploy", "record"], ["keploy", "test"], ["node"]], ["127.0.0.1"], "none", false],
  ["robot-framework", "Robot Framework suites", "robot-framework-robotframework-org", ["log", "json_report", "screenshot"], [["python", "-m", "robot"], ["robot", "--outputdir"], ["node"]], ["127.0.0.1"], "none", false, { maxWallClockS: 900 }],
  ["bats-core", "Bats shell test runner", "bats-core--bats-core", ["log", "json_report"], [["bats", "test"], ["bats", "--tap"], ["node"]], [], "none", false],
  ["foundry-hardhat", "Foundry/Hardhat smart-contract tests", "foundry-rs--foundry", ["log", "json_report"], [["forge", "test"], ["npx", "hardhat", "test"], ["node"]], ["127.0.0.1"], "none", false],
  ["rrweb", "rrweb session evidence recorder", "rrweb-io--rrweb", ["rrweb", "json_report"], [["npx", "rrweb", "record"], ["node"]], [], "none", false],
];

const fixture = (id, kinds, mode) => {
  const writes = kinds
    .map((k) => {
      const ext = k === "screenshot" ? "png" : k === "video" ? "mp4" : "txt";
      return `mkdirSync(\`artifacts/${k}\`, { recursive: true });\nwriteFileSync(\`artifacts/${k}/sample-${k}.${ext}\`, ${JSON.stringify(`${id} fixture artifact\n`)});`;
    })
    .join("\n");
  const tail =
    mode === "passing"
      ? `console.log("PASS ${id}");`
      : mode === "failing"
        ? `console.error("FAIL ${id}: deterministic planted failure");\nprocess.exit(1);`
        : `console.error("dependency unavailable: ${id} toolchain not installed");\nprocess.exit(127);`;
  return `// Reviewed fixture for ${id} (${mode}) — stdlib-only emulation of the tool.\nimport { mkdirSync, writeFileSync } from "node:fs";\n${writes}\n${tail}\n`;
};

let written = 0;
for (const [id, name, sourceEntryId, evidenceKinds, commandAllowlist, networkAllowlist, credentialMode, paid, limitsOverride] of ADAPTERS) {
  const dir = join("adapters", id);
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  const descriptor = {
    id,
    name,
    adapterVersion: "1.0.0",
    sourceEntryId,
    status: "reviewed",
    commandAllowlist,
    networkAllowlist,
    limits: { ...LIMITS, ...(limitsOverride ?? {}) },
    credentialMode,
    paidProvider: paid,
    ...(paid ? { paidGuards: { maxScenarios: 5, maxEstimatedCredits: 10 } } : {}),
    fixtures: {
      passing: "fixtures/passing.mjs",
      plantedFailing: "fixtures/planted-failing.mjs",
      unavailableDependency: "fixtures/unavailable.mjs",
    },
    evidenceKinds,
  };
  writeFileSync(join(dir, "adapter.json"), JSON.stringify(descriptor, null, 2) + "\n");
  writeFileSync(join(dir, "fixtures", "passing.mjs"), fixture(id, evidenceKinds, "passing"));
  writeFileSync(join(dir, "fixtures", "planted-failing.mjs"), fixture(id, evidenceKinds, "failing"));
  writeFileSync(join(dir, "fixtures", "unavailable.mjs"), fixture(id, evidenceKinds, "unavailable"));
  written++;
}
console.log(`materialized ${written} adapters`);
