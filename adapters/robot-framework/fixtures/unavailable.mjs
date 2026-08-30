// Reviewed fixture for robot-framework (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "robot-framework fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "robot-framework fixture artifact\n");
mkdirSync(`artifacts/screenshot`, { recursive: true });
writeFileSync(`artifacts/screenshot/sample-screenshot.png`, "robot-framework fixture artifact\n");
console.error("dependency unavailable: robot-framework toolchain not installed");
process.exit(127);
