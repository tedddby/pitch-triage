import { applyRules } from "./rules.js";
import { ClassificationError, type Classifier } from "./classify.js";
import type { Classification, InboundReply, Intent, TriageResult } from "./types.js";

/** Intents that get no reply at all, however good the model's draft was. */
const SILENT_INTENTS: ReadonlySet<Intent> = new Set([
  "unsubscribe",
  "not_relevant",
  "auto_reply",
]);

/**
 * The prompt tells the model to return an empty draft for silent intents. This
 * enforces it. A prompt is a request; this is a guarantee — and the failure it
 * prevents is emailing someone who just asked to never hear from us again.
 */
function sanitiseDraft(intent: Intent, draft: string): string {
  return SILENT_INTENTS.has(intent) ? "" : draft;
}

/**
 * Run a reply through the guardrails and the classifier, and merge the two.
 *
 * The merge is a ratchet (SPEC.md section 4): a deterministic rule can lock the
 * outcome and the model cannot unlock it, but the model may still escalate a
 * reply the rules said nothing about. Neither side can make the outcome less
 * conservative than the other wanted.
 */
export async function triage(
  reply: InboundReply,
  classify: Classifier,
): Promise<TriageResult> {
  const rule = applyRules(reply);

  let model: Classification | null = null;
  let modelError: string | null = null;

  try {
    model = await classify(reply);
  } catch (error) {
    // A locked reply already has its answer, so a model outage degrades rather
    // than fails: the compliance path does not depend on the API being up.
    if (!rule) throw error;
    modelError =
      error instanceof ClassificationError || error instanceof Error
        ? error.message
        : String(error);
  }

  if (rule) {
    const intent = rule.intent;
    return {
      intent,
      // A rule match is a certainty, not an estimate.
      confidence: 1,
      rationale: model
        ? `Locked by rule ${rule.rule}. Model said "${model.intent}": ${model.rationale}`
        : `Locked by rule ${rule.rule}. Model unavailable.`,
      follow_up_date: model?.follow_up_date ?? null,
      key_question: model?.key_question ?? null,
      draft_reply: sanitiseDraft(intent, model?.draft_reply ?? ""),
      locked_by_rule: true,
      rule_matched: rule.rule,
      model_intent: model?.intent ?? null,
      disagreement: model ? model.intent !== intent : false,
      model_error: modelError,
      requires_review: true,
    };
  }

  // No rule fired, so the model call must have succeeded to get here.
  const verdict = model as Classification;

  return {
    intent: verdict.intent,
    confidence: verdict.confidence,
    rationale: verdict.rationale,
    follow_up_date: verdict.follow_up_date,
    key_question: verdict.key_question,
    draft_reply: sanitiseDraft(verdict.intent, verdict.draft_reply),
    locked_by_rule: false,
    rule_matched: null,
    model_intent: verdict.intent,
    disagreement: false,
    model_error: null,
    requires_review: true,
  };
}
