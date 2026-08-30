// Reviewed fixture for testsprite (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/video`, { recursive: true });
writeFileSync(`artifacts/video/sample-video.mp4`, "testsprite fixture artifact\n");
mkdirSync(`artifacts/console_network_trace`, { recursive: true });
writeFileSync(`artifacts/console_network_trace/sample-console_network_trace.txt`, "testsprite fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "testsprite fixture artifact\n");
console.error("FAIL testsprite: deterministic planted failure");
process.exit(1);
