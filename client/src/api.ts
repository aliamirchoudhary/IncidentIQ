const BASE = import.meta.env.VITE_API_BASE ?? "";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json.data as T;
}

export interface Incident {
  id: string;
  title: string;
  summary: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  time: string;
  event: string;
  confidence: number;
  note: string | null;
}

export interface RootCause {
  cause: string;
  confidence: number;
  evidence: string;
  needs_review: boolean;
  provider_used: string;
}

export interface Recommendation {
  recommendation: string;
  reference: string | null;
}

export interface Review {
  reviewer_user_id: string;
  approved: number;
  modifications: string | null;
  target_state: string;
  created_at: string;
}

export interface Report {
  id: string;
  title: string;
  summary: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEntry[];
  rootCause: RootCause | null;
  recommendations: Recommendation[];
  reviews: Review[];
  reportSummary: string | null;
  needsReview: boolean;
  events: { detail: string; timestamp: string | null; source: string | null }[];
}

export interface SimilarResult {
  chunkId: string;
  sourceId: string;
  title: string;
  type: string;
  content: string;
  tags: string[];
  score: number;
}

export function createIncident(title: string, summary: string): Promise<Incident> {
  return request("POST", "/api/v1/incidents", { title, summary });
}

export function addEvent(incidentId: string, timestamp: string | null, detail: string, source: string): Promise<unknown> {
  return request("POST", `/api/v1/incidents/${incidentId}/events`, { timestamp, detail, source });
}

export function triggerAnalysis(incidentId: string): Promise<unknown> {
  return request("POST", `/api/v1/incidents/${incidentId}/analyze`);
}

export function getReport(incidentId: string): Promise<Report> {
  return request("GET", `/api/v1/incidents/${incidentId}/report`);
}

export function submitReview(incidentId: string, approved: boolean, reviewerUserId: string, modifications?: string): Promise<unknown> {
  return request("POST", `/api/v1/incidents/${incidentId}/review`, {
    approved,
    reviewer_user_id: reviewerUserId,
    ...(modifications ? { modifications } : {}),
  });
}

export function rejectReview(incidentId: string, reviewerUserId: string, targetState: string, modifications?: string): Promise<unknown> {
  return request("POST", `/api/v1/incidents/${incidentId}/review`, {
    approved: false,
    reviewer_user_id: reviewerUserId,
    target_state: targetState,
    ...(modifications ? { modifications } : {}),
  });
}

export function searchSimilar(query: string, k = 5): Promise<{ query: string; k: number; results: SimilarResult[] }> {
  return request("GET", `/api/v1/incidents/similar?query=${encodeURIComponent(query)}&k=${k}`);
}
