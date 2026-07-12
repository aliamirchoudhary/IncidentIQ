const STATUS_PAGES: Record<string, string> = {
  github: "https://www.githubstatus.com/api/v2/status.json",
  cloudflare: "https://www.cloudflarestatus.com/api/v2/status.json",
  atlassian: "https://status.atlassian.com/api/v2/status.json",
  vercel: "https://www.vercel-status.com/api/v2/status.json",
};

export interface StatusResult {
  service: string;
  status: "operational" | "degraded" | "outage" | "unknown";
  checked_at: string;
}

function mapIndicator(indicator: string): StatusResult["status"] {
  if (indicator === "none") return "operational";
  if (indicator === "minor") return "degraded";
  if (indicator === "major" || indicator === "critical") return "outage";
  return "unknown";
}

export async function checkStatus(service: string): Promise<StatusResult> {
  const serviceLower = service.toLowerCase().trim();
  const knownKey = Object.keys(STATUS_PAGES).find(
    (k) => serviceLower.includes(k) || k.includes(serviceLower),
  );
  const url = knownKey ? STATUS_PAGES[knownKey] : STATUS_PAGES[serviceLower];
  if (!url) {
    return { service, status: "unknown", checked_at: new Date().toISOString() };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return { service, status: "unknown", checked_at: new Date().toISOString() };
      }
      const data = (await response.json()) as any;
      const status = mapIndicator(data?.status?.indicator ?? "unknown");
      return { service, status, checked_at: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { service, status: "unknown", checked_at: new Date().toISOString() };
  }
}
