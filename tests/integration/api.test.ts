import { describe, it, expect } from "vitest";
import { apiJson, createIncident, addEvent } from "../helpers";

describe("incident CRUD", () => {
  let incidentId: string;

  it("creates an incident", async () => {
    incidentId = await createIncident("API Test Incident", "Testing incident creation through the API");
    expect(incidentId).toBeTruthy();
    expect(typeof incidentId).toBe("string");
  });

  it("adds an event to the incident", async () => {
    await addEvent(incidentId, "First test event occurred", "2026-07-13T10:00:00Z");
    // Success is no throw
  });

  it("adds a second event", async () => {
    await addEvent(incidentId, "Second test event occurred", "2026-07-13T11:00:00Z");
  });

  it("fetches the incident", async () => {
    const res = await apiJson<any>("GET", `/api/v1/incidents/${incidentId}`);
    expect(res.error).toBeUndefined();
    expect(res.data?.id).toBe(incidentId);
    expect(res.data?.title).toBe("API Test Incident");
    expect(res.data?.status).toBeTruthy();
    expect(typeof res.data?.version).toBe("number");
  });

  it("fetches the report", async () => {
    const res = await apiJson<any>("GET", `/api/v1/incidents/${incidentId}/report`);
    expect(res.error).toBeUndefined();
    expect(res.data?.id).toBe(incidentId);
    expect(res.data?.title).toBe("API Test Incident");
    expect(res.data?.status).toBeTruthy();
    expect(res.data?.events).toBeDefined();
    expect(Array.isArray(res.data?.events)).toBe(true);
  });

  it("returns 400 for missing title", async () => {
    const res = await apiJson("POST", "/api/v1/incidents", { summary: "No title" });
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for missing detail in event", async () => {
    const res = await apiJson("POST", `/api/v1/incidents/${incidentId}/events`, {});
    expect(res.error?.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for unknown incident", async () => {
    const res = await apiJson("GET", "/api/v1/incidents/00000000-0000-0000-0000-000000000000");
    expect(res.error?.code).toBe("NOT_FOUND");
  });

  it("returns envelope format {data: ...} on success", async () => {
    const res = await apiJson<any>("GET", `/api/v1/incidents/${incidentId}`);
    expect(res).toHaveProperty("data");
    expect(res.data).toHaveProperty("id");
    expect(res.data).toHaveProperty("title");
  });

  it("returns envelope format {error: {code, message}} on failure", async () => {
    const res = await apiJson("GET", "/api/v1/incidents/bad-id-format");
    expect(res).toHaveProperty("error");
    expect(res.error).toHaveProperty("code");
    expect(res.error).toHaveProperty("message");
  });
});
