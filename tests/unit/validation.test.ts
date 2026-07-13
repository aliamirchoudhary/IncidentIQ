import { describe, it, expect } from "vitest";
import { areContradictory, validateTimeline } from "../../workers/core-api/src/validation";

describe("areContradictory", () => {
  it("detects 'up' vs 'down'", () => {
    expect(areContradictory("Server is up and healthy", "Server is down")).toBe(true);
  });

  it("detects 'operational' vs 'outage'", () => {
    expect(areContradictory("All services operational", "Major outage detected")).toBe(true);
  });

  it("detects 'restored' vs 'degraded'", () => {
    expect(areContradictory("Service restored to full health", "Service still degraded")).toBe(true);
  });

  it("allows unrelated descriptions", () => {
    expect(areContradictory("Deploying version 2.1.3", "CPU usage at 45%")).toBe(false);
  });

  it("detects near-duplicate text", () => {
    expect(areContradictory("Database connection pool is exhausted", "Database connection pool is exhausted")).toBe(true);
  });

  it("handles empties without throwing", () => {
    expect(areContradictory("", "")).toBe(false);
  });
});

describe("validateTimeline", () => {
  const ts1 = "2026-01-01T00:00:00Z";
  const ts2 = "2026-01-01T01:00:00Z";
  const tsLarge = "2026-01-03T00:00:00Z";

  it("flags insufficient_evidence for < 2 entries", () => {
    const r = validateTimeline(
      [{ time: ts1, event: "X", confidence: 1.0 }],
      [{ timestamp: ts1, detail: "X" }],
    );
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.type === "insufficient_evidence")).toBe(true);
  });

  it("flags missing_timestamp when > 50% lack timestamps", () => {
    const r = validateTimeline(
      [
        { time: ts1, event: "A", confidence: 1.0 },
        { time: ts2, event: "B", confidence: 1.0 },
      ],
      [
        { timestamp: ts1, detail: "A" },
        { timestamp: null, detail: "B" },
        { timestamp: null, detail: "C" },
      ],
    );
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.type === "missing_timestamp")).toBe(true);
  });

  it("flags contradictory_events for near-simultaneous opposites", () => {
    const r = validateTimeline(
      [
        { time: ts1, event: "System is up", confidence: 1.0 },
        { time: tsLarge, event: "System is down", confidence: 1.0 },
      ],
      [
        { timestamp: "2026-01-01T00:00:00.000Z", detail: "System is up" },
        { timestamp: "2026-01-01T00:00:00.500Z", detail: "System is down" },
      ],
    );
    expect(r.issues.some((i) => i.type === "contradictory_events")).toBe(true);
  });

  it("flags large_gap for > 24h between events", () => {
    const r = validateTimeline(
      [
        { time: ts1, event: "Event A", confidence: 1.0 },
        { time: tsLarge, event: "Event B", confidence: 1.0 },
      ],
      [
        { timestamp: ts1, detail: "Event A" },
        { timestamp: tsLarge, detail: "Event B" },
      ],
    );
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.type === "large_gap")).toBe(true);
  });

  it("passes clean timeline", () => {
    const r = validateTimeline(
      [
        { time: ts1, event: "Deploy started", confidence: 1.0 },
        { time: ts2, event: "Deploy completed", confidence: 1.0 },
      ],
      [
        { timestamp: ts1, detail: "Deploy started" },
        { timestamp: ts2, detail: "Deploy completed, all healthy" },
      ],
    );
    expect(r.valid).toBe(true);
    expect(r.issues.length).toBe(0);
  });
});
