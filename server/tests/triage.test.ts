import { describe, it, expect } from "vitest";
import { triage } from "../src/triage.js";
import type { Classifier } from "../src/classify.js";
import { ClassificationError } from "../src/classify.js";
import type { Classification, InboundReply, Intent } from "../src/types.js";

const reply = (body: string): InboundReply => ({
  from: "journalist@example.com",
  subject: "Re: Your pitch",
  body,
  pitch_subject: "New fintech report",
});

const stub = (over: Partial<Classification> = {}): Classifier => {
  const value: Classification = {
    intent: "interested",
    confidence: 0.9,
    rationale: "stub",
    follow_up_date: null,
    key_question: null,
    draft_reply: "Happy to set up a call this week.",
    ...over,
  };
  return async () => value;
};

const failing = (retryable = true): Classifier => async () => {
  throw new ClassificationError("model unavailable", retryable);
};

describe("triage — rules win on the compliance-critical class", () => {
  it("keeps the rule verdict when the model disagrees", async () => {
    const result = await triage(
      reply("Please take me off this list."),
      stub({ intent: "interested" }),
    );

    expect(result.intent).toBe("unsubscribe");
    expect(result.locked_by_rule).toBe(true);
    expect(result.rule_matched).toBe("opt-out:take-me-off");
    expect(result.model_intent).toBe("interested");
  });

  it("flags rule/model disagreement for priority review", async () => {
    const result = await triage(
      reply("Please take me off this list."),
      stub({ intent: "interested" }),
    );
    expect(result.disagreement).toBe(true);
  });

  it("does not flag disagreement when both agree", async () => {
    const result = await triage(
      reply("Please take me off this list."),
      stub({ intent: "unsubscribe" }),
    );
    expect(result.disagreement).toBe(false);
  });
});

describe("triage — the model handles everything the rules don't", () => {
  it("passes the model verdict through when no rule fires", async () => {
    const result = await triage(
      reply("What's the embargo date?"),
      stub({ intent: "needs_info", key_question: "What's the embargo date?" }),
    );

    expect(result.intent).toBe("needs_info");
    expect(result.locked_by_rule).toBe(false);
    expect(result.rule_matched).toBeNull();
    expect(result.key_question).toBe("What's the embargo date?");
  });

  it("lets the model escalate into unsubscribe on phrasing the rules miss", async () => {
    const result = await triage(
      reply("I'd rather you didn't send me anything further, cheers."),
      stub({ intent: "unsubscribe", draft_reply: "" }),
    );

    expect(result.intent).toBe("unsubscribe");
    expect(result.locked_by_rule).toBe(false);
  });
});

describe("triage — the compliance path survives the API being down", () => {
  it("still returns the locked verdict when the model call fails", async () => {
    const result = await triage(reply("unsubscribe me please"), failing());

    expect(result.intent).toBe("unsubscribe");
    expect(result.locked_by_rule).toBe(true);
    expect(result.model_intent).toBeNull();
    expect(result.model_error).toContain("model unavailable");
  });

  it("throws when the model fails and no rule can answer", async () => {
    await expect(triage(reply("What's the angle?"), failing())).rejects.toThrow(
      ClassificationError,
    );
  });
});

describe("triage — draft replies are sanitised, not trusted", () => {
  const silent: Intent[] = ["unsubscribe", "not_relevant", "auto_reply"];

  for (const intent of silent) {
    it(`forces an empty draft for ${intent} even if the model wrote one`, async () => {
      const result = await triage(
        reply("What's the angle?"),
        stub({ intent, draft_reply: "Thanks so much, shall we book a call?" }),
      );
      expect(result.draft_reply).toBe("");
    });
  }

  it("keeps the draft for intents that warrant a reply", async () => {
    const result = await triage(
      reply("What's the angle?"),
      stub({ intent: "interested", draft_reply: "Happy to set up a call." }),
    );
    expect(result.draft_reply).toBe("Happy to set up a call.");
  });
});

describe("triage — every result needs a human", () => {
  it("always sets requires_review", async () => {
    const result = await triage(reply("Sounds great"), stub());
    expect(result.requires_review).toBe(true);
  });
});
