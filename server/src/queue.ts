import { randomUUID } from "node:crypto";
import type { InboundReply, Intent, QueueItem, TriageResult } from "./types.js";

/**
 * In-memory review queue.
 *
 * Deliberately not a database — see SPEC.md section 5. Everything resets on
 * restart, which is fine for v0.1 and keeps the demo to one process.
 */
export class ReviewQueue {
  private items = new Map<string, QueueItem>();

  add(reply: InboundReply, triage: TriageResult): QueueItem {
    const item: QueueItem = {
      id: randomUUID(),
      reply,
      triage,
      status: "pending",
      reviewer_intent: null,
      received_at: new Date().toISOString(),
    };
    this.items.set(item.id, item);
    return item;
  }

  get(id: string): QueueItem | undefined {
    return this.items.get(id);
  }

  /**
   * Pending items first, and within those the ones a human should look at
   * soonest: rule/model disagreements, then low confidence, then newest.
   */
  list(): QueueItem[] {
    return [...this.items.values()].sort((a, b) => {
      const pending = Number(b.status === "pending") - Number(a.status === "pending");
      if (pending !== 0) return pending;

      const disagreement =
        Number(b.triage.disagreement) - Number(a.triage.disagreement);
      if (disagreement !== 0) return disagreement;

      const confidence = a.triage.confidence - b.triage.confidence;
      if (confidence !== 0) return confidence;

      return b.received_at.localeCompare(a.received_at);
    });
  }

  /**
   * Record a human decision. `correctedIntent` on a rejection is the point of
   * the whole loop — a reviewer disagreeing with the classifier is exactly the
   * case the golden set is missing. See SPEC.md section 8.
   */
  decide(
    id: string,
    status: "approved" | "rejected",
    correctedIntent: Intent | null = null,
  ): QueueItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;

    const updated: QueueItem = {
      ...item,
      status,
      reviewer_intent: correctedIntent ?? item.triage.intent,
    };
    this.items.set(id, updated);
    return updated;
  }

  /** Reviewer corrections, ready to be appended to golden.jsonl. */
  corrections(): Array<{ reply: InboundReply; expected: Intent; was: Intent }> {
    return this.list()
      .filter(
        (i) =>
          i.status === "rejected" &&
          i.reviewer_intent !== null &&
          i.reviewer_intent !== i.triage.intent,
      )
      .map((i) => ({
        reply: i.reply,
        expected: i.reviewer_intent as Intent,
        was: i.triage.intent,
      }));
  }
}
