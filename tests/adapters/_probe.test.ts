import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { parseFirstLevel, repoRoot } from "@rig-testlab/catalog";

test("probe census", () => {
  const md = readFileSync(join(repoRoot(), "packages/catalog/testdata/awt-README-ff695aa.md"), "utf8");
  const entries = parseFirstLevel(md);
  writeFileSync(
    "/tmp/census.txt",
    entries.map((e) => `${e.id}\t${e.canonicalUrl}\t${e.targetKind}`).join("\n") + `\nCOUNT=${entries.length}\n`,
  );
});
