// Reviewed fixture for appium-xcuitest (passing) — stdlib-only emulation of the tool.
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(`artifacts/video`, { recursive: true });
writeFileSync(`artifacts/video/sample-video.mp4`, "appium-xcuitest fixture artifact\n");
mkdirSync(`artifacts/screenshot`, { recursive: true });
writeFileSync(`artifacts/screenshot/sample-screenshot.png`, "appium-xcuitest fixture artifact\n");
mkdirSync(`artifacts/log`, { recursive: true });
writeFileSync(`artifacts/log/sample-log.txt`, "appium-xcuitest fixture artifact\n");
console.log("PASS appium-xcuitest");
