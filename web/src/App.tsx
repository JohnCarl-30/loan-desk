import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Meeting = { booked: boolean; startsAt: string | null };

type LeadRow = {
  id: string;
  externalId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  errorField: string | null;
  fullName: string | null;
  phoneRedacted: string | null;
  phoneE164?: string | null;
  loanAmountCents: number | null;
  loanAmountUsd: string | null;
  purpose: string | null;
  timeline: string | null;
  creditBand: string | null;
  meeting: Meeting;
  source: string;
  promptVersion: string | null;
  droppedFields: string[];
  crmStatus: string | null;
  crmAttempts: number;
  createdAt: string;
  updatedAt: string;
  transcript?: string | null;
  extractedJson?: string | null;
  rawPayload?: string | null;
  crmRequest?: string | null;
  crmResponse?: string | null;
};

type Page = "leads" | "call";

export function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const detailId = hash.startsWith("#/leads/") ? hash.slice("#/leads/".length) : null;
  const page: Page = hash.startsWith("#/call") ? "call" : "leads";

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">LoanDesk</div>
        <div className="brand-sub">Mapping failures are rows, not logs.</div>
        <nav className="nav">
          <button className={page === "leads" && !detailId ? "on" : ""} onClick={() => (location.hash = "#/")}>
            Leads
          </button>
          <button className={page === "call" ? "on" : ""} onClick={() => (location.hash = "#/call")}>
            Run a call
          </button>
        </nav>
      </aside>
      <main className="main">
        {page === "call" ? <CallPage /> : detailId ? <LeadDetail id={detailId} /> : <LeadList />}
      </main>
    </div>
  );
}

function LeadList() {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/leads")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<LeadRow[]>;
      })
      .then(setLeads)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "load failed"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () => (filter === "failed" ? leads.filter((l) => l.status === "mapping_failed") : leads),
    [leads, filter],
  );

  return (
    <>
      <div className="top">
        <div>
          <h1>Leads</h1>
          <div className="hint">Failed mappings stay red. The desk does not swallow 4xx.</div>
        </div>
        <div>
          <button className={filter === "all" ? "primary" : "ghost"} onClick={() => setFilter("all")}>
            All
          </button>{" "}
          <button className={filter === "failed" ? "primary" : "ghost"} onClick={() => setFilter("failed")}>
            Failed mappings
          </button>
        </div>
      </div>
      {err ? <div className="err-banner">{err}</div> : null}
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Name</th>
            <th>Amount</th>
            <th>Error</th>
            <th>CRM</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No leads yet. POST /webhooks/lead or run a call.
              </td>
            </tr>
          ) : (
            rows.map((lead) => (
              <tr
                key={lead.id}
                className={`click ${lead.status === "mapping_failed" ? "fail" : ""}`}
                onClick={() => (location.hash = `#/leads/${lead.id}`)}
              >
                <td>
                  <span className={`badge ${badgeClass(lead.status)}`}>{lead.status}</span>
                </td>
                <td>
                  {lead.fullName ?? "—"}
                  <div className="muted">{lead.phoneRedacted ?? lead.externalId}</div>
                </td>
                <td className="mono">{lead.loanAmountUsd ?? "—"}</td>
                <td className="code">{lead.errorCode ?? ""}</td>
                <td>
                  <span className={`badge ${badgeClass(lead.crmStatus ?? "")}`}>{lead.crmStatus ?? "—"}</span>
                </td>
                <td className="muted">{lead.createdAt.slice(0, 19).replace("T", " ")}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

function LeadDetail({ id }: { id: string }) {
  const [lead, setLead] = useState<LeadRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/leads/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<LeadRow>;
      })
      .then(setLead)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "load failed"));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function retry() {
    const res = await fetch(`/api/leads/${id}/crm-retry`, { method: "POST" });
    if (!res.ok) {
      setErr(await res.text());
      return;
    }
    setLead((await res.json()) as LeadRow);
  }

  if (err && !lead) return <div className="err-banner">{err}</div>;
  if (!lead) return <p className="muted">Loading…</p>;

  return (
    <>
      <button className="back" onClick={() => (location.hash = "#/")}>
        ← Leads
      </button>
      {lead.status === "mapping_failed" ? (
        <div className="err-banner">
          {lead.errorCode}
          {lead.errorField ? ` · ${lead.errorField}` : ""} · {lead.errorMessage}
        </div>
      ) : null}
      <div className="top">
        <h1>{lead.fullName ?? lead.externalId}</h1>
        <span className={`badge ${badgeClass(lead.status)}`}>{lead.status}</span>
      </div>
      <div className="grid">
        <div className="card">
          <h2>Extracted fields</h2>
          <dl className="dl">
            <dt>Phone</dt>
            <dd className="mono">{lead.phoneE164 ?? lead.phoneRedacted ?? "—"}</dd>
            <dt>Amount (cents)</dt>
            <dd className="mono">{lead.loanAmountCents ?? "—"}</dd>
            <dt>Amount (USD)</dt>
            <dd>{lead.loanAmountUsd ?? "—"}</dd>
            <dt>Purpose</dt>
            <dd>{lead.purpose ?? "—"}</dd>
            <dt>Timeline</dt>
            <dd>{lead.timeline ?? "—"}</dd>
            <dt>Credit band</dt>
            <dd>{lead.creditBand ?? "—"}</dd>
            <dt>Meeting</dt>
            <dd className="mono">
              {lead.meeting.booked ? "booked" : "not booked"}
              {lead.meeting.startsAt ? ` · ${lead.meeting.startsAt}` : ""}
            </dd>
            <dt>Dropped fields</dt>
            <dd className="mono">{lead.droppedFields.length ? lead.droppedFields.join(", ") : "none"}</dd>
          </dl>
          <div className="row-actions">
            <button className="ghost" onClick={retry}>
              Retry CRM post
            </button>
          </div>
        </div>
        <div className="card">
          <h2>CRM</h2>
          <dl className="dl">
            <dt>Status</dt>
            <dd>{lead.crmStatus}</dd>
            <dt>Attempts</dt>
            <dd>{lead.crmAttempts}</dd>
          </dl>
          <h2 style={{ marginTop: 16 }}>CRM request</h2>
          <pre>{pretty(lead.crmRequest)}</pre>
          <h2 style={{ marginTop: 16 }}>CRM response</h2>
          <pre>{lead.crmResponse ?? "—"}</pre>
        </div>
        <div className="card">
          <h2>Transcript</h2>
          <pre>{lead.transcript ?? "—"}</pre>
        </div>
        <div className="card">
          <h2>Raw inbound payload</h2>
          <pre>{pretty(lead.rawPayload)}</pre>
        </div>
      </div>
    </>
  );
}

type Turn = { role: "assistant" | "user"; content: string };

function CallPage() {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [streamBuf, setStreamBuf] = useState("");
  const started = useRef(false);

  async function send(end = false, nextMessages?: Turn[]) {
    const payload = nextMessages ?? messages;
    setBusy(true);
    setStreamBuf("");
    const res = await fetch("/api/calls/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: payload, end }),
    });
    if (!res.body) {
      setBusy(false);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembled = "";
    let doneLead: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const json: unknown = JSON.parse(line.slice(5).trim());
        if (json && typeof json === "object" && "type" in json) {
          const ev = json as { type: string; text?: string; leadId?: string };
          if (ev.type === "token" && ev.text) {
            assembled += ev.text;
            setStreamBuf(assembled);
          }
          if (ev.type === "done" && ev.leadId) doneLead = ev.leadId;
        }
      }
    }
    if (assembled) {
      setMessages([...payload, { role: "assistant", content: assembled }]);
    }
    setStreamBuf("");
    if (doneLead) setLeadId(doneLead);
    setBusy(false);
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void send(false, []);
  }, []);

  return (
    <>
      <div className="top">
        <div>
          <h1>Run a call</h1>
          <div className="hint">Same sanitize path as POST /webhooks/voice. No voice provider key required.</div>
        </div>
        {leadId ? (
          <button className="primary" onClick={() => (location.hash = `#/leads/${leadId}`)}>
            Open lead
          </button>
        ) : (
          <button className="ghost" disabled={busy} onClick={() => void send(true)}>
            End call and map
          </button>
        )}
      </div>
      <div className="call">
        <div className="turns">
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.content}
            </div>
          ))}
          {streamBuf ? <div className="bubble assistant">{streamBuf}</div> : null}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text || busy) return;
            const next: Turn[] = [...messages, { role: "user", content: text }];
            setMessages(next);
            setDraft("");
            void send(false, next);
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Alex Rivera. 415-555-0100. Looking at $450,000 to purchase in 45 days. Credit is good."
            disabled={busy || Boolean(leadId)}
          />
          <button className="primary" type="submit" disabled={busy || Boolean(leadId)}>
            Send
          </button>
        </form>
      </div>
    </>
  );
}

function badgeClass(status: string): string {
  if (status.includes("fail") || status === "mapping_failed" || status === "rejected") return "fail";
  if (status.includes("posted") || status === "qualified" || status === "crm_local") return "ok";
  return "warn";
}

function pretty(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
