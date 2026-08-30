// Reviewed fixture for rrweb (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/rrweb`, { recursive: true });
writeFileSync(`artifacts/rrweb/sample-rrweb.txt`, "rrweb fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "rrweb fixture artifact\n");
console.error("FAIL rrweb: deterministic planted failure");
process.exit(1);
