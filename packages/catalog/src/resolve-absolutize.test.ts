import { describe, expect, it } from "vitest";
import { absolutizeNestedUrl } from "./resolve.js";

describe("absolutizeNestedUrl", () => {
  const sha = "a".repeat(40);
  it("passes absolute http(s) through untouched", () => {
    expect(absolutizeNestedUrl("https://x.io/a", "o", "r", sha)).toBe("https://x.io/a");
  });
  it("upgrades protocol-relative", () => {
    expect(absolutizeNestedUrl("//host/p", "o", "r", sha)).toBe("https:////host/p".replace("https://", "https:"));
  });
  it("resolves repo-internal relative links to pinned blob URLs", () => {
    expect(absolutizeNestedUrl("docs/testing.md", "o", "r", sha)).toBe(`https://github.com/o/r/blob/${sha}/docs/testing.md`);
    expect(absolutizeNestedUrl("./a/b.md#frag", "o", "r", sha)).toBe(`https://github.com/o/r/blob/${sha}/a/b.md`);
    expect(absolutizeNestedUrl("/root-level.md", "o", "r", sha)).toBe(`https://github.com/o/r/blob/${sha}/root-level.md`);
  });
  it("leaves other schemes alone for downstream filtering", () => {
    expect(absolutizeNestedUrl("ftp://x/y", "o", "r", sha)).toBe("ftp://x/y");
  });
});
