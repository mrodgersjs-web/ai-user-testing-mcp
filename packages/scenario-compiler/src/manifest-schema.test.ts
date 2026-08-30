import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_FILES, findRepoRoot, firstViolationPointer, getValidator } from "./manifest-schema.js";
import type { ProjectManifest } from "./project-manifest.js";
import type { ScenarioSpec } from "@rig-testlab/catalog";

describe("manifest-schema loading", () => {
  it("resolves the repo root by walking up to pnpm-workspace.yaml and finds every frozen schema", () => {
    const root = findRepoRoot(import.meta.dirname);
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
    for (const file of SCHEMA_FILES) {
      expect(existsSync(join(root, "schemas", file)), file).toBe(true);
    }
  });

  it("compiles a validator for every registered schema", () => {
    for (const file of SCHEMA_FILES) {
      expect(typeof getValidator(file)).toBe("function");
    }
  });

  it("validates the ProjectManifest fixture and rejects malformed manifests", () => {
    const validate = getValidator("ProjectManifest.v1.schema.json");
    const manifest = JSON.parse(
      readFileSync(new URL("../testdata/project.json", import.meta.url), "utf8")
    ) as ProjectManifest;
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, repo: { url: "x", revision: "not-a-sha" } })).toBe(false);
  });

  it("resolves the fragment $ref into ArtifactReceipt for ScenarioSpec evidence kinds", () => {
    const validate = getValidator("ScenarioSpec.v1.schema.json");
    const scenario = {
      id: "s-frag",
      project: "transformfit",
      platforms: ["web"],
      title: "fragment probe",
      steps: [{ action: "run", expected: "done" }],
      requiredAdapters: ["core-runner"],
      requiredEvidence: ["screenshot"]
    } as ScenarioSpec;
    expect(validate(scenario), JSON.stringify(validate.errors)).toBe(true);
    validate({ ...scenario, requiredEvidence: ["bogus_kind"] });
    expect(validate.errors?.[0]?.instancePath).toBe("/requiredEvidence/0");
  });

  it("enforces the frozen AdapterDescriptor wire shape and paid-conditional", () => {
    const validate = getValidator("AdapterDescriptor.v1.schema.json");
    const paid = JSON.parse(
      readFileSync(new URL("../testdata/adapters.json", import.meta.url), "utf8")
    ).find((a: { id: string }) => a.id === "paid-runner");
    // Selection hints are not wire fields — the schema rejects them; compileSuite strips them the same way.
    const { adoptionTier: _t, platforms: _p, ...wirePaid } = paid;
    expect(validate(wirePaid), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(paid)).toBe(false);
    const { paidGuards: _dropped, ...unguarded } = wirePaid;
    expect(validate(unguarded)).toBe(false);
  });

  it("firstViolationPointer appends the missing property to the instance path", () => {
    const validate = getValidator("ProjectManifest.v1.schema.json");
    validate({ id: "p" });
    expect(firstViolationPointer(validate.errors)).toBe("/repo");
    expect(firstViolationPointer(null)).toBe("#");
  });
});

describe("execution + provision extensions (v1 optional additions)", () => {
  it("ScenarioSpec accepts a materialized execution plan and rejects malformed ones", () => {
    const validate = getValidator("ScenarioSpec.v1.schema.json");
    const base = {
      id: "s-exec",
      project: "transformfit",
      platforms: ["web"],
      title: "execution probe",
      steps: [{ action: "run", expected: "done" }],
      requiredAdapters: ["cypress"],
      requiredEvidence: ["log"],
    } as ScenarioSpec;
    expect(
      validate({
        ...base,
        execution: { argv: [["npx", "cypress", "run"]], env: { CYPRESS_BASE_URL: "http://127.0.0.1:7358" } },
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    // secret-style / lowercase env names are rejected
    expect(validate({ ...base, execution: { env: { api_token: "x" } } })).toBe(false);
    // sequential commands are not (yet) a thing: maxItems 1
    expect(validate({ ...base, execution: { argv: [["a"], ["b"]] } })).toBe(false);
    // empty execution object is pointless and rejected
    expect(validate({ ...base, execution: {} })).toBe(false);
  });

  it("ProjectManifest accepts localPath and provision steps, rejecting malformed argv", () => {
    const validate = getValidator("ProjectManifest.v1.schema.json");
    const manifest = JSON.parse(
      readFileSync(new URL("../testdata/project.json", import.meta.url), "utf8")
    ) as ProjectManifest;
    const extended = {
      ...manifest,
      repo: { ...manifest.repo, localPath: "/repo/local" },
      provision: { postCheckout: [{ argv: ["npm", "ci"], env: { CI: "1" } }] },
    };
    expect(validate(extended), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...extended, provision: { postCheckout: [{ argv: [] }] } })).toBe(false);
    expect(validate({ ...extended, provision: { postCheckout: [{ cmd: "npm ci" }] } })).toBe(false);
  });

  it("the shipped transformfit manifest validates against the extended schema", () => {
    const validate = getValidator("ProjectManifest.v1.schema.json");
    const root = findRepoRoot(import.meta.dirname);
    const manifest = JSON.parse(
      readFileSync(join(root, "projects/transformfit/manifest.json"), "utf8")
    );
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    const scenarios = JSON.parse(
      readFileSync(join(root, "projects/transformfit/scenarios.json"), "utf8")
    ) as ScenarioSpec[];
    const vScenario = getValidator("ScenarioSpec.v1.schema.json");
    for (const s of scenarios) {
      expect(vScenario(s), `${s.id}: ${JSON.stringify(vScenario.errors)}`).toBe(true);
    }
  });
});
