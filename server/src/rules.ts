import type { InboundReply, Intent } from "./types.js";

export interface RuleMatch {
  intent: Intent;
  /** Which rule fired, surfaced to the reviewer so a bad lock is debuggable. */
  rule: string;
}

/**
 * Markers that mean "everything below here is the pitch I sent them, not their reply".
 *
 * This matters more than it looks. Marketing footers routinely contain the word
 * "unsubscribe", and the original pitch is quoted in most replies — so matching
 * opt-out language against the raw body flags almost every reply as an opt-out.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^-{2,}\s*original message\s*-{2,}/i,
  /^on\b.*\bwrote:\s*$/i,
  /^_{5,}\s*$/,
  /^-{5,}\s*$/,
  /^from:\s.*@/i,
  /^sent:\s/i,
];

/** Boilerplate list-management lines, which are never the sender's own words. */
const FOOTER_LINES: RegExp[] = [
  /to\s+unsubscribe\b.*\bclick/i,
  /click\s+here\s+to\s+unsubscribe/i,
  /if\s+you\s+(no\s+longer\s+wish|would\s+prefer\s+not)\s+to\s+receive/i,
  /you\s+are\s+receiving\s+this\s+(email|message)\s+because/i,
  /manage\s+your\s+(email\s+)?preferences/i,
];

/**
 * Reduce a raw email body to the words the human actually typed this time.
 * Everything from the first quote marker onward is dropped, along with any
 * angle-quoted lines and known list-management boilerplate.
 */
export function stripQuotedAndFooter(body: string): string {
  const kept: string[] = [];

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (QUOTE_MARKERS.some((re) => re.test(trimmed))) break;
    if (trimmed.startsWith(">")) continue;
    if (FOOTER_LINES.some((re) => re.test(trimmed))) continue;

    kept.push(line);
  }

  return kept.join("\n").trim();
}

/**
 * Explicit opt-out language. Deliberately literal — this list is auditable, and
 * a compliance question ("why was this contact suppressed?") gets a one-line
 * answer instead of a model rationale.
 */
const OPT_OUT_PATTERNS: Array<[string, RegExp]> = [
  ["unsubscribe", /\bunsubscribe\b/i],
  ["take-me-off", /\btake\s+me\s+off\b/i],
  ["remove-me", /\bremove\s+me\s+from\b/i],
  ["stop-emailing", /\bstop\s+(emailing|contacting|messaging)\b/i],
  ["do-not-contact", /\b(do\s+not|don'?t)\s+contact\s+me\b/i],
  ["opt-out", /\bopt\s+(me\s+)?out\b/i],
  ["no-more-emails", /\bno\s+more\s+emails?\b/i],
];

/**
 * Machine-generated replies. A human never read these, so treating one as an
 * intent poisons every downstream metric and wastes a consultant's follow-up.
 */
const AUTO_REPLY_PATTERNS: Array<[string, RegExp]> = [
  ["out-of-office", /\bout\s+of\s+(the\s+)?office\b/i],
  ["ooo-abbrev", /\bout-of-office\b/i],
  ["automatic-reply", /\bautomatic\s+(reply|response)\b/i],
  ["auto-reply", /\bauto-?reply\b/i],
  ["automated", /\b(this\s+is\s+an\s+)?automated\s+(reply|response|message)\b/i],
  ["away-from-desk", /\baway\s+from\s+(my\s+)?desk\b/i],
  ["annual-leave", /\bon\s+(annual\s+)?leave\b/i],
  ["currently-away", /\b(i\s*'?m|i\s+am)\s+currently\s+away\b/i],
];

function firstMatch(
  text: string,
  patterns: Array<[string, RegExp]>,
): string | null {
  for (const [name, re] of patterns) {
    if (re.test(text)) return name;
  }
  return null;
}

/**
 * Run the deterministic guardrails.
 *
 * Returns a locked intent, or null to hand the decision to the model. Opt-out is
 * checked first: a reply that is both an out-of-office and an opt-out is an
 * opt-out, because suppressing a contact who did not need it costs a lead,
 * while missing one is a compliance failure. See SPEC.md section 4.
 */
export function applyRules(reply: InboundReply): RuleMatch | null {
  const text = stripQuotedAndFooter(reply.body);

  const optOut = firstMatch(text, OPT_OUT_PATTERNS);
  if (optOut) return { intent: "unsubscribe", rule: `opt-out:${optOut}` };

  const auto =
    firstMatch(text, AUTO_REPLY_PATTERNS) ??
    firstMatch(reply.subject, AUTO_REPLY_PATTERNS);
  if (auto) return { intent: "auto_reply", rule: `auto-reply:${auto}` };

  return null;
}
