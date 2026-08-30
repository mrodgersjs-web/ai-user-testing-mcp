// Reviewed fixture for blns-boundary (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "blns-boundary fixture artifact\n");
console.error("dependency unavailable: blns-boundary toolchain not installed");
process.exit(127);
