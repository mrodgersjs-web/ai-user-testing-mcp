// Reviewed fixture for watir (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/screenshot`, { recursive: true });
writeFileSync(`artifacts/screenshot/sample-screenshot.png`, "watir fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "watir fixture artifact\n");
console.error("FAIL watir: deterministic planted failure");
process.exit(1);
