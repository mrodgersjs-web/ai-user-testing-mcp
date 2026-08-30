import { describe, expect, it } from "vitest";
import { redactText } from "./index.js";

const GH_TOKEN = "ghp_Ab1cDe2fGh3iJk4lMn5oPq6rSt7uVw8xYz90"; // ghp_ + 36 alnum
const GH_APP = "ghs_Ab1cDe2fGh3iJk4lMn5oPq6rSt7uVw8xYz90";
const OPENAI_KEY = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5";
const ANTHROPIC_KEY = "sk-ant-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5";
const SLACK_TOKEN = "xoxb-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNPQ"; // exactly AKIA + 16 uppercase
const BEARER_TOKEN = "dXNlcjpwYXNzd29yZC1zdHJpbmctMTIzNDU=";
const BEARER = `Authorization: Bearer ${BEARER_TOKEN}`;
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAx7Vd0kC1L6pqMl4Y0c1Ve9kR1n2xQ8oPz3t0gV7hQwF1AaB2",
  "cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4aB5cD6eF7gH8iJ9kL0mN1oP2qR3",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

function expectRedacted(input: string, kind: string, secret: string): void {
  const res = redactText(input);
  expect(res.hitCount, `expected hit for ${kind} in: ${input}`).toBeGreaterThan(0);
  expect(res.kinds).toContain(kind);
  expect(res.text).not.toContain(secret);
  expect(res.text).toContain(`[REDACTED:${kind}]`);
  // idempotence
  const again = redactText(res.text);
  expect(again.hitCount).toBe(0);
  expect(again.text).toBe(res.text);
}

describe("redactText pattern coverage", () => {
  it("flags GitHub tokens (ghp_/ghs_)", () => {
    expectRedacted(`remote: https://${GH_TOKEN}@github.com/o/r`, "github_token", GH_TOKEN);
    expectRedacted(`token ${GH_APP} leaked`, "github_token", GH_APP);
  });

  it("flags OpenAI-style keys", () => {
    expectRedacted(`api_key=${OPENAI_KEY}`, "openai_key", OPENAI_KEY.slice(4));
  });

  it("flags Anthropic keys distinctly from the sk- generic", () => {
    expectRedacted(`ANTHROPIC_KEY: ${ANTHROPIC_KEY}`, "anthropic_key", ANTHROPIC_KEY.slice(7));
  });

  it("flags Slack tokens", () => {
    expectRedacted(`SLACK_TOKEN=${SLACK_TOKEN}`, "slack_token", SLACK_TOKEN.slice(5));
  });

  it("flags AWS access key ids", () => {
    expectRedacted(`aws key ${AWS_KEY} found in trace`, "aws_access_key_id", AWS_KEY);
  });

  it("flags Bearer headers", () => {
    expectRedacted(`> ${BEARER}\n< 200 OK`, "bearer_token", BEARER_TOKEN);
  });

  it("flags PEM private key blocks wholesale", () => {
    const res = redactText(`config:\n${PEM}\nnext line`);
    expect(res.kinds).toContain("pem_private_key");
    expect(res.text).not.toContain("PRIVATE KEY");
    expect(res.text).toContain("next line");
    expect(redactText(res.text).hitCount).toBe(0);
  });

  it("flags generic key assignments keeping only the first 4 secret chars", () => {
    const res = redactText('api_key = "super-secret-value-123"');
    expect(res.kinds).toContain("assignment_secret");
    expect(res.text).toContain("supe[REDACTED:assignment_secret]");
    expect(res.text).not.toContain("r-secret-value-123");
    expect(redactText(res.text).hitCount).toBe(0);
  });

  it("flags high-entropy base62 in key=value contexts outside the key-word list", () => {
    const secret = "aB3dEf6GhI9jKl2mNo4pQr7sTu1vWx5yZ0cBa8Dn4mKp2Lqj7Rst9uVw1xYz3bCd";
    const res = redactText(`gh_token=${secret}`);
    expect(res.kinds).toContain("high_entropy");
    expect(res.text).not.toContain(secret.slice(8));
    expect(res.text).toContain("aB3d[REDACTED:high_entropy]");
    expect(redactText(res.text).hitCount).toBe(0);
  });

  it("counts multiple secrets and reports each kind", () => {
    const res = redactText([`tok=${GH_TOKEN}`, BEARER, `aws=${AWS_KEY}`].join("\n"));
    expect(res.hitCount).toBeGreaterThanOrEqual(3);
    expect(res.kinds).toEqual(expect.arrayContaining(["github_token", "bearer_token", "aws_access_key_id"]));
    const again = redactText(res.text);
    expect(again.hitCount).toBe(0);
    expect(again.text).toBe(res.text);
  });

  it("leaves clean text byte-identical", () => {
    const clean = "npm test passed with token count 12 in 3.4s"; // no assignment form
    const res = redactText(clean);
    expect(res).toEqual({ text: clean, hitCount: 0, kinds: [] });
  });
});
