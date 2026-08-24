import { describe, it, expect } from "vitest";
import { applyRules, stripQuotedAndFooter } from "../src/rules.js";
import type { InboundReply } from "../src/types.js";

const reply = (body: string, extra: Partial<InboundReply> = {}): InboundReply => ({
  from: "journalist@example.com",
  subject: "Re: Your pitch",
  body,
  pitch_subject: "New fintech report",
  ...extra,
});

describe("stripQuotedAndFooter", () => {
  it("drops an Outlook-style quoted original message", () => {
    const out = stripQuotedAndFooter(
      "Not for me.\n\n-----Original Message-----\nFrom: pr@agency.com\nTo unsubscribe, click here.",
    );
    expect(out).toBe("Not for me.");
  });

  it("drops a Gmail-style quote header and everything after it", () => {
    const out = stripQuotedAndFooter(
      "Sounds good.\n\nOn Mon, 3 Feb 2026 at 09:12, PR Agency <pr@a.com> wrote:\n> please unsubscribe me",
    );
    expect(out).toBe("Sounds good.");
  });

  it("drops leading angle-quoted lines", () => {
    const out = stripQuotedAndFooter("> stop emailing me\nActually this looks great.");
    expect(out).toBe("Actually this looks great.");
  });
});

describe("applyRules — opt-out detection", () => {
  const optOuts = [
    "Please unsubscribe me from this list.",
    "Take me off this list please.",
    "Remove me from your mailing list.",
    "Stop emailing me.",
    "Do not contact me again.",
    "Please opt me out of future emails.",
    "unsubscribe",
  ];

  for (const body of optOuts) {
    it(`locks to unsubscribe: ${JSON.stringify(body)}`, () => {
      const match = applyRules(reply(body));
      expect(match?.intent).toBe("unsubscribe");
    });
  }

  it("locks even when the opt-out is buried after a pleasantry", () => {
    const match = applyRules(
      reply("Thanks for thinking of me, but please take me off this list."),
    );
    expect(match?.intent).toBe("unsubscribe");
  });
});

describe("applyRules — the false positives that matter", () => {
  it("does NOT fire on a boilerplate unsubscribe footer in the quoted pitch", () => {
    const match = applyRules(
      reply(
        [
          "Interesting, send me the data.",
          "",
          "-----Original Message-----",
          "From: pr@agency.com",
          "To unsubscribe from these emails, click here.",
        ].join("\n"),
      ),
    );
    expect(match).toBeNull();
  });

  it("does NOT fire on a polite rejection that is not an opt-out", () => {
    expect(applyRules(reply("Not for me, thanks."))).toBeNull();
    expect(applyRules(reply("I'll pass on this one."))).toBeNull();
    expect(applyRules(reply("We're not covering fintech this quarter."))).toBeNull();
  });
});

describe("applyRules — auto-reply detection", () => {
  const autos = [
    "I am out of the office until 5 March with limited access to email.",
    "Automatic reply: Annual leave",
    "This is an automated response. Your ticket has been logged.",
    "I'm currently away from my desk and will reply on my return.",
  ];

  for (const body of autos) {
    it(`locks to auto_reply: ${JSON.stringify(body.slice(0, 40))}`, () => {
      expect(applyRules(reply(body))?.intent).toBe("auto_reply");
    });
  }

  it("classifies an enthusiastic out-of-office as auto_reply, not interested", () => {
    const match = applyRules(
      reply(
        "I am out of the office until the 5th. This sounds great though - do email me again!",
      ),
    );
    expect(match?.intent).toBe("auto_reply");
  });
});

describe("applyRules — precedence", () => {
  it("prefers unsubscribe over auto_reply when both fire", () => {
    const match = applyRules(
      reply("Out of the office. Also please remove me from your list."),
    );
    expect(match?.intent).toBe("unsubscribe");
  });

  it("returns null when no rule fires, leaving it to the model", () => {
    expect(applyRules(reply("Can you send me the embargo date?"))).toBeNull();
  });
});

describe("applyRules — regressions found by the eval harness", () => {
  it("does not treat a human deferral that mentions leave as an auto-reply", () => {
    // The eval caught this: /on (annual )?leave/ locked a real reply to
    // auto_reply, and a rule lock cannot be undone by the model.
    const match = applyRules(
      reply("I'm on leave from tomorrow, send this again in March."),
    );
    expect(match).toBeNull();
  });

  it("still catches the stock annual-leave auto-reply", () => {
    const match = applyRules(
      reply("I am on annual leave and will respond on my return."),
    );
    expect(match?.intent).toBe("auto_reply");
  });
});
