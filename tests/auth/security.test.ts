import { describe, it, expect } from "vitest";
import { apiJson, authToken } from "../helpers";

describe("authentication", () => {
  const isAuthenticated = !!authToken();

  it("blocks unauthenticated POST to /incidents with 401", async () => {
    // Explicitly call without auth headers
    const url = `${process.env.BASE_URL ?? "http://localhost:8787"}/api/v1/incidents`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "X", summary: "Y" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code", "UNAUTHORIZED");
  });

  it("allows authenticated POST to /incidents when token is provided", async () => {
    if (!isAuthenticated) return; // skip in environments without a token

    const res = await apiJson<any>("POST", "/api/v1/incidents", {
      title: "Auth Test Incident",
      summary: "Testing authenticated creation",
    });
    expect(res.error).toBeUndefined();
    expect(res.data).toHaveProperty("id");
    expect(res.data).toHaveProperty("title", "Auth Test Incident");
  });

  it("blocks unauthenticated POST to /incidents/{id}/events with 401", async () => {
    const url = `${process.env.BASE_URL ?? "http://localhost:8787"}/api/v1/incidents/some-id/events`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ detail: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("allows unauthenticated GET to /incidents/{id}", async () => {
    // GET should be public or at least not require auth
    const url = `${process.env.BASE_URL ?? "http://localhost:8787"}/api/v1/incidents/00000000-0000-0000-0000-000000000000`;
    const res = await fetch(url);
    // Should get a 404 NOT_FOUND, not 401 — public read access
    expect([200, 404]).toContain(res.status);
  });
});
