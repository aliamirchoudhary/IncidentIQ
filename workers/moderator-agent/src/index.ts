import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  async ping(): Promise<string> {
    return "pong";
  }
}
