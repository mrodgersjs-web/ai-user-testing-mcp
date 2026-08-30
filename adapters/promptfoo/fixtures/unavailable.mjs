// Reviewed fixture for promptfoo (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/model_transcript`, { recursive: true });
writeFileSync(`artifacts/model_transcript/sample-model_transcript.txt`, "promptfoo fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "promptfoo fixture artifact\n");
console.error("dependency unavailable: promptfoo toolchain not installed");
process.exit(127);
