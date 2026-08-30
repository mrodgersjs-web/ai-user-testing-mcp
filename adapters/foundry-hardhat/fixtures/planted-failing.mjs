// Reviewed fixture for foundry-hardhat (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "foundry-hardhat fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "foundry-hardhat fixture artifact\n");
console.error("FAIL foundry-hardhat: deterministic planted failure");
process.exit(1);
