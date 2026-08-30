// Reviewed fixture for malformed-fixtures (passing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "malformed-fixtures fixture artifact\n");
console.log("PASS malformed-fixtures");
