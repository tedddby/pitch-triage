import { describe, it, expect } from "vitest";
import { ReviewQueue } from "../src/queue.js";
import { loadFlags } from "../src/flags.js";
import type { InboundReply, Intent, TriageResult } from "../src/types.js";

const reply = (body: string): InboundReply => ({
  from: "j@outlet.example",
  subject: "Re: pitch",
  body,
  pitch_subject: "report",
});

const result = (over: Partial<TriageResult> = {}): TriageResult => ({
  intent: "interested",
  confidence: 0.9,
  rationale: "stub",
  follow_up_date: null,
  key_question: null,
  draft_reply: "",
  locked_by_rule: false,
  rule_matched: null,
  model_intent: "interested",
  disagreement: false,
  model_error: null,
  requires_review: true,
  ...over,
});

describe("ReviewQueue ordering", () => {
  it("surfaces rule/model disagreements above confident items", () => {
    const q = new ReviewQueue();
    q.add(reply("a"), result({ confidence: 0.99 }));
    const flagged = q.add(reply("b"), result({ disagreement: true, confidence: 1 }));

    expect(q.list()[0]?.id).toBe(flagged.id);
  });

  it("surfaces low confidence above high confidence", () => {
    const q = new ReviewQueue();
    q.add(reply("a"), result({ confidence: 0.95 }));
    const unsure = q.add(reply("b"), result({ confidence: 0.4 }));

    expect(q.list()[0]?.id).toBe(unsure.id);
  });

  it("sinks decided items below pending ones", () => {
    const q = new ReviewQueue();
    const first = q.add(reply("a"), result({ confidence: 0.1 }));
    q.add(reply("b"), result({ confidence: 0.99 }));
    q.decide(first.id, "approved");

    expect(q.list()[0]?.status).toBe("pending");
  });
});

describe("ReviewQueue corrections", () => {
  it("captures a reviewer overruling the classifier", () => {
    const q = new ReviewQueue();
    const item = q.add(reply("take me off"), result({ intent: "interested" }));
    q.decide(item.id, "rejected", "unsubscribe" as Intent);

    expect(q.corrections()).toEqual([
      { reply: item.reply, expected: "unsubscribe", was: "interested" },
    ]);
  });

  it("ignores a rejection that agreed with the classifier", () => {
    const q = new ReviewQueue();
    const item = q.add(reply("no thanks"), result({ intent: "not_relevant" }));
    q.decide(item.id, "rejected", "not_relevant" as Intent);

    expect(q.corrections()).toEqual([]);
  });

  it("returns undefined for an unknown id instead of throwing", () => {
    expect(new ReviewQueue().decide("nope", "approved")).toBeUndefined();
  });
});

describe("feature flags", () => {
  it("defaults auto-send to off when unset", () => {
    expect(loadFlags({}).autoSend).toBe(false);
  });

  it("stays off for anything that is not an affirmative value", () => {
    expect(loadFlags({ FLAG_AUTO_SEND: "false" }).autoSend).toBe(false);
    expect(loadFlags({ FLAG_AUTO_SEND: "" }).autoSend).toBe(false);
    expect(loadFlags({ FLAG_AUTO_SEND: "maybe" }).autoSend).toBe(false);
  });

  it("turns on only for explicit affirmatives", () => {
    expect(loadFlags({ FLAG_AUTO_SEND: "true" }).autoSend).toBe(true);
    expect(loadFlags({ FLAG_AUTO_SEND: "1" }).autoSend).toBe(true);
    expect(loadFlags({ FLAG_AUTO_SEND: "ON" }).autoSend).toBe(true);
  });
});
