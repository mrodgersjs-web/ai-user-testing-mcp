import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  credentialEnvVarName,
  defaultToolChecker,
  detectEgressIntent,
  envCredentialResolver,
  extractEgressHosts,
  findPathEscape,
  isCommandAllowlisted,
  preflight,
} from "./preflight.js";
import { makeAdapter } from "./test-harness.js";

const BASE = "/tmp/runner-test-base";

describe("isCommandAllowlisted", () => {
  it("prefix-matches an allowlisted argv", () => {
    expect(isCommandAllowlisted(["npx", "playwright", "test"], [["npx", "playwright"]])).toBe(true);
  });
  it("refuses argv that diverges before the prefix is consumed", () => {
    expect(isCommandAllowlisted(["npx", "rm", "-rf"], [["npx", "playwright"]])).toBe(false);
  });
  it("refuses argv shorter than every prefix and empty argv", () => {
    expect(isCommandAllowlisted(["npx"], [["npx", "playwright"]])).toBe(false);
    expect(isCommandAllowlisted([], [["npx"]])).toBe(false);
  });
});

describe("findPathEscape", () => {
  it("flags absolute-path arguments outside the allow root", () => {
    expect(findPathEscape(["/bin/cat", "/etc/passwd"], [BASE])).toBe("/etc/passwd");
  });
  it("flags absolute paths embedded after '=' or ':'", () => {
    expect(findPathEscape(["tool", "--out=/etc/shadow"], [BASE])).toBe("--out=/etc/shadow");
    expect(findPathEscape(["tool", "dir:/etc"], [BASE])).toBe("dir:/etc");
  });
  it("allows absolute paths inside the sandbox base", () => {
    expect(findPathEscape(["tool", join(BASE, "inputs", "a.txt")], [BASE])).toBeNull();
    expect(findPathEscape(["tool", BASE], [BASE])).toBeNull();
  });
  it("does not mistake URL schemes for paths", () => {
    expect(findPathEscape(["tool", "https://api.example.com/x"], [BASE])).toBeNull();
  });
});

describe("detectEgressIntent", () => {
  it("flags known network binaries", () => {
    expect(detectEgressIntent(["/usr/bin/curl", "x"])).toBe(true);
  });
  it("flags URL-shaped argv and input tokens", () => {
    expect(detectEgressIntent(["node", "run", "https://api.example.com"], [])).toBe(true);
    expect(detectEgressIntent(["tool"], ["seed https://evil.example"])).toBe(true);
  });
  it("flags endpoint-style flags", () => {
    expect(detectEgressIntent(["tool", "--endpoint", "host"], [])).toBe(true);
    expect(detectEgressIntent(["tool", "--api-base=https://x"], [])).toBe(true);
  });
  it("does not flag local paths or file:// URIs", () => {
    expect(detectEgressIntent(["tool", "/tmp/x", "file:///tmp/y"], [])).toBe(false);
  });
  it("extracts hosts from URL tokens", () => {
    expect(extractEgressHosts(["tool", "https://user@api.example.com:443/x"], ["git+ssh://hub.example/y"])).toEqual([
      "api.example.com",
      "hub.example",
    ]);
  });
});

describe("defaultToolChecker", () => {
  it("resolves absolute executables and PATH binaries", () => {
    expect(defaultToolChecker("/bin/sleep")).toBe(true);
    expect(defaultToolChecker("sh")).toBe(true);
  });
  it("reports missing binaries", () => {
    expect(defaultToolChecker("definitely-not-a-real-binary-zz9")).toBe(false);
    expect(defaultToolChecker("/nonexistent/path/bin")).toBe(false);
  });
});

describe("credential defaults", () => {
  it("names the credential env var by adapter id", () => {
    expect(credentialEnvVarName("adapter.openai")).toBe("RIG_TESTLAB_ADAPTER_OPENAI_TOKEN");
  });
  it("reads presence from env without exposing anything but presence", () => {
    expect(envCredentialResolver("X", { X: "sekrit" })).toBe("sekrit");
    expect(envCredentialResolver("X", {})).toBeNull();
    expect(envCredentialResolver("X", { X: "" })).toBeNull();
  });
});

describe("preflight gates", () => {
  it("ok for a reviewed adapter with matching argv", () => {
    const adapter = makeAdapter({ commandAllowlist: [["/bin/echo"]] });
    expect(preflight(adapter, ["/bin/echo", "hi"], { baseDir: BASE })).toEqual({ ok: true });
  });

  it("adapter_not_reviewed before anything else", () => {
    const r = preflight(
      makeAdapter({ status: "experimental", commandAllowlist: [["no-such-bin-zz"]] }),
      ["no-such-bin-zz"],
      { baseDir: BASE },
    );
    expect(r).toEqual({ ok: false, reason: "adapter_not_reviewed" });
  });

  it("command_not_allowlisted", () => {
    expect(preflight(makeAdapter(), ["/bin/rm", "-rf", "/"], { baseDir: BASE })).toEqual({
      ok: false,
      reason: "command_not_allowlisted",
    });
  });

  it("path_escape_denied", () => {
    const adapter = makeAdapter({ commandAllowlist: [["/bin/cat"]] });
    expect(preflight(adapter, ["/bin/cat", "/etc/passwd"], { baseDir: BASE })).toEqual({
      ok: false,
      reason: "path_escape_denied",
    });
  });

  it("network_not_declared when allowlist empty and egress intended", () => {
    const adapter = makeAdapter({ commandAllowlist: [["node"]] });
    expect(preflight(adapter, ["node", "fetch", "https://api.example.com"], { baseDir: BASE })).toEqual({
      ok: false,
      reason: "network_not_declared",
    });
  });

  it("network declared ⇒ egress intent passes the gate", () => {
    const adapter = makeAdapter({
      commandAllowlist: [["node"]],
      networkAllowlist: ["api.example.com"],
    });
    expect(preflight(adapter, ["node", "fetch", "https://api.example.com"], { baseDir: BASE })).toEqual({
      ok: true,
    });
  });

  it("dependency_unavailable for missing executables and required tools", () => {
    const adapter = makeAdapter({ commandAllowlist: [["ghost-bin-zz9"]] });
    expect(preflight(adapter, ["ghost-bin-zz9"], { baseDir: BASE, toolChecker: () => false })).toEqual({
      ok: false,
      reason: "dependency_unavailable",
    });
    const okAdapter = makeAdapter({ commandAllowlist: [["/bin/echo"]] });
    expect(
      preflight(okAdapter, ["/bin/echo"], {
        baseDir: BASE,
        requireBinaries: ["ghost-tool-zz9"],
        toolChecker: (b) => b !== "ghost-tool-zz9",
      }),
    ).toEqual({ ok: false, reason: "dependency_unavailable" });
  });

  it("credential_missing on env_store adapters; ok when resolver provides one", () => {
    const adapter = makeAdapter({ credentialMode: "env_store" });
    expect(preflight(adapter, ["/bin/echo"], { baseDir: BASE, env: {} })).toEqual({
      ok: false,
      reason: "credential_missing",
    });
    expect(
      preflight(adapter, ["/bin/echo"], {
        baseDir: BASE,
        credentialResolver: (n) => (n === credentialEnvVarName(adapter.id) ? "v" : null),
      }),
    ).toEqual({ ok: true });
  });

  it("credit_budget_exceeded: over ceiling, unknown spend, or missing guards", () => {
    const paid = makeAdapter({
      paidProvider: true,
      paidGuards: { maxScenarios: 5, maxEstimatedCredits: 10 },
    });
    expect(
      preflight(paid, ["/bin/echo"], { baseDir: BASE, estimatedCredits: 50 }),
    ).toEqual({ ok: false, reason: "credit_budget_exceeded" });
    expect(
      preflight(paid, ["/bin/echo"], { baseDir: BASE }),
    ).toEqual({ ok: false, reason: "credit_budget_exceeded" });
    expect(
      preflight(makeAdapter({ paidProvider: true }), ["/bin/echo"], {
        baseDir: BASE,
        estimatedCredits: 1,
      }),
    ).toEqual({ ok: false, reason: "credit_budget_exceeded" });
    expect(
      preflight(paid, ["/bin/echo"], { baseDir: BASE, estimatedCredits: 5 }),
    ).toEqual({ ok: true });
    // scenario budget tighter than adapter guard wins (min)
    expect(
      preflight(paid, ["/bin/echo"], {
        baseDir: BASE,
        estimatedCredits: 5,
        scenarioMaxCredits: 2,
      }),
    ).toEqual({ ok: false, reason: "credit_budget_exceeded" });
  });

  it("target_missing via the caller hook only", () => {
    expect(
      preflight(makeAdapter(), ["/bin/echo"], { baseDir: BASE, targetExists: () => false }),
    ).toEqual({ ok: false, reason: "target_missing" });
    expect(
      preflight(makeAdapter(), ["/bin/echo"], { baseDir: BASE, targetExists: () => true }),
    ).toEqual({ ok: true });
  });
});
