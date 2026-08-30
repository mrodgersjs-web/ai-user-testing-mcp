import { describe, expect, it } from "vitest";
import { sanitizeLinkUrl } from "./parse.js";

describe("sanitizeLinkUrl", () => {
  const cases: Array<[string, RegExp]> = [
    ["https://example.io/blog/中文路径", /^https:\/\/example\.io\/blog\/%/],
    ["https://example.io/a b/c", /a%20b/],
    ["https://example.io/{owner}/{repo}", /%7Bowner%7D/],
    ["https://例え.jp/path", /^https:\/\/xn--/],
    ["https://example.io/plain", /^https:\/\/example\.io\/plain$/],
  ];
  for (const [input, pattern] of cases) {
    it(`normalizes ${input}`, () => {
      const out = sanitizeLinkUrl(input);
      expect(out).toMatch(pattern);
      // every output must be a parseable absolute URL with no residual URI-illegal chars
      expect(() => new URL(out)).not.toThrow();
      expect(/[ "<>\\^`{|}]/.test(out)).toBe(false);
      expect(/[^\x21-\x7e]/.test(out)).toBe(false);
    });
  }
});

describe("sanitizeLinkUrl fragment hardening", () => {
  it("encodes a second # inside the fragment (gitter-style)", () => {
    const out = sanitizeLinkUrl("https://app.gitter.im/#/room/#aliesbelik_jmeter-chat:gitter.im");
    expect(out).toBe("https://app.gitter.im/#/room/%23aliesbelik_jmeter-chat:gitter.im");
    expect((out.match(/#/g) ?? []).length).toBe(1);
  });
});
