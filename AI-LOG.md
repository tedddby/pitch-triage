# How this was built, and what the AI got wrong

Claude Code did most of the typing. This is the record of what I asked for, what
came back, and the four things I had to catch. It is the part of the exercise I
think actually matters — anyone can get an LLM to produce a working app; the
question is whether you noticed what it got wrong.

## How I drove it

**The spec came first, and it was the real work.** [`SPEC.md`](SPEC.md) existed
before any implementation. Not as documentation — as the thing that determined
the architecture. Once I'd written down that the cost of a missed opt-out is
categorically different from the cost of a missed lead, the design stopped being
"build a classifier" and became "build a system where the model is not allowed to
be wrong about one specific class". Every subsequent decision fell out of that
paragraph. If I'd started by prompting for a classifier, I'd have got a
classifier, and it would have been the wrong shape.

**I decomposed by risk, not by layer.** The guardrails went first, with tests,
because they are the part that must not be wrong. The model integration came
second. The UI came last and is deliberately one screen.

**Small commits, each one green.** Test commit, then implementation commit, on a
short-lived branch merged with `--no-ff`. The red→green pairs are visible in the
history on purpose. `main` builds and passes at every merge.

**I wrote the golden set by hand, from the problem.** This turned out to matter
more than any prompt I wrote — see mistake 3.

---

## Mistake 1 — an SDK method that doesn't exist

The first draft of the error handling used `Anthropic.APIStatusError`. That class
is in plenty of Anthropic examples but is not in the version of the SDK this
project installs (0.72), where it is `APIError`.

The compiler caught it immediately, which is the cheap case. The part worth
noting is what the compiler *couldn't* catch: my first working version checked
`APIError` before `APIConnectionError`. Since `APIConnectionError` extends
`APIError`, that ordering means every network failure gets classified by the
generic branch and marked non-retryable — a silent bug that types are blind to
and that no test I'd have thought to write would have found. I reordered it and
left a comment saying why, because the next person to add a branch will put it in
the wrong place otherwise.

**Fix:** `3b9d3cf` region of `server/src/classify.ts`.

## Mistake 2 — a rule that could never be corrected

I'd planted a case in the golden set: *"I'm on leave from tomorrow, send this
again in March."* That is a human deferring a pitch — `not_now`. But the
auto-reply rule matched `/on (annual )?leave/` and locked it to `auto_reply`.

The reason this one is bad, rather than merely wrong: the whole design says a
rule lock cannot be undone by the model. So that reply could never have been
routed correctly, no matter how good the classifier got. An over-eager rule is
strictly worse than a missing one.

The unit tests did not catch it, and I don't think they could have. I wrote those
tests from the same mental model that produced the rule, so they inherited its
blind spot — I tested the phrasings I'd thought of, using the reasoning that made
me write the pattern in the first place. The golden set caught it because I wrote
that from the *problem* (what do journalists actually send back?) rather than
from the *solution*.

The fix narrows the pattern, but the real conclusion is in the commit message and
the README: `auto_reply` should not be a deterministic lock at all. The argument
for hard-locking `unsubscribe` is legal. `auto_reply` is metrics hygiene, and it
does not earn the same guarantee.

**Found by:** `npm run eval:rules`. **Fix:** `d9d9a23`.

## Mistake 3 — 43 passing tests and a classifier that could never have worked

This is the one I'd want to be asked about.

At the point I had the API layer done, the state was: 43 unit tests passing,
typecheck clean, eval gate green, both workspaces building. By every signal I had
set up, it was finished.

Then I started the server and posted an actual reply to it, and got:

```
"model_error": "z.toJSONSchema is not a function"
```

`zodOutputFormat` calls `z.toJSONSchema`, which only exists on zod 4's root
export. The project was on zod 3.25. **Every single classification would have
failed** — not degraded, not been inaccurate, just thrown. In production it would
have been a total outage of the only feature that matters.

None of my tests touched it, and that was by design: the classifier is injected
as a function so tests can pass a stub, which is what lets CI run without an API
key. Good decision, and it bought me a blind spot exactly the size of the real
integration. The green suite was evidence that the code I wrote was consistent
with itself. It was never evidence that it worked.

Two things came out of this that I kept:

- The bug surfaced as `model_error` on a *successful* response rather than a
  crash, because a rule-locked reply is designed to survive the model being
  unavailable. That degraded path is a real property — I verified it separately
  by running the server with deliberately invalid credentials and confirming an
  opt-out still gets suppressed with the failure recorded. Compliance keeps
  working when the API is down.
- I now don't believe a green test suite about anything at the boundary of my own
  code. The check that found this was ten seconds of `curl`.

**Fix:** `3b9d3cf` — a dependency bump, no source change. The whole bug was a
version.

## Mistake 4 — the same lesson again, immediately

I fixed mistake 3, moved on, and walked straight into its sibling.

`npm run eval` reported **28.6% accuracy** and **"FAIL: 2 missed opt-outs"**. Read
plainly, that says the classifier is broken. It wasn't. Every model call had
failed with *"could not resolve authentication method"*, and the only cases that
scored were the twelve the rules resolve without the model at all.

Two separate bugs behind one confusing number:

1. `dotenv/config` resolves `.env` against `process.cwd()`. npm workspace scripts
   run with cwd set to the *workspace* directory, so `npm run eval` from the repo
   root looked for `server/.env` — while `.env.example`, and my own README
   instruction to copy it, both point at the repo root. The file would have been
   sitting right there and dotenv would never have seen it.
2. The eval had no credential check, so instead of refusing to run it produced a
   confident, precise, completely meaningless score.

The second is the worse bug. A harness whose entire job is telling you whether
you can trust the system reported a specific number for a run in which the system
under test never executed.

I'd missed the first one because every time I'd exercised the API path myself, I'd
passed the key inline as an environment variable. So `dotenv` — the mechanism a
real user hits on their first run — was never once executed. Same shape as mistake
3: the part I never actually ran was the part that was broken.

`env.ts` now resolves from the module's own location rather than cwd and reads
either location, and the eval fails fast with an actionable message instead of
scoring a run that didn't happen.

**Found by:** running the eval as a first-time user would. **Fix:**
`server/src/env.ts` and the guard at the top of `runFull`.

---

## What I'd tell you in an interview

The interesting failure mode of AI-assisted development isn't that the model
writes bad code. The code it wrote here is fine — better factored than my first
draft would have been. The failure mode is that it writes *confident, internally
consistent* code, and it will happily write the tests that agree with it. Both
artefacts share the same assumptions, so the tests can't see past them.

All four mistakes above were caught by something outside that loop: a compiler,
a dataset written from the problem instead of the solution, and running the thing
for real. That's where I ended up spending my attention, and it's the habit I'd
bring to a codebase where AI is doing most of the typing.
