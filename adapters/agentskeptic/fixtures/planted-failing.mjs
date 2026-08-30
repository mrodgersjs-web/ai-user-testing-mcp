// Reviewed fixture for agentskeptic (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/model_transcript`, { recursive: true });
writeFileSync(`artifacts/model_transcript/sample-model_transcript.txt`, "agentskeptic fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "agentskeptic fixture artifact\n");
console.error("FAIL agentskeptic: deterministic planted failure");
process.exit(1);
