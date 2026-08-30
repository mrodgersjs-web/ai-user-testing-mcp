// Reviewed fixture for bruno-openapi (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "bruno-openapi fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "bruno-openapi fixture artifact\n");
console.error("FAIL bruno-openapi: deterministic planted failure");
process.exit(1);
