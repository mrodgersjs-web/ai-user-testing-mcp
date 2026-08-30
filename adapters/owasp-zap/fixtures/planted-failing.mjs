// Reviewed fixture for owasp-zap (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "owasp-zap fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "owasp-zap fixture artifact\n");
console.error("FAIL owasp-zap: deterministic planted failure");
process.exit(1);
