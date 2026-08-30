#!/usr/bin/env node
/**
 * Equality gate: every gitlink under sources/ in the index/HEAD must equal the
 * pinned SHA in catalog.lock.json, and every pinned SourcePin must have a
 * gitlink. Exit 2 with one line per mismatch on RED. The CLI `catalog verify`
 * wraps this same check; planted-failure proof lives in the release evidence.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const lock = JSON.parse(readFileSync("catalog.lock.json", "utf8"));
const expected = new Map(lock.pins.filter((p) => p.pinState === "pinned").map((p) => [p.submodulePath, p.commitSha]));

const tree = execFileSync("git", ["ls-tree", "-r", "HEAD", "sources/"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const actual = new Map();
const errors = [];
for (const line of tree) {
  const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line);
  if (!m) {
    errors.push(`non-gitlink entry under sources/: ${line}`);
    continue;
  }
  actual.set(m[2], m[1]);
}
for (const [path, sha] of expected) {
  const got = actual.get(path);
  if (got === undefined) errors.push(`missing gitlink for pinned source: ${path}`);
  else if (got !== sha) errors.push(`SHA mismatch at ${path}: lock=${sha} gitlink=${got}`);
}
for (const [path] of actual) {
  if (!expected.has(path)) errors.push(`gitlink without lock pin: ${path}`);
}
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(2);
}
console.log(`pins↔gitlinks EQUAL across ${expected.size} sources`);
