# Pitch Triage — product spec

Status: v0.1, implemented
Owner: Awab Ali

## 1. Problem

A PR consultant sends a pitch to a list of journalists. Replies come back into a
shared inbox over the following days. Today a human opens every reply and decides
one of a small number of things: book the call, answer the question, snooze it,
drop it, or suppress the contact.

That reading step is the bottleneck. It is also where the expensive mistakes
happen, and the mistakes are **not** symmetric:

| Missed | Cost |
|---|---|
| An opt-out request | Compliance exposure. The contact keeps getting mail they asked to stop. Worst case on the list. |
| An interested reply | A lost booking. Recoverable if caught within a day or two. |
| A question | Looks unresponsive. Mildly damaging. |
| A wrong-beat reply | Near zero. It was never going anywhere. |

The asymmetry is the whole design. A classifier that is 95% accurate overall but
misses one opt-out in twenty is **worse than useless** here, because the one class
that must never be wrong is the one that carries legal weight.

## 2. What this is

A triage service that reads an inbound reply and proposes an action, with a
human approving before anything leaves the building.

```
inbound reply
      │
      ▼
[1] deterministic rules ──── opt-out detected? ──► LOCKED to unsubscribe
      │                                             (model cannot override)
      ▼
[2] Claude classifier ────► intent + confidence + extracted fields + draft
      │
      ▼
[3] merge  ── rules win on the compliance-critical class, model fills the rest
      │
      ▼
[4] review queue ────► human approves / edits / rejects
      │
      ▼
    send  (behind FLAG_AUTO_SEND, currently off)
```

## 3. Intent taxonomy

Six classes. Chosen so that every reply lands in exactly one, and so that the
routing decision differs for each — a class that routes identically to another
class is not worth having.

| Intent | Definition | Routing |
|---|---|---|
| `interested` | Wants the story, the interview, or the assets. | Draft a meeting offer. High priority. |
| `needs_info` | Will not commit until a specific question is answered. | Draft an answer citing the release. |
| `not_now` | Interested in principle, wrong timing. | Snooze; capture `follow_up_date` if stated. |
| `not_relevant` | Wrong beat, wrong outlet, wrong region. | Close. Consider list hygiene. |
| `unsubscribe` | Asks to stop being contacted. | **Suppress permanently. Hard stop.** |
| `auto_reply` | Machine-generated: out-of-office, ticket ack, bounce. | Not a human response. Re-queue for after the return date. |

### Edge cases the taxonomy must survive

These are in the golden dataset because each one broke a naive version:

1. **Out-of-office containing enthusiasm** — "I'm out until the 5th, but this sounds
   great, do email me again" is `auto_reply`, not `interested`. A human did not read it.
2. **Polite rejection vs. opt-out** — "Not for me, thanks" is `not_relevant`.
   "Not for me, and please take me off this list" is `unsubscribe`. The difference
   is a suppression flag on a real contact record.
3. **Opt-out phrased without the word unsubscribe** — "stop emailing me",
   "remove me from your list", "do not contact me again". All `unsubscribe`.
4. **Question that is really a rejection** — "What's the angle for our readers?"
   is `needs_info`. It is a genuine opening, not a brush-off.
5. **Deferral with a date** — "circle back in Q3" is `not_now` with an extracted
   follow-up date, not `not_relevant`.

## 4. Guardrails — where I do not trust the model

The classifier is a language model. It is very good at this task and it is not
deterministic. For the class that carries legal weight, "very good" is the wrong
guarantee, so the compliance path does not depend on the model at all:

- A deterministic phrase matcher runs **before** the model, on every reply.
- If it fires, the intent is **locked** to `unsubscribe`. The model's answer is
  recorded for observability but cannot change the outcome.
- The model may **escalate** into `unsubscribe` (it catches phrasings the rules
  miss). It may never **de-escalate** out of a rule-detected opt-out.
- `auto_reply` detection also runs deterministically, because an auto-reply
  classified as a human intent pollutes every downstream metric.

This is deliberately a ratchet: rules and model can each only ever make the
outcome *more* conservative, never less.

## 5. Non-goals for v0.1

Scoping this down is most of the work. Explicitly **not** in scope:

- Actually sending email. There is no SMTP path. `FLAG_AUTO_SEND` exists, defaults
  off, and gates a code path that is not finished — it ships dark.
- Inbox connection (IMAP/Gmail/Nylas). Replies arrive by `POST`.
- A database. The queue is in-memory and resets on restart.
- Auth, multi-tenancy, threading, attachments, multi-language.
- Sentiment scoring or lead scoring. Intent is the decision that matters.

## 6. Model choice

Default `claude-opus-5`, configurable via `TRIAGE_MODEL`.

The honest tradeoff: this is short-text classification, which a smaller model
handles well, and Haiku would cut per-reply cost by roughly 5x. I defaulted to
Opus anyway for v0.1 because the accuracy bar on `unsubscribe` and the
`auto_reply` traps is the thing under test, and I would rather establish the
ceiling first and then measure what a cheaper model gives up.

**The eval harness is what makes that a decision rather than a guess** — swap
`TRIAGE_MODEL`, re-run `npm run eval`, and compare. That comparison is the first
thing I would do with a second evening.

Structured output is enforced with the SDK's `zodOutputFormat`, so a malformed
response is a parse failure rather than a bad routing decision.

## 7. Acceptance criteria

Release gates, enforced by `npm run eval` and CI:

- [x] **Zero missed opt-outs** on the golden set. Any `unsubscribe` classified as
      something else fails the build. This is a hard gate, not a threshold.
- [x] Overall accuracy ≥ 85% across all six classes.
- [x] No `auto_reply` is classified as a human intent.
- [x] Every classification carries a confidence score and the rationale.
- [x] Nothing sends without explicit human approval.
- [x] Rule-locked outcomes are marked as such in the API response, so a reviewer
      can see *why* an item was suppressed.

## 8. Interfaces

```
POST /api/replies          ingest one reply, run triage, add to queue
GET  /api/queue            list items awaiting review
POST /api/queue/:id/approve  approve (records the reviewer's final intent)
POST /api/queue/:id/reject   reject, with an optional corrected intent
GET  /api/health           liveness + which flags are on
```

A rejected item with a corrected intent is the training signal for the next
version of the golden set. That is the intended feedback loop: reviewer
corrections become eval cases.
