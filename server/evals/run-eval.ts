/**
 * Eval harness for the triage pipeline.
 *
 * Two modes:
 *   --rules-only   Runs only the deterministic guardrails. No API key, no cost,
 *                  so CI can gate on it. Asserts the rules never lock a reply to
 *                  the wrong intent — an over-eager rule is unfixable downstream,
 *                  because the model is not allowed to unlock it.
 *   (default)      Runs the full pipeline against the real model and reports
 *                  per-class precision/recall plus a confusion matrix.
 *
 * Gates are release criteria from SPEC.md section 7, not warnings. A failure
 * exits non-zero.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "../src/env.js";
import { z } from "zod";
import { applyRules } from "../src/rules.js";
import { createClaudeClassifier } from "../src/classify.js";
import { triage } from "../src/triage.js";
import {
  INTENTS,
  IntentSchema,
  InboundReplySchema,
  type Intent,
} from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const CaseSchema = z.object({
  id: z.string(),
  expected: IntentSchema,
  note: z.string(),
  reply: InboundReplySchema,
});
type EvalCase = z.infer<typeof CaseSchema>;

const ACCURACY_GATE = 0.85;

function loadCases(): EvalCase[] {
  const raw = readFileSync(path.join(here, "golden.jsonl"), "utf8");
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line, i) => {
      const parsed = CaseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(
          `golden.jsonl line ${i + 1} is invalid: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });
}

/** Bounded concurrency — enough to be quick, not enough to trip rate limits. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = cursor++;
        const item = items[i];
        if (item === undefined) return;
        results[i] = await fn(item, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface Outcome {
  id: string;
  note: string;
  expected: Intent;
  actual: Intent | null;
  lockedByRule: boolean;
  ruleMatched: string | null;
  confidence: number | null;
  error: string | null;
}

function confusionMatrix(outcomes: Outcome[]): string {
  const width = 13;
  const pad = (s: string) => s.padEnd(width).slice(0, width);
  const header = ["expected/got".padEnd(16), ...INTENTS.map((i) => pad(i))].join(
    "",
  );
  const rows = INTENTS.map((expected) => {
    const cells = INTENTS.map((got) => {
      const n = outcomes.filter(
        (o) => o.expected === expected && o.actual === got,
      ).length;
      return pad(n === 0 ? "." : String(n));
    });
    return [expected.padEnd(16), ...cells].join("");
  });
  return [header, ...rows].join("\n");
}

function perClass(outcomes: Outcome[]) {
  return INTENTS.map((intent) => {
    const tp = outcomes.filter(
      (o) => o.expected === intent && o.actual === intent,
    ).length;
    const fp = outcomes.filter(
      (o) => o.expected !== intent && o.actual === intent,
    ).length;
    const fn = outcomes.filter(
      (o) => o.expected === intent && o.actual !== intent,
    ).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 =
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
    return { intent, support: tp + fn, precision, recall, f1 };
  });
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function runRulesOnly(cases: EvalCase[]): number {
  console.log(`Rules-only eval over ${cases.length} cases (no API calls).\n`);

  const falseLocks: Array<{ c: EvalCase; got: Intent; rule: string }> = [];
  let locked = 0;

  for (const c of cases) {
    const match = applyRules(c.reply);
    if (!match) continue;
    locked++;
    if (match.intent !== c.expected) {
      falseLocks.push({ c, got: match.intent, rule: match.rule });
    }
  }

  const optOuts = cases.filter((c) => c.expected === "unsubscribe");
  const optOutsCaught = optOuts.filter(
    (c) => applyRules(c.reply)?.intent === "unsubscribe",
  );

  console.log(`Locked by a rule:         ${locked}/${cases.length}`);
  console.log(
    `Opt-outs caught by rules: ${optOutsCaught.length}/${optOuts.length}` +
      ` (the rest must be caught by the model)`,
  );
  console.log(`False locks:              ${falseLocks.length}\n`);

  if (falseLocks.length > 0) {
    console.log("FAIL - a rule locked a reply to the wrong intent:\n");
    for (const { c, got, rule } of falseLocks) {
      console.log(
        `  ${c.id}  expected ${c.expected}, rule forced ${got}  [${rule}]`,
      );
      console.log(`         note: ${c.note}`);
      console.log(`         body: ${JSON.stringify(c.reply.body.slice(0, 90))}\n`);
    }
    console.log(
      "A false lock cannot be recovered downstream: the model is not permitted\n" +
        "to unlock a rule verdict. Tighten the rule.",
    );
    return 1;
  }

  console.log("PASS - no rule locks a reply to the wrong intent.");
  return 0;
}

async function runFull(cases: EvalCase[]): Promise<number> {
  // Fail fast rather than reporting a meaningless score. Without credentials
  // every model call errors, only the rule-locked cases resolve, and the summary
  // reads "28.6% accuracy, 2 missed opt-outs" — which blames the classifier for
  // a missing config file.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      [
        "No ANTHROPIC_API_KEY found.",
        "",
        "The full eval calls the real model. Copy .env.example to .env in the",
        "repo root, add your key, then run this again.",
        "",
        "For the offline guardrail gate, which needs no key: npm run eval:rules",
      ].join("\n"),
    );
    return 1;
  }

  const model = process.env.TRIAGE_MODEL ?? "claude-opus-5";
  console.log(`Full eval over ${cases.length} cases using ${model}.\n`);

  const classify = createClaudeClassifier({ model });

  const outcomes = await mapPool(cases, 4, async (c): Promise<Outcome> => {
    try {
      const result = await triage(c.reply, classify);
      return {
        id: c.id,
        note: c.note,
        expected: c.expected,
        actual: result.intent,
        lockedByRule: result.locked_by_rule,
        ruleMatched: result.rule_matched,
        confidence: result.confidence,
        error: null,
      };
    } catch (error) {
      return {
        id: c.id,
        note: c.note,
        expected: c.expected,
        actual: null,
        lockedByRule: false,
        ruleMatched: null,
        confidence: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const correct = outcomes.filter((o) => o.actual === o.expected).length;
  const accuracy = correct / outcomes.length;

  console.log(confusionMatrix(outcomes));
  console.log("");
  console.log("intent          support  precision  recall   f1");
  for (const m of perClass(outcomes)) {
    console.log(
      `${m.intent.padEnd(15)} ${String(m.support).padEnd(8)} ${pct(m.precision).padEnd(10)} ` +
        `${pct(m.recall).padEnd(8)} ${pct(m.f1)}`,
    );
  }
  console.log(`\nOverall accuracy: ${pct(accuracy)} (${correct}/${outcomes.length})`);

  const misses = outcomes.filter((o) => o.actual !== o.expected);
  if (misses.length > 0) {
    console.log("\nMisses:");
    for (const m of misses) {
      console.log(
        `  ${m.id}  expected ${m.expected}, got ${m.actual ?? `ERROR (${m.error})`}` +
          `${m.lockedByRule ? ` [locked by ${m.ruleMatched}]` : ""}`,
      );
      console.log(`         ${m.note}`);
    }
  }

  // --- release gates (SPEC.md section 7) ---
  const missedOptOuts = outcomes.filter(
    (o) => o.expected === "unsubscribe" && o.actual !== "unsubscribe",
  );
  const autoAsHuman = outcomes.filter(
    (o) =>
      o.expected === "auto_reply" && o.actual !== null && o.actual !== "auto_reply",
  );

  const gates = [
    {
      name: "zero missed opt-outs",
      ok: missedOptOuts.length === 0,
      detail: `${missedOptOuts.length} missed`,
    },
    {
      name: "no auto-reply read as human",
      ok: autoAsHuman.length === 0,
      detail: `${autoAsHuman.length} misread`,
    },
    {
      name: `accuracy >= ${pct(ACCURACY_GATE)}`,
      ok: accuracy >= ACCURACY_GATE,
      detail: pct(accuracy),
    },
  ];

  console.log("\nRelease gates:");
  for (const g of gates) {
    console.log(`  ${g.ok ? "PASS" : "FAIL"}  ${g.name}  (${g.detail})`);
  }

  writeFileSync(
    path.join(here, "..", "..", "eval-report.json"),
    JSON.stringify({ model, accuracy, outcomes, gates }, null, 2),
    "utf8",
  );
  console.log("\nWrote eval-report.json");

  return gates.every((g) => g.ok) ? 0 : 1;
}

const cases = loadCases();
const rulesOnly = process.argv.includes("--rules-only");
process.exit(rulesOnly ? runRulesOnly(cases) : await runFull(cases));
