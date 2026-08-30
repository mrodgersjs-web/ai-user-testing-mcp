// Reviewed fixture for malformed-fixtures (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "malformed-fixtures fixture artifact\n");
console.error("dependency unavailable: malformed-fixtures toolchain not installed");
process.exit(127);
