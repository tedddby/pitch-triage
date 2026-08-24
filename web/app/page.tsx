"use client";

import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

const INTENTS = [
  "interested",
  "needs_info",
  "not_now",
  "not_relevant",
  "unsubscribe",
  "auto_reply",
] as const;
type Intent = (typeof INTENTS)[number];

const INTENT_COLOUR: Record<Intent, string> = {
  interested: "#37d67a",
  needs_info: "#4aa3ff",
  not_now: "#e5b567",
  not_relevant: "#8b93a7",
  unsubscribe: "#ff5f5f",
  auto_reply: "#a97bff",
};

interface Triage {
  intent: Intent;
  confidence: number;
  rationale: string;
  follow_up_date: string | null;
  key_question: string | null;
  draft_reply: string;
  locked_by_rule: boolean;
  rule_matched: string | null;
  model_intent: Intent | null;
  disagreement: boolean;
  model_error: string | null;
}

interface QueueItem {
  id: string;
  reply: { from: string; subject: string; body: string; pitch_subject: string };
  triage: Triage;
  status: "pending" | "approved" | "rejected";
  reviewer_intent: Intent | null;
  received_at: string;
}

const card: React.CSSProperties = {
  background: "#171a21",
  border: "1px solid #262b36",
  borderRadius: 10,
  padding: 16,
  marginBottom: 12,
};

const input: React.CSSProperties = {
  width: "100%",
  background: "#0f1115",
  border: "1px solid #2b3140",
  borderRadius: 6,
  color: "#e7e9ee",
  padding: "8px 10px",
  fontSize: 14,
  fontFamily: "inherit",
  marginBottom: 8,
  boxSizing: "border-box",
};

function Badge({ text, colour }: { text: string; colour: string }) {
  return (
    <span
      style={{
        background: `${colour}22`,
        color: colour,
        border: `1px solid ${colour}55`,
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: 12,
        fontWeight: 600,
        marginRight: 8,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

export default function Page() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [body, setBody] = useState("");
  const [from, setFrom] = useState("journalist@outlet.example");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/queue`);
      const data = await res.json();
      setItems(data.items ?? []);
      setError(null);
    } catch {
      setError(`Cannot reach the API at ${API}. Is the server running?`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          subject: "Re: New fintech report",
          body,
          pitch_subject: "New fintech report: BNPL adoption in the Gulf",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}) as { error?: string });
        setError(err.error ?? `Triage failed (HTTP ${res.status})`);
      } else {
        setBody("");
        await load();
      }
    } catch {
      setError(`Cannot reach the API at ${API}.`);
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, action: "approve" | "reject", corrected?: Intent) {
    await fetch(`${API}/api/queue/${id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corrected ? { corrected_intent: corrected } : {}),
    });
    await load();
  }

  const pending = items.filter((i) => i.status === "pending");

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px 64px" }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Pitch Triage</h1>
      <p style={{ color: "#8b93a7", marginTop: 0, fontSize: 14 }}>
        Nothing sends automatically. Every item below is waiting on a human.
      </p>

      <section style={{ ...card, marginTop: 24 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Paste an inbound reply</h2>
        <input
          style={input}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="from"
        />
        <textarea
          style={{ ...input, minHeight: 90, resize: "vertical" }}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Thanks but please take me off this list."
        />
        <button
          onClick={submit}
          disabled={busy || !body.trim()}
          style={{
            background: busy ? "#2b3140" : "#4aa3ff",
            color: busy ? "#8b93a7" : "#06101d",
            border: "none",
            borderRadius: 6,
            padding: "9px 18px",
            fontWeight: 700,
            fontSize: 14,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Triaging..." : "Triage"}
        </button>
        {error && (
          <p style={{ color: "#ff5f5f", fontSize: 13, marginBottom: 0 }}>{error}</p>
        )}
      </section>

      <h2 style={{ fontSize: 15, margin: "28px 0 12px" }}>
        Review queue{" "}
        <span style={{ color: "#8b93a7", fontWeight: 400 }}>
          ({pending.length} pending)
        </span>
      </h2>

      {items.length === 0 && (
        <p style={{ color: "#8b93a7", fontSize: 14 }}>Nothing triaged yet.</p>
      )}

      {items.map((item) => {
        const t = item.triage;
        return (
          <article
            key={item.id}
            style={{ ...card, opacity: item.status === "pending" ? 1 : 0.55 }}
          >
            <div style={{ marginBottom: 10 }}>
              <Badge text={t.intent} colour={INTENT_COLOUR[t.intent]} />
              <Badge
                text={`${Math.round(t.confidence * 100)}% confident`}
                colour="#8b93a7"
              />
              {t.locked_by_rule && (
                <Badge text={`locked: ${t.rule_matched}`} colour="#ff9f43" />
              )}
              {t.disagreement && <Badge text="rule/model disagree" colour="#ff5f5f" />}
              {t.model_error && <Badge text="model unavailable" colour="#8b93a7" />}
              {item.status !== "pending" && (
                <Badge text={item.status} colour="#8b93a7" />
              )}
            </div>

            <div style={{ fontSize: 13, color: "#8b93a7", marginBottom: 6 }}>
              {item.reply.from}
            </div>
            <blockquote
              style={{
                margin: "0 0 10px",
                padding: "8px 12px",
                borderLeft: "3px solid #2b3140",
                whiteSpace: "pre-wrap",
                fontSize: 14,
              }}
            >
              {item.reply.body}
            </blockquote>

            <p style={{ fontSize: 13, color: "#b8bfd0", margin: "0 0 10px" }}>
              {t.rationale}
            </p>

            {t.follow_up_date && (
              <p style={{ fontSize: 13, color: "#e5b567", margin: "0 0 10px" }}>
                Follow up: {t.follow_up_date}
              </p>
            )}

            {t.draft_reply ? (
              <div
                style={{
                  background: "#0f1115",
                  border: "1px solid #2b3140",
                  borderRadius: 6,
                  padding: 12,
                  fontSize: 14,
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 12, color: "#8b93a7", marginBottom: 6 }}>
                  Suggested reply - edit before sending
                </div>
                {t.draft_reply}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: "#8b93a7", fontStyle: "italic" }}>
                No reply suggested for this intent.
              </p>
            )}

            {item.status === "pending" && (
              <div
                style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
              >
                <button
                  onClick={() => decide(item.id, "approve")}
                  style={{
                    background: "#37d67a22",
                    color: "#37d67a",
                    border: "1px solid #37d67a55",
                    borderRadius: 6,
                    padding: "6px 14px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Approve
                </button>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      void decide(item.id, "reject", e.target.value as Intent);
                    }
                  }}
                  style={{
                    background: "#0f1115",
                    color: "#e7e9ee",
                    border: "1px solid #2b3140",
                    borderRadius: 6,
                    padding: "6px 10px",
                    fontSize: 13,
                  }}
                >
                  <option value="">Reject - correct to...</option>
                  {INTENTS.filter((i) => i !== t.intent).map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </article>
        );
      })}
    </main>
  );
}
