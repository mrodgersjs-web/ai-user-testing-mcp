// Reviewed fixture for bruno-openapi (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "bruno-openapi fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "bruno-openapi fixture artifact\n");
console.error("dependency unavailable: bruno-openapi toolchain not installed");
process.exit(127);
