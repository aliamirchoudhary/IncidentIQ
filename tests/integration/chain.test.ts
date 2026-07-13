import { describe, it, expect } from "vitest";
import { createIncident, addEvent, analyzeIncident, waitForReport } from "../helpers";

describe("full analysis chain", () => {
  it("runs the complete chain on a valid incident", async () => {
    const id = await createIncident(
      "Chain Test: Database Failover",
      "Testing automatic chain through all 5 agents end to end",
    );
    await addEvent(id, "Primary database replica crashed at 10:00 UTC", "2026-07-13T10:00:00Z");
    await addEvent(id, "Failover to standby replica completed at 10:02 UTC", "2026-07-13T10:02:00Z");
    await addEvent(id, "Connection pool rebalanced at 10:05 UTC", "2026-07-13T10:05:00Z");

    await analyzeIncident(id);

    const report = await waitForReport(id);

    expect(report.status).toBe("AwaitReview");
    expect(report.timeline).toBeDefined();
    expect(Array.isArray(report.timeline)).toBe(true);
    expect(report.timeline.length).toBeGreaterThanOrEqual(1);

    expect(report.rootCause).toBeDefined();
    expect(typeof report.rootCause.cause).toBe("string");
    expect(report.rootCause.cause.length).toBeGreaterThan(0);
    expect(typeof report.rootCause.confidence).toBe("number");
    expect(report.rootCause.confidence).toBeGreaterThanOrEqual(0);
    expect(report.rootCause.confidence).toBeLessThanOrEqual(1);

    expect(report.recommendations).toBeDefined();
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(report.recommendations.length).toBeGreaterThan(0);

    expect(report.reportSummary).toBeTruthy();
  }, 180_000);

  it("halts at validation when fewer than 2 events are submitted", async () => {
    const id = await createIncident("Chain Test: Single Event", "Testing validation gate halts the chain");
    await addEvent(id, "Only one event", "2026-07-13T12:00:00Z");

    await analyzeIncident(id);

    const report = await waitForReport(id);

    // Should still be in TimelineDone — chain blocked at validation
    expect(report.status).toBe("TimelineDone");
    expect(report.timeline).toBeDefined();
    expect(report.rootCause).toBeNull();
  }, 120_000);
});
