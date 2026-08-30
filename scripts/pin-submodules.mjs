#!/usr/bin/env node
/**
 * Register every pinned SourcePin as a gitlink + .gitmodules entry WITHOUT
 * cloning (hydration is a separate, disk-gated step). A gitlink is just a
 * tree entry (mode 160000, sha) — `git update-index --cacheinfo` creates it
 * from the lock's API-verified SHA. Deterministic: .gitmodules is regenerated
 * from catalog.lock.json in sorted order every run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const lock = JSON.parse(readFileSync("catalog.lock.json", "utf8"));
const pins = lock.pins.filter((p) => p.pinState === "pinned");

let gitmodules = "";
const sorted = [...pins].sort((a, b) => a.submodulePath.localeCompare(b.submodulePath));
for (const p of sorted) {
  gitmodules += `[submodule "${p.gitmodulesName}"]\n\tpath = ${p.submodulePath}\n\turl = ${p.repoUrl}\n`;
}
writeFileSync(".gitmodules", gitmodules);

let ok = 0;
for (const p of sorted) {
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${p.commitSha},${p.submodulePath}`]);
  ok++;
}
console.log(`registered ${ok} gitlinks from ${pins.length} pinned sources`);
