# Pitch Triage

Inbound reply triage for a PR consultancy. A journalist replies to a pitch; this
reads the reply, decides what should happen to it, drafts a response, and puts
the whole thing in front of a human. Nothing sends automatically.

Built with [Claude Code](https://claude.com/claude-code) doing most of the
typing. [`SPEC.md`](SPEC.md) is the spec I wrote before any code existed.
[`AI-LOG.md`](AI-LOG.md) is the honest record of how I directed it and the four
things it got wrong.

---

## Why this shape

Reading replies is the bottleneck in a pitch campaign, and the cost of getting one
wrong is wildly uneven:

- Miss an **opt-out** and you have a compliance problem.
- Miss an **interested** reply and you lose a booking.
- Miss a **wrong-beat** reply and you lose nothing at all.

So the design is not "classify accurately". It is **never get the expensive one
wrong**. A deterministic rule detects opt-out language and locks the outcome
before the model is consulted. The model can escalate *into* `unsubscribe`, but
it cannot pull a reply out of one. Rules and model can each only make the verdict
more conservative, never less.

```
inbound reply
      │
      ▼
[1] deterministic rules ──── opt-out detected? ──► LOCKED to unsubscribe
      │                                             (model cannot override)
      ▼
[2] Claude classifier ────► intent + confidence + fields + draft reply
      │
      ▼
[3] merge  ── rule wins on the compliance-critical class
      │
      ▼
[4] review queue ────► human approves, or rejects with a correction
      │
      ▼
    send  (behind FLAG_AUTO_SEND — off, unfinished, ships dark)
```

Six intents: `interested`, `needs_info`, `not_now`, `not_relevant`,
`unsubscribe`, `auto_reply`. Definitions and edge cases in
[`SPEC.md`](SPEC.md#3-intent-taxonomy).

---

## Running it

Needs Node 20+ and an [Anthropic API key](https://console.anthropic.com/settings/keys).

```bash
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY

npm run dev                 # API on :4000
npm run dev:web             # review queue on :3000  (second terminal)
```

Open <http://localhost:3000>, paste a reply, press Triage.

Replies worth trying, in order:

| Paste this | What should happen |
|---|---|
| `Yes please - send the report under embargo.` | `interested`, with a draft reply |
| `Not for me, thanks.` | `not_relevant`, no draft |
| `Not for me, and please take me off your list.` | `unsubscribe`, **locked by rule**, no draft |
| `I'm out of the office until the 5th. This sounds great though - do email me again!` | `auto_reply`, not `interested` — no human read it |
| `I'm on leave from tomorrow, send this again in March.` | `not_now` — this one used to be locked wrongly, see AI-LOG |

---

## Verifying it

```bash
npm test           # 43 unit tests
npm run eval:rules # guardrails against the golden set — no API key, no cost
npm run eval       # full pipeline against the real model — needs a key
npm run typecheck
```

`server/evals/golden.jsonl` holds **42 labelled replies**, weighted toward the
cases that break naive versions: an out-of-office that reads as enthusiastic, a
polite pass sitting next to a real opt-out, opt-outs with no keyword in them, and
replies whose quoted footer contains the word "unsubscribe".

`npm run eval` prints a confusion matrix and per-class precision/recall, then
checks three release gates from the spec:

- **zero missed opt-outs** — a hard gate, not a threshold
- no `auto_reply` classified as a human intent
- overall accuracy ≥ 85%

Failing any gate exits non-zero.

`npm run eval:rules` is the offline gate. It needs no key and no spend, and
asserts one thing: **the deterministic rules never lock a reply to the wrong
intent.** That property matters more than it sounds — a false lock cannot be
fixed downstream, because the model is not allowed to unlock a rule verdict. It
caught a real bug (see [`AI-LOG.md`](AI-LOG.md)).

Every check, run against the commit you are reading:

```
$ npm run typecheck
(clean, exit 0)

$ npm test
 Test Files  3 passed (3)
      Tests  43 passed (43)

$ npm run eval:rules
Rules-only eval over 42 cases (no API calls).

Locked by a rule:         12/42
Opt-outs caught by rules: 6/8 (the rest must be caught by the model)
False locks:              0

PASS - no rule locks a reply to the wrong intent.
```

There is no CI workflow in this repo. `eval:rules`, `test` and `typecheck` are
all designed to run without credentials precisely so they *can* be a pre-merge
gate — wiring them to a runner is a two-file change I would make on day one of
working somewhere that has one.

### Measured result

`claude-opus-5`, 42 cases, all three gates passing:

```
intent          support  precision  recall   f1
interested      8        87.5%      87.5%    87.5%
needs_info      7        85.7%      85.7%    85.7%
not_now         6        100.0%     100.0%   100.0%
not_relevant    7        100.0%     100.0%   100.0%
unsubscribe     8        100.0%     100.0%   100.0%
auto_reply      6        100.0%     100.0%   100.0%

Overall accuracy: 95.2% (40/42)

PASS  zero missed opt-outs           (0 missed)
PASS  no auto-reply read as human    (0 misread)
PASS  accuracy >= 85.0%              (95.2%)
```

The shape matters more than the headline. `unsubscribe` — the only class with
legal consequences — is 8/8. `auto_reply` is 6/6, including the out-of-office
that says *"this sounds great, do email me again"*.

Both errors fall on the same boundary, `interested` ↔ `needs_info`:

- *"I could use this for a piece I'm already writing. What's the embargo?"* —
  labelled `interested`, classified `needs_info`. They are committing and the
  question is secondary. A real miss.
- *"Do you have images we can use?"* — labelled `needs_info`, classified
  `interested`. "images **we can use**" presupposes they are running it. I now
  think the model was right and my label was wrong.

I have deliberately not tuned the prompt to clear these. One of the two is a
defect in my labelling rather than in the classifier, and forcing 42/42 on a set
this size is overfitting to the test. The distinction also costs little
operationally — both intents route to a human with a draft attached. The classes
where an error is expensive are the ones sitting at 100%, which is the result the
design was aiming at.

---

## What ships dark

`FLAG_AUTO_SEND` gates sending approved replies automatically. It is merged, it
is off, and the path behind it returns `501`. There is no SMTP integration and
the approval UX assumes a human presses send. The seam exists; the feature does
not pretend to.

Everything else deliberately left out — a database, inbox connection, auth,
threading — is listed in [`SPEC.md` section 5](SPEC.md#5-non-goals-for-v01).

---

## What I would do next

1. **Move `auto_reply` off the deterministic lock.** The ratchet argument that
   justifies hard-locking `unsubscribe` is a legal one. `auto_reply` is only
   metrics hygiene, so it does not earn the same treatment — and that mismatch is
   exactly what produced the false lock the eval caught.
2. **Measure a cheaper model.** The eval harness exists precisely so
   `TRIAGE_MODEL=claude-haiku-4-5 npm run eval` is a measurement rather than a
   guess. Short-text classification is where a smaller model should hold up.
3. **Close the correction loop automatically.** `GET /api/corrections` already
   returns reviewer disagreements shaped for `golden.jsonl`. Appending them is
   still manual.
4. **Confidence-based routing.** Everything goes to a human today. Once the eval
   shows a confidence threshold above which the classifier is reliable, low-risk
   intents could auto-file and leave humans the ambiguous ones.

---

## Layout

```
SPEC.md                    written before the code
AI-LOG.md                  how I drove Claude Code, and what it got wrong
server/src/rules.ts        deterministic guardrails (the part I don't trust the model with)
server/src/classify.ts     Claude call, structured output, system prompt
server/src/triage.ts       the merge — where the ratchet lives
server/src/queue.ts        in-memory review queue, ordered by "needs a human most"
server/evals/golden.jsonl  42 labelled replies
server/evals/run-eval.ts   confusion matrix + release gates
web/app/page.tsx           the review screen
```
