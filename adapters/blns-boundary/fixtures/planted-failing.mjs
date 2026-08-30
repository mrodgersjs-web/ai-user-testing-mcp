// Reviewed fixture for blns-boundary (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "blns-boundary fixture artifact\n");
console.error("FAIL blns-boundary: deterministic planted failure");
process.exit(1);
