import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ClassificationSchema,
  type Classification,
  type InboundReply,
} from "./types.js";

/**
 * A classifier is a plain function, so the eval harness and the tests can pass a
 * stub without an API key. That is what keeps CI green without secrets, and it
 * makes "what would a different model do here" a one-line change.
 */
export type Classifier = (reply: InboundReply) => Promise<Classification>;

export class ClassificationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ClassificationError";
  }
}

/**
 * The prompt is part of the spec, not an implementation detail — it encodes the
 * taxonomy from SPEC.md section 3 and every edge case that broke an earlier
 * version. When a golden case regresses, this is the first thing to change.
 */
export const SYSTEM_PROMPT = `You triage replies that journalists send back to a PR consultancy's pitch emails.

Classify the reply into exactly one intent:

- interested    — wants the story, an interview, assets, or a briefing.
- needs_info    — will not commit until a specific question is answered.
- not_now       — open in principle, wrong timing. Extract a follow-up date if one is named.
- not_relevant  — wrong beat, wrong outlet, wrong region. No opening.
- unsubscribe   — asks to stop being contacted at all.
- auto_reply    — machine-generated: out-of-office, ticket acknowledgement, delivery failure.

Rules that override the obvious reading:

1. If the message is machine-generated, it is auto_reply — no matter how positive
   the wording. An out-of-office that says "this sounds great, email me again" is
   auto_reply, because no human has read the pitch yet.
2. A polite rejection is not_relevant. It only becomes unsubscribe when the sender
   asks to stop being contacted, not merely to be passed over this once.
3. A question about angle, timing, or exclusivity is needs_info, not not_relevant.
   It is an opening, not a brush-off.
4. Quoted text below the reply is the consultancy's own pitch. Judge only the words
   the sender wrote this time.

Set confidence honestly. Use below 0.7 when the reply is genuinely ambiguous — a
low score routes it to a human faster, which is the correct outcome. Do not inflate.

Write draft_reply as the consultant would send it: two or three sentences, plain
British English, no greeting line, no sign-off. A human edits and sends it. For
unsubscribe, not_relevant, and auto_reply, return an empty string — those get no
reply at all.`;

function renderReply(reply: InboundReply): string {
  return [
    `Pitch subject: ${reply.pitch_subject || "(unknown)"}`,
    `Reply from: ${reply.from}`,
    `Reply subject: ${reply.subject || "(none)"}`,
    "",
    "Reply body:",
    reply.body,
  ].join("\n");
}

export interface ClaudeClassifierOptions {
  client?: Anthropic;
  model?: string;
}

export function createClaudeClassifier(
  options: ClaudeClassifierOptions = {},
): Classifier {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? process.env.TRIAGE_MODEL ?? "claude-opus-5";

  return async function classify(reply: InboundReply): Promise<Classification> {
    try {
      const response = await client.messages.parse({
        model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: renderReply(reply) }],
        output_config: { format: zodOutputFormat(ClassificationSchema) },
      });

      if (response.stop_reason === "refusal") {
        throw new ClassificationError(
          "Model refused to classify this reply.",
          false,
        );
      }

      // parsed_output is null when the response did not satisfy the schema.
      // Failing loudly beats routing on a half-parsed object.
      if (!response.parsed_output) {
        throw new ClassificationError(
          "Model response did not match the classification schema.",
          true,
        );
      }

      return response.parsed_output;
    } catch (error) {
      if (error instanceof ClassificationError) throw error;

      // Most specific first — the retryable//not distinction is the whole point.
      if (error instanceof Anthropic.NotFoundError) {
        throw new ClassificationError(`Unknown model "${model}".`, false);
      }
      if (error instanceof Anthropic.AuthenticationError) {
        throw new ClassificationError("ANTHROPIC_API_KEY is missing or invalid.", false);
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new ClassificationError("Rate limited by the Anthropic API.", true);
      }
      if (error instanceof Anthropic.InternalServerError) {
        throw new ClassificationError(
          `Anthropic API server error: ${error.message}`,
          true,
        );
      }
      // Must precede the generic APIError branch — it is a subclass.
      if (error instanceof Anthropic.APIConnectionError) {
        throw new ClassificationError("Could not reach the Anthropic API.", true);
      }
      if (error instanceof Anthropic.APIError) {
        const status = error.status ?? 0;
        throw new ClassificationError(
          `Anthropic API error ${status}: ${error.message}`,
          status >= 500,
        );
      }
      throw error;
    }
  };
}
