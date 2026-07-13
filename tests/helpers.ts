export function baseUrl(): string {
  const url = process.env.BASE_URL ?? "http://localhost:8787";
  return url.replace(/\/+$/, "");
}

export function authToken(): string | undefined {
  return process.env.AUTH_TOKEN;
}

export function authHeaders(): Record<string, string> {
  const token = authToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const url = `${baseUrl()}${path}`;
  const opts: RequestInit = {
    method,
    headers: authHeaders(),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

export async function apiJson<T = unknown>(method: string, path: string, body?: unknown): Promise<{ data?: T; error?: { code: string; message: string } }> {
  const res = await api(method, path, body);
  const json = await res.json() as any;
  return json as { data?: T; error?: { code: string; message: string } };
}

export async function createIncident(title: string, summary: string): Promise<string> {
  const res = await apiJson<{ id: string }>("POST", "/api/v1/incidents", { title, summary });
  if (res.error) throw new Error(`createIncident failed: ${res.error.code} ${res.error.message}`);
  return res.data!.id;
}

export async function addEvent(incidentId: string, detail: string, timestamp?: string): Promise<void> {
  const body: Record<string, unknown> = { detail };
  if (timestamp) body.timestamp = timestamp;
  const res = await apiJson("POST", `/api/v1/incidents/${incidentId}/events`, body);
  if (res.error) throw new Error(`addEvent failed: ${res.error.code} ${res.error.message}`);
}

export async function analyzeIncident(incidentId: string): Promise<void> {
  const res = await apiJson("POST", `/api/v1/incidents/${incidentId}/analyze`);
  if (res.error) throw new Error(`analyzeIncident failed: ${res.error.code} ${res.error.message}`);
}

export async function getReport(incidentId: string): Promise<any> {
  const res = await apiJson<any>("GET", `/api/v1/incidents/${incidentId}/report`);
  if (res.error) throw new Error(`getReport failed: ${res.error.code} ${res.error.message}`);
  return res.data;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForReport(incidentId: string, maxWaitMs = 180_000, pollMs = 5000): Promise<any> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const report = await getReport(incidentId);
    if (["AwaitReview", "Finalized", "TimelineDone", "RootCauseDone", "PreventionDone"].includes(report.status)) {
      return report;
    }
    await sleep(pollMs);
  }
  const final = await getReport(incidentId);
  throw new Error(`Timed out waiting for terminal state. Last status: ${final.status}`);
}

export async function waitForChainCompletion(incidentId: string, maxWaitMs = 300_000, pollMs = 5000): Promise<any> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const report = await getReport(incidentId);
    if (report.status === "AwaitReview" || report.status === "Finalized") return report;
    await sleep(pollMs);
  }
  const final = await getReport(incidentId);
  throw new Error(`Timed out waiting for chain completion. Status: ${final.status}, rootCause: ${JSON.stringify(final.rootCause)}`);
}
