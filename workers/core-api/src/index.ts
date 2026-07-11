import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  TIMELINE_AGENT: { ping(): Promise<string> };
  ROOTCAUSE_AGENT: { ping(): Promise<string> };
  PREVENTION_AGENT: { ping(): Promise<string> };
  MODERATOR_AGENT: { ping(): Promise<string> };
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/v1/debug/ping-all") {
      return this.handlePingAll();
    }

    return new Response(
      JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  private async handlePingAll(): Promise<Response> {
    const results: Record<string, string> = {};

    for (const [name, agent] of Object.entries({
      "timeline-agent": this.env.TIMELINE_AGENT,
      "rootcause-agent": this.env.ROOTCAUSE_AGENT,
      "prevention-agent": this.env.PREVENTION_AGENT,
      "moderator-agent": this.env.MODERATOR_AGENT,
    })) {
      try {
        const response = await agent.ping();
        results[name] = response;
      } catch (err) {
        results[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const allOk = Object.values(results).every((v) => v === "pong");

    return new Response(
      JSON.stringify({
        data: {
          status: allOk ? "ok" : "degraded",
          agents: results,
        },
      }),
      {
        status: allOk ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
