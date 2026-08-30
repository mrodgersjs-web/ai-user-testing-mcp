/**
 * Secret redaction for persisted evidence. One pass collects every pattern hit
 * as a span; spans are resolved left-to-right (ties by rule order) keeping only
 * non-overlapping matches, then applied in one splice. Masks never reintroduce
 * secret-shaped text, so redaction is idempotent: redactText(redactText(t).text).hitCount === 0.
 */

export interface RedactResult {
  text: string;
  hitCount: number;
  kinds: string[];
}

interface RedactRule {
  kind: string;
  regex: RegExp;
  /**
   * Locates the secret inside a match: the secret must end the masked region
   * (tail = literal chars consumed after it, e.g. a closing quote, preserved
   * outside the mask). Whole match is the secret when absent.
   */
  value?: (match: RegExpExecArray) => { secret: string; tail: string };
  /** Keep the first 4 characters of the secret before the marker. */
  keepFirst4?: boolean;
}

const RULES: readonly RedactRule[] = [
  {
    kind: "pem_private_key",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:.|\n)*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    kind: "github_token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
  },
  {
    kind: "slack_token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    kind: "aws_access_key_id",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    kind: "anthropic_key",
    regex: /\bsk-ant-[A-Za-z0-9]{20,}\b/g,
  },
  {
    // OpenAI-style: sk- plus 20+ alphanumerics (sk-proj-… tails are caught as their own span).
    kind: "openai_key",
    regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: "bearer_token",
    regex: /\bBearer\s+[A-Za-z0-9+/=_.\-~]{20,}/g,
  },
  {
    kind: "assignment_secret",
    // key-ish assignment: api_key = "…" / token: '…' / secret=… (quoted or bare).
    regex:
      /\b((?:api|access|secret|auth|client|private|refresh|bearer)[_-]?(?:key|token|secret)|api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token|password|passwd|secret|token)["']?\s*[:=]\s*(?:"([^"\s\[][A-Za-z0-9+/=_.\-~]{7,})"|'([^'\s\[][A-Za-z0-9+/=_.\-~]{7,})'|([A-Za-z0-9+/=_.\-~]{8,}))/g,
    // The value lands in group 2 (double-quoted), 3 (single-quoted) or 4 (bare).
    value: (m) =>
      m[2] !== undefined
        ? { secret: m[2], tail: '"' }
        : m[3] !== undefined
          ? { secret: m[3], tail: "'" }
          : { secret: m[4] ?? "", tail: "" },
    keepFirst4: true,
  },
  {
    kind: "high_entropy",
    // key = <base62 ≥32> contexts the assignment rule's key list can miss.
    regex:
      /\b([A-Za-z][A-Za-z0-9_]*(?:key|token|secret|credential|password|apikey))\s*=\s*([A-Za-z0-9]{32,})\b/g,
    value: (m) => ({ secret: m[2] ?? "", tail: "" }),
    keepFirst4: true,
  },
];


interface Span {
  start: number;
  end: number;
  kind: string;
  replacement: string;
}

function buildSpan(rule: RedactRule, match: RegExpExecArray): Span {
  const { secret, tail } = rule.value ? rule.value(match) : { secret: match[0], tail: "" };
  const end = match.index + match[0].length - tail.length;
  const start = end - secret.length;
  const preserved = match[0].slice(0, start - match.index);
  const marker = `[REDACTED:${rule.kind}]`;
  const mask = rule.keepFirst4 ? `${secret.slice(0, 4)}${marker}` : marker;
  return { start, end, kind: rule.kind, replacement: preserved + mask };
}

export function redactText(source: string): RedactResult {
  const spans: Span[] = [];
  let ruleIndex = 0;
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.regex.exec(source)) !== null) {
      const span = buildSpan(rule, match);
      // Prefix rule index for deterministic tie-breaking; stripped from output.
      span.kind = `${String(ruleIndex).padStart(2, "0")}:${span.kind}`;
      spans.push(span);
      if (match[0].length === 0) rule.regex.lastIndex += 1; // guard zero-width loops
    }
    ruleIndex += 1;
  }
  // Deterministic resolution: leftmost first; ties by rule index (earlier rule wins).
  spans.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  const kept: Span[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // overlaps an already-kept span
    kept.push(span);
    cursor = span.end;
  }
  if (kept.length === 0) return { text: source, hitCount: 0, kinds: [] };
  let text = "";
  let pos = 0;
  const kinds: string[] = [];
  for (const span of kept) {
    text += source.slice(pos, span.start) + span.replacement;
    pos = span.end;
    const kind = span.kind.slice(3); // drop the "NN:" ordering tag
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  text += source.slice(pos);
  return { text, hitCount: kept.length, kinds: kinds.sort() };
}
