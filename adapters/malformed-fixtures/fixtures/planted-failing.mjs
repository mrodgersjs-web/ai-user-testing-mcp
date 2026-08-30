// Reviewed fixture for malformed-fixtures (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "malformed-fixtures fixture artifact\n");
console.error("FAIL malformed-fixtures: deterministic planted failure");
process.exit(1);
