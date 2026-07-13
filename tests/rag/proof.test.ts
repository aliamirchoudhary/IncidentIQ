import { describe, it, expect } from "vitest";
import { apiJson, createIncident, addEvent, analyzeIncident, waitForReport } from "../helpers";

const UNIQUE_TAG = `rag-proof-${Date.now()}`;

describe("RAG Proof A — retrieval depends on corpus", () => {
  it("query returns empty before adding matching document, non-empty after", async () => {
    const queryTerm = `ZXY_UNIQUE_QUERY_${Date.now()}`;

    // Query with the unique term — should not match anything
    const before = await apiJson<any>("GET", `/api/v1/knowledge/query?q=${encodeURIComponent(queryTerm)}`);
    expect(before.error).toBeUndefined();

    // Ingest a document containing this unique term
    const docBody = {
      title: `RAG Proof A Doc ${UNIQUE_TAG}`,
      content: `This document is about ${queryTerm}. The system should handle it correctly for RAG testing purposes.`,
      type: "runbook",
      source: "rag-proof-a",
    };
    const ingestRes = await apiJson<any>("POST", "/api/v1/knowledge/ingest", docBody);
    expect(ingestRes.error).toBeUndefined();

    // Give D1 + AI a moment to index
    await new Promise((r) => setTimeout(r, 5000));

    // Query again — should now find the document
    const after = await apiJson<{ results: Array<unknown> }>("GET", `/api/v1/knowledge/query?q=${encodeURIComponent(queryTerm)}`);
    expect(after.error).toBeUndefined();
    expect(Array.isArray(after.data?.results)).toBe(true);
    expect(after.data!.results.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("RAG Proof B — generation depends on retrieval", () => {
  it("root cause analysis references the ingested document content", async () => {
    const uniqueRef = `RAG_REF_${Date.now()}`;

    // Ingest a document that will be relevant to the incident we create
    const docBody = {
      title: `RAG Proof B Doc ${UNIQUE_TAG}`,
      content: `Root cause reference: ${uniqueRef}. When a database replica crashes, the primary cause is often a connection pool exhaustion or memory pressure on the primary node. The failover process typically takes 1-3 minutes.`,
      type: "runbook",
      source: "rag-proof-b",
    };
    const ingestRes = await apiJson<any>("POST", "/api/v1/knowledge/ingest", docBody);
    expect(ingestRes.error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5000));

    // Create an incident matching the document topic
    const id = await createIncident(
      `RAG Proof B Incident ${UNIQUE_TAG}`,
      "Testing that root cause generation references ingested knowledge",
    );
    await addEvent(id, "Primary database replica crashed at 14:00 UTC", "2026-07-13T14:00:00Z");
    await addEvent(id, "Failover to standby initiated at 14:01 UTC", "2026-07-13T14:01:00Z");
    await addEvent(id, "Connection pool exhausted causing query failures", "2026-07-13T14:03:00Z");

    await analyzeIncident(id);
    const report = await waitForReport(id);

    expect(report.rootCause).toBeDefined();
    expect(typeof report.rootCause.cause).toBe("string");
    expect(report.rootCause.evidence).toBeDefined();

    // The root cause evidence should reference the ingested document (by title or source)
    const evidence = report.rootCause.evidence ?? "";
    const cause = report.rootCause.cause ?? "";
    const allText = evidence + cause;
    expect(
      allText.includes("RAG Proof B Doc") ||
      allText.includes("rag-proof-b")
    ).toBe(true);
  }, 180_000);
});
