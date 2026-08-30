// Reviewed fixture for vertaa11y (unavailable) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/accessibility_tree`, { recursive: true });
writeFileSync(`artifacts/accessibility_tree/sample-accessibility_tree.txt`, "vertaa11y fixture artifact\n");
mkdirSync(`artifacts/json_report`, { recursive: true });
writeFileSync(`artifacts/json_report/sample-json_report.txt`, "vertaa11y fixture artifact\n");
console.error("dependency unavailable: vertaa11y toolchain not installed");
process.exit(127);
