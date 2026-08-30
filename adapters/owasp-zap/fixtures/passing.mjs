// Reviewed fixture for owasp-zap (passing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "owasp-zap fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "owasp-zap fixture artifact\n");
console.log("PASS owasp-zap");
