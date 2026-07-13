import { describe, it, expect } from "vitest";
import { createIncident, addEvent, analyzeIncident, waitForReport, waitForChainCompletion } from "../helpers";

describe("validation gate — blocks bad input", () => {
  it("halts chain at TimelineDone when validation fails with < 2 events", async () => {
    const id = await createIncident("Failure: Single Event", "Testing chain halt on validation failure");
    await addEvent(id, "Only one event submitted", "2026-07-13T08:00:00Z");

    await analyzeIncident(id);
    const report = await waitForReport(id);

    expect(report.status).toBe("TimelineDone");
    expect(report.timeline).toBeDefined();
    expect(report.timeline.length).toBeGreaterThanOrEqual(1);
    expect(report.rootCause).toBeNull();
    expect(report.recommendations).toBeDefined();
    expect(report.recommendations.length).toBe(0);
  });
});

describe("chain recovery — fix and re-trigger", () => {
  it("re-triggers after fixing validation failure", async () => {
    // Create with single event (will fail validation)
    const id = await createIncident("Failure: Recovery Test", "Testing re-trigger after fixing data");
    await addEvent(id, "First event only", "2026-07-13T09:00:00Z");

    await analyzeIncident(id);
    const report1 = await waitForReport(id);
    expect(report1.status).toBe("TimelineDone");

    // Add more events and re-trigger
    await addEvent(id, "Second event added", "2026-07-13T09:05:00Z");
    await addEvent(id, "Third event added", "2026-07-13T09:10:00Z");

    await analyzeIncident(id);
    const report2 = await waitForChainCompletion(id, 300_000);

    expect(["AwaitReview", "Finalized"]).toContain(report2.status);
    expect(report2.rootCause).not.toBeNull();
    expect(report2.rootCause!.cause).toBeTruthy();
    expect(report2.recommendations.length).toBeGreaterThan(0);
  }, 300_000);
});

describe("chain integrity — no state corruption", () => {
  it("incident state remains valid even after a mid-chain failure", async () => {
    // This tests that after a stopped chain, the incident data is still internally consistent
    const id = await createIncident("Failure: State Integrity", "Testing state consistency after partial chain");
    await addEvent(id, "Event A", "2026-07-13T10:00:00Z");
    // Only 1 event — chain will halt at validation

    await analyzeIncident(id);
    const report = await waitForReport(id);

    // State should be TimelineDone — consistent, no corruption
    expect(report.status).toBe("TimelineDone");
    expect(report.version).toBeGreaterThanOrEqual(1);
    expect(report.events.length).toBe(1);
  });
});
