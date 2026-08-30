// Reviewed fixture for testmu-smartui (passing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/screenshot`, { recursive: true });
writeFileSync(`artifacts/screenshot/sample-screenshot.png`, "testmu-smartui fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "testmu-smartui fixture artifact\n");
console.log("PASS testmu-smartui");
