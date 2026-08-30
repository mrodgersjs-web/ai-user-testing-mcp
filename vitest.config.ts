import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@rig-testlab/catalog": src("./packages/catalog/src/index.ts"),
      "@rig-testlab/cli": src("./packages/cli/src/index.ts"),
      "@rig-testlab/scenario-compiler": src("./packages/scenario-compiler/src/index.ts"),
      "@rig-testlab/evidence": src("./packages/evidence/src/index.ts"),
      "@rig-testlab/runner": src("./packages/runner/src/index.ts"),
      "@rig-testlab/agent-installer": src("./packages/agent-installer/src/index.ts")
    }
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
});
