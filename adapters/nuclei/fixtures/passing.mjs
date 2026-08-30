// Reviewed fixture for nuclei (passing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "nuclei fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "nuclei fixture artifact\n");
console.log("PASS nuclei");
