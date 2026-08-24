import { z } from "zod";

/**
 * The six intents from SPEC.md section 3. Ordered most to least actionable.
 *
 * These are a closed set on purpose: the classifier picks exactly one, and each
 * one routes differently. If two intents ever route identically, one of them
 * should be deleted rather than kept "for reporting".
 */
export const INTENTS = [
  "interested",
  "needs_info",
  "not_now",
  "not_relevant",
  "unsubscribe",
  "auto_reply",
] as const;

export const IntentSchema = z.enum(INTENTS);
export type Intent = z.infer<typeof IntentSchema>;

/**
 * What the model is asked to return.
 *
 * Every field is required and nullable rather than optional — structured output
 * schemas are strict, and "absent" and "null" being two different states is a
 * bug source we don't need. The model must make an explicit call on each field.
 */
export const ClassificationSchema = z.object({
  intent: IntentSchema,
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How certain the classification is, 0 to 1."),
  rationale: z
    .string()
    .describe("One sentence explaining the call, for the human reviewer."),
  follow_up_date: z
    .string()
    .nullable()
    .describe(
      "ISO 8601 date (YYYY-MM-DD) if the reply names a time to come back, else null.",
    ),
  key_question: z
    .string()
    .nullable()
    .describe("The question being asked, if intent is needs_info, else null."),
  draft_reply: z
    .string()
    .describe(
      "A short suggested reply for the consultant to edit. Empty string if no reply is warranted.",
    ),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** An inbound reply as it arrives from the (not yet built) inbox connector. */
export const InboundReplySchema = z.object({
  from: z.string().min(1),
  subject: z.string().default(""),
  body: z.string().min(1),
  pitch_subject: z
    .string()
    .default("")
    .describe("Subject of the pitch this is replying to, for context."),
});
export type InboundReply = z.infer<typeof InboundReplySchema>;

/**
 * The result of triage: the model's view, the rules' view, and which one won.
 *
 * `locked_by_rule` is surfaced all the way to the UI. A reviewer seeing an item
 * suppressed needs to know whether a deterministic rule did it or the model did,
 * because those two failures are debugged completely differently.
 */
export interface TriageResult {
  intent: Intent;
  confidence: number;
  rationale: string;
  follow_up_date: string | null;
  key_question: string | null;
  draft_reply: string;
  locked_by_rule: boolean;
  rule_matched: string | null;
  model_intent: Intent | null;
  requires_review: true;
}

export interface QueueItem {
  id: string;
  reply: InboundReply;
  triage: TriageResult;
  status: "pending" | "approved" | "rejected";
  reviewer_intent: Intent | null;
  received_at: string;
}
