import { useState, useEffect } from "react";
import * as api from "./api";
import "./App.css";

type Page = "submit" | "timeline" | "review" | "report" | "similar";

function Loader() {
  return <span className="loader" />;
}

export default function App() {
  const [page, setPage] = useState<Page>("submit");
  const [carryId, setCarryId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [token, setTokenState] = useState<string | null>(api.getToken());
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => { setTokenState(api.getToken()); }, []);

  const showError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("401") || msg.includes("UNAUTHORIZED") || msg.includes("Authentication required")) {
      api.setToken(null);
      setTokenState(null);
    }
    setError(msg);
    setLoading(false);
  };

  const nav = (p: Page) => { setPage(p); setError(""); setStatusMsg(""); };

  const handleToken = (t: string) => {
    api.setToken(t);
    setTokenState(t);
    setShowLogin(false);
  };

  const handleLogout = () => {
    api.setToken(null);
    setTokenState(null);
  };

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="header-icon">I</div>
          <h1>IncidentIQ</h1>
        </div>
        <nav>
          <button onClick={() => nav("submit")} className={page === "submit" ? "active" : ""}>Submit</button>
          <button onClick={() => nav("timeline")} className={page === "timeline" ? "active" : ""}>Timeline</button>
          <button onClick={() => nav("review")} className={page === "review" ? "active" : ""}>Review</button>
          <button onClick={() => nav("report")} className={page === "report" ? "active" : ""}>Report</button>
          <button onClick={() => nav("similar")} className={page === "similar" ? "active" : ""}>Search</button>
        </nav>
        <div className="auth-status">
          {token ? (
            <button className="auth-btn" onClick={handleLogout} title="Clear token">Logout</button>
          ) : (
            <button className="auth-btn" onClick={() => setShowLogin(!showLogin)} title="Set API token">Login</button>
          )}
        </div>
      </header>

      {showLogin && !token && <LoginForm onToken={handleToken} onError={showError} />}

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-banner">Loading...</div>}
      {statusMsg && <div className="status-banner">{statusMsg}</div>}

      <main>
        {page === "submit" && <SubmitPage onIncidentCreated={(id) => { setCarryId(id); setStatusMsg(`Incident ${id} created`); }} onError={showError} setLoading={setLoading} />}
        {page === "timeline" && <TimelinePage incidentId={carryId} onError={showError} setLoading={setLoading} setStatus={setStatusMsg} />}
        {page === "review" && <ReviewPage incidentId={carryId} onError={showError} setLoading={setLoading} setStatus={setStatusMsg} />}
        {page === "report" && <ReportPage incidentId={carryId} onError={showError} setLoading={setLoading} />}
        {page === "similar" && <SimilarPage onError={showError} setLoading={setLoading} />}
      </main>
    </div>
  );
}

function LoginForm(props: { onToken: (t: string) => void; onError: (e: unknown) => void }) {
  const [userId, setUserId] = useState("user-1");
  const [bootstrapKey, setBootstrapKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [pasteToken, setPasteToken] = useState("");

  const handleGenerate = async () => {
    if (!bootstrapKey.trim()) { props.onError(new Error("Bootstrap key is required")); return; }
    setLoading(true);
    try {
      const res = await api.generateToken(userId.trim(), bootstrapKey.trim());
      props.onToken(res.token);
    } catch (e) { props.onError(e); }
    setLoading(false);
  };

  const handlePaste = () => {
    if (!pasteToken.trim()) { props.onError(new Error("Paste a token")); return; }
    props.onToken(pasteToken.trim());
  };

  return (
    <div className="login-form">
      <div className="login-tabs">
        <div className="login-section">
          <h4>Generate Token</h4>
          <label>User ID<input value={userId} onChange={(e) => setUserId(e.target.value)} /></label>
          <label>Bootstrap Key<input type="password" value={bootstrapKey} onChange={(e) => setBootstrapKey(e.target.value)} placeholder="From admin" /></label>
          <button disabled={loading} onClick={handleGenerate}>{loading ? <><Loader /> Generating</> : "Generate"}</button>
        </div>
        <div className="login-divider"><span>or</span></div>
        <div className="login-section">
          <h4>Paste Token</h4>
          <label>Token<input value={pasteToken} onChange={(e) => setPasteToken(e.target.value)} placeholder="Paste existing token" /></label>
          <button onClick={handlePaste}>Use Token</button>
        </div>
      </div>
    </div>
  );
}

function SubmitPage(props: { onIncidentCreated: (id: string) => void; onError: (e: unknown) => void; setLoading: (v: boolean) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [result, setResult] = useState<api.Incident | null>(null);

  const handleSubmit = async () => {
    if (!title.trim() || !summary.trim()) { props.onError(new Error("Title and summary are required")); return; }
    setSubmitting(true);
    props.setLoading(true);
    try {
      const inc = await api.createIncident(title.trim(), summary.trim());
      setResult(inc);
      props.onIncidentCreated(inc.id);
    } catch (e) { props.onError(e); }
    setSubmitting(false);
    props.setLoading(false);
  };

  return (
    <section className="page">
      <h2>Submit Incident</h2>
      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Brief title" /></label>
        <label>Summary<textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Describe the incident" rows={4} /></label>
        <button type="submit" disabled={submitting}>{submitting ? <><Loader /> Submitting</> : "Create Incident"}</button>
      </form>
      {result && (
        <div className="card">
          <p><strong>ID:</strong> {result.id}</p>
          <p><strong>Status:</strong> {result.status}</p>
        </div>
      )}
    </section>
  );
}

function TimelinePage(props: { incidentId: string; onError: (e: unknown) => void; setLoading: (v: boolean) => void; setStatus: (v: string) => void }) {
  const [id, setId] = useState(props.incidentId);
  const [events, setEvents] = useState<{ timestamp: string; detail: string; source: string }[]>([]);
  const [ts, setTs] = useState("");
  const [detail, setDetail] = useState("");
  const [source, setSource] = useState("");
  const [report, setReport] = useState<api.Report | null>(null);

  const addEvent = () => {
    if (!detail.trim()) return;
    setEvents([...events, { timestamp: ts || "", detail: detail.trim(), source: source.trim() || "ui" }]);
    setTs(""); setDetail(""); setSource("");
  };

  const doAdd = async () => {
    if (!id.trim()) { props.onError(new Error("Enter an incident ID")); return; }
    for (const ev of events) {
      props.setLoading(true);
      try { await api.addEvent(id.trim(), ev.timestamp || null, ev.detail, ev.source); } catch (e) { props.onError(e); props.setLoading(false); return; }
      props.setLoading(false);
    }
    props.setStatus(`${events.length} event(s) added`);
    setEvents([]);
  };

  const doAnalyze = async () => {
    if (!id.trim()) { props.onError(new Error("Enter an incident ID")); return; }
    props.setLoading(true);
    try {
      await api.triggerAnalysis(id.trim());
      props.setStatus("Analysis started, polling...");
      const poll = async () => {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const r = await api.getReport(id.trim());
            if (r.status === "AwaitReview" || r.status === "Finalized") { setReport(r); props.setStatus(`Done: ${r.status}`); props.setLoading(false); return; }
          } catch { /* transient */ }
        }
        props.setStatus("Polling timed out");
        props.setLoading(false);
      };
      poll();
    } catch (e) { props.onError(e); props.setLoading(false); }
  };

  return (
    <section className="page">
      <h2>Timeline Entry</h2>
      <label>Incident ID<input value={id} onChange={(e) => setId(e.target.value)} placeholder="Paste incident ID" /></label>
      <div className="event-form">
        <input value={ts} onChange={(e) => setTs(e.target.value)} placeholder="Timestamp (ISO)" />
        <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Event detail *" />
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source" />
        <button onClick={addEvent}>Add Event</button>
      </div>
      {events.length > 0 && (
        <ul className="event-list">
          {events.map((e, i) => <li key={i}><strong>{e.timestamp || "?"}</strong> {e.detail} <em>({e.source})</em></li>)}
        </ul>
      )}
      <div className="actions">
        <button onClick={doAdd} disabled={events.length === 0}>Submit Events</button>
        <button onClick={doAnalyze}>Trigger Analysis</button>
      </div>
      {report && (
        <div className="card">
          <p><strong>Status:</strong> {report.status}</p>
          <p><strong>Timeline:</strong> {report.timeline.length} entries</p>
          <p><strong>Root Cause:</strong> {report.rootCause?.cause ?? "N/A"}</p>
          <p><strong>Recommendations:</strong> {report.recommendations.length}</p>
        </div>
      )}
    </section>
  );
}

function ReviewPage(props: { incidentId: string; onError: (e: unknown) => void; setLoading: (v: boolean) => void; setStatus: (v: string) => void }) {
  const [id, setId] = useState(props.incidentId);
  const [report, setReport] = useState<api.Report | null>(null);
  const [reviewerId, setReviewerId] = useState("user-1");
  const [modifications, setModifications] = useState("");
  const [rejectTarget, setRejectTarget] = useState("Validated");
  const [pendingList, setPendingList] = useState<api.IncidentSummary[] | null>(null);

  const loadPending = async () => {
    props.setLoading(true);
    try {
      const data = await api.listIncidents("AwaitReview");
      setPendingList(data.incidents);
    } catch (e) { props.onError(e); }
    props.setLoading(false);
  };

  const loadReport = async (incidentId?: string) => {
    const targetId = incidentId ?? id;
    if (!targetId.trim()) { props.onError(new Error("Enter an incident ID")); return; }
    setId(targetId);
    props.setLoading(true);
    try { setReport(await api.getReport(targetId.trim())); } catch (e) { props.onError(e); }
    props.setLoading(false);
  };

  const doApprove = async () => {
    if (!id.trim() || !reviewerId.trim()) return;
    props.setLoading(true);
    try {
      await api.submitReview(id.trim(), true, reviewerId.trim(), modifications.trim() || undefined);
      const r = await api.getReport(id.trim());
      setReport(r);
      setPendingList(null);
      props.setStatus("Approved! State: " + r.status);
    } catch (e) { props.onError(e); }
    props.setLoading(false);
  };

  const doReject = async () => {
    if (!id.trim() || !reviewerId.trim()) return;
    props.setLoading(true);
    try {
      await api.rejectReview(id.trim(), reviewerId.trim(), rejectTarget, modifications.trim() || undefined);
      const r = await api.getReport(id.trim());
      setReport(r);
      setPendingList(null);
      props.setStatus("Rejected. State: " + r.status);
    } catch (e) { props.onError(e); }
    props.setLoading(false);
  };

  return (
    <section className="page">
      <h2>Review Dashboard</h2>

      <details style={{ marginBottom: "1rem" }} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && pendingList === null) loadPending(); }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Pending AwaitReview Incidents</summary>
        {pendingList === null ? (
          <p style={{ color: "var(--text-muted)", padding: "0.5rem" }}>Loading...</p>
        ) : pendingList.length === 0 ? (
          <p style={{ color: "var(--text-muted)", padding: "0.5rem" }}>No incidents awaiting review.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {pendingList.map((inc) => (
              <li key={inc.id} style={{ padding: "0.5rem", borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                  onClick={() => loadReport(inc.id)}>
                <strong>{inc.title}</strong>
                <span style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginLeft: "0.5rem" }}>
                  {new Date(inc.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>

      <label>Incident ID<input value={id} onChange={(e) => setId(e.target.value)} placeholder="Paste incident ID" /></label>
      <button onClick={() => loadReport()}>Load Report</button>

      {report && (
        <>
          <div className="card">
            <p><strong>Status:</strong> {report.status} <span className={report.needsReview ? "tag-warn" : "tag-ok"}>{report.needsReview ? "Needs Review" : "Auto-approved"}</span></p>
            <p><strong>Title:</strong> {report.title}</p>
          </div>

          <h3>Timeline <span className="tag-ai">AI-generated</span></h3>
          <table className="data-table">
            <thead><tr><th>Time</th><th>Event</th><th>Confidence</th></tr></thead>
            <tbody>
              {report.timeline.map((t, i) => (
                <tr key={i} className="ai-row">
                  <td>{t.time}</td>
                  <td>{t.event}</td>
                  <td>{(t.confidence * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.rootCause && (
            <>
              <h3>Root Cause <span className="tag-ai">AI-generated</span></h3>
              <div className="card ai-row">
                <p><strong>Cause:</strong> {report.rootCause.cause}</p>
                <p><strong>Confidence:</strong> {(report.rootCause.confidence * 100).toFixed(0)}%</p>
                <p><strong>Evidence:</strong> {report.rootCause.evidence}</p>
              </div>
            </>
          )}

          {report.recommendations.length > 0 && (
            <>
              <h3>Recommendations <span className="tag-ai">AI-generated</span></h3>
              <ul className="rec-list">
                {report.recommendations.map((r, i) => (
                  <li key={i} className="ai-row">
                    <strong>{i + 1}.</strong> {r.recommendation}
                    {r.reference && <span className="ref"> ({r.reference})</span>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {report.reportSummary && (
            <>
              <h3>Report Summary <span className={report.reviews.length > 0 ? "tag-human" : "tag-ai"}>Human-reviewed</span></h3>
              <div className="card human-row"><pre>{report.reportSummary}</pre></div>
            </>
          )}

          {report.reviews.length > 0 && (
            <>
              <h3>Review History <span className="tag-human">Human action</span></h3>
              {report.reviews.map((rv, i) => (
                <div key={i} className="card human-row">
                  <p><strong>Reviewer:</strong> {rv.reviewer_user_id}</p>
                  <p><strong>Action:</strong> {rv.approved ? "Approved" : `Rejected → ${rv.target_state}`}</p>
                  {rv.modifications && <p><strong>Note:</strong> {rv.modifications}</p>}
                </div>
              ))}
            </>
          )}

          {report.status === "AwaitReview" && (
            <div className="review-actions">
              <h3>Your Decision</h3>
              <label>Reviewer ID<input value={reviewerId} onChange={(e) => setReviewerId(e.target.value)} /></label>
              <label>Modification note<textarea value={modifications} onChange={(e) => setModifications(e.target.value)} rows={2} /></label>
              <div className="button-row">
                <button className="btn-approve" onClick={doApprove}>Approve</button>
                <span>or</span>
                <select value={rejectTarget} onChange={(e) => setRejectTarget(e.target.value)}>
                  <option value="TimelineDone">Reject → Timeline</option>
                  <option value="Validated">Reject → Root Cause</option>
                  <option value="RootCauseDone">Reject → Prevention</option>
                </select>
                <button className="btn-reject" onClick={doReject}>Reject</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ReportPage(props: { incidentId: string; onError: (e: unknown) => void; setLoading: (v: boolean) => void }) {
  const [id, setId] = useState(props.incidentId);
  const [report, setReport] = useState<api.Report | null>(null);

  const load = async () => {
    if (!id.trim()) { props.onError(new Error("Enter an incident ID")); return; }
    props.setLoading(true);
    try { setReport(await api.getReport(id.trim())); } catch (e) { props.onError(e); }
    props.setLoading(false);
  };

  return (
    <section className="page">
      <h2>Report View</h2>
      <label>Incident ID<input value={id} onChange={(e) => setId(e.target.value)} placeholder="Paste incident ID" /></label>
      <button onClick={load}>Load Report</button>
      {report && (
        <>
          <div className="card">
            <h3>{report.title}</h3>
            <p><strong>Status:</strong> {report.status}</p>
            <p><strong>Summary:</strong> {report.summary}</p>
          </div>
          <h3>Final Timeline</h3>
          <table className="data-table">
            <thead><tr><th>Time</th><th>Event</th><th>Confidence</th></tr></thead>
            <tbody>
              {report.timeline.map((t, i) => <tr key={i}><td>{t.time}</td><td>{t.event}</td><td>{(t.confidence * 100).toFixed(0)}%</td></tr>)}
            </tbody>
          </table>
          {report.rootCause && (
            <div className="card"><h4>Root Cause</h4><p>{report.rootCause.cause}</p><p><em>Confidence: {(report.rootCause.confidence * 100).toFixed(0)}%</em></p></div>
          )}
          {report.recommendations.length > 0 && (
            <div className="card"><h4>Recommendations</h4><ul>{report.recommendations.map((r, i) => <li key={i}>{r.recommendation}</li>)}</ul></div>
          )}
          {report.reportSummary && <div className="card"><h4>Report Summary</h4><pre>{report.reportSummary}</pre></div>}
          {report.reviews.length > 0 && (
            <div className="card"><h4>Reviews</h4>{report.reviews.map((rv, i) => <p key={i}>{rv.reviewer_user_id}: {rv.approved ? "Approved" : "Rejected"}</p>)}</div>
          )}
        </>
      )}
    </section>
  );
}

function SimilarPage(props: { onError: (e: unknown) => void; setLoading: (v: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [k, setK] = useState(5);
  const [results, setResults] = useState<api.SimilarResult[] | null>(null);

  const search = async () => {
    if (!query.trim()) { props.onError(new Error("Query is required")); return; }
    props.setLoading(true);
    try {
      const data = await api.searchSimilar(query.trim(), k);
      setResults(data.results);
    } catch (e) { props.onError(e); }
    props.setLoading(false);
  };

  return (
    <section className="page">
      <h2>Similar Incident Search</h2>
      <div className="search-row">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search query..." className="search-input" />
        <input type="number" value={k} onChange={(e) => setK(Math.max(1, Math.min(20, Number(e.target.value))))} min={1} max={20} style={{ width: 60 }} />
        <button onClick={search}>Search</button>
      </div>
      {results && results.length === 0 && <div className="card" style={{ textAlign: "center", color: "var(--text-muted)", padding: "2rem" }}>No matching incidents found. Try broadening your search.</div>}
      {results && results.length > 0 && (
        <div className="results-list">
          {results.map((r, i) => (
            <div key={i} className="card result-item">
              <div className="result-header">
                <strong>{r.title}</strong>
                <span className={r.type === "past_incident" ? "tag-incident" : "tag-runbook"}>{r.type}</span>
                <span className="score">{(r.score * 100).toFixed(1)}%</span>
              </div>
              <p className="result-content">{r.content.slice(0, 300)}...</p>
              <p className="result-meta">Source: {r.sourceId}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
