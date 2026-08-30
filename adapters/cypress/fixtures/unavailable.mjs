// Reviewed fixture for cypress (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/screenshot`, { recursive: true });
writeFileSync(`artifacts/screenshot/sample-screenshot.png`, "cypress fixture artifact\n");
mkdirSync(`artifacts/video`, { recursive: true });
writeFileSync(`artifacts/video/sample-video.mp4`, "cypress fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "cypress fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "cypress fixture artifact\n");
console.error("dependency unavailable: cypress toolchain not installed");
process.exit(127);
