// Reviewed fixture for cypress-axe (failing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/accessibility_tree`, { recursive: true });
writeFileSync(`artifacts/accessibility_tree/sample-accessibility_tree.txt`, "cypress-axe fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "cypress-axe fixture artifact\n");
console.error("FAIL cypress-axe: deterministic planted failure");
process.exit(1);
