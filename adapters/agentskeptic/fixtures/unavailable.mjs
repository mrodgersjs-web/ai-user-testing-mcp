// Reviewed fixture for agentskeptic (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/model_transcript`, { recursive: true });
writeFileSync(`artifacts/model_transcript/sample-model_transcript.txt`, "agentskeptic fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "agentskeptic fixture artifact\n");
console.error("dependency unavailable: agentskeptic toolchain not installed");
process.exit(127);
