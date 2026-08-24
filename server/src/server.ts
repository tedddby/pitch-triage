import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { createClaudeClassifier, ClassificationError } from "./classify.js";
import { triage } from "./triage.js";
import { ReviewQueue } from "./queue.js";
import { loadFlags } from "./flags.js";
import { InboundReplySchema, IntentSchema } from "./types.js";

const flags = loadFlags();
const queue = new ReviewQueue();
const classify = createClaudeClassifier();

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: process.env.TRIAGE_MODEL ?? "claude-opus-5",
    flags,
  });
});

/** Ingest one reply, triage it, and put it in front of a human. */
app.post("/api/replies", async (req, res) => {
  const parsed = InboundReplySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid reply", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await triage(parsed.data, classify);
    const item = queue.add(parsed.data, result);
    res.status(201).json(item);
  } catch (error) {
    if (error instanceof ClassificationError) {
      // Retryable failures are the caller's to retry; permanent ones are ours.
      res.status(error.retryable ? 503 : 500).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Triage failed" });
  }
});

app.get("/api/queue", (_req, res) => {
  res.json({ items: queue.list() });
});

const DecisionSchema = z.object({
  corrected_intent: IntentSchema.nullish(),
});

app.post("/api/queue/:id/approve", (req, res) => {
  const id = req.params.id;
  const item = queue.decide(id, "approved");
  if (!item) {
    res.status(404).json({ error: "No such queue item" });
    return;
  }

  if (flags.autoSend) {
    // Ships dark. There is no SMTP path yet, and the whole point of the review
    // gate is that a human presses send. Merged so the seam exists and the
    // approval response already carries the field the UI will read.
    res.status(501).json({ error: "Auto-send is not implemented yet.", item });
    return;
  }

  res.json({ item, sent: false, note: "Approved. Send it from your own inbox." });
});

app.post("/api/queue/:id/reject", (req, res) => {
  const parsed = DecisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid decision", details: parsed.error.flatten() });
    return;
  }

  const item = queue.decide(req.params.id, "rejected", parsed.data.corrected_intent ?? null);
  if (!item) {
    res.status(404).json({ error: "No such queue item" });
    return;
  }
  res.json({ item });
});

/** Reviewer corrections, shaped for appending to the golden set. */
app.get("/api/corrections", (_req, res) => {
  res.json({ corrections: queue.corrections() });
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`pitch-triage API on http://localhost:${port}`);
  console.log(`flags: ${JSON.stringify(flags)}`);
});
