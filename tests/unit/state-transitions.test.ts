import { describe, it, expect } from "vitest";

// Pure transition logic — no DO dependency
// Mirrors workers/core-api/src/incident-room.ts ALLOWED_TRANSITIONS
type IncidentState =
  | "Ingested" | "TimelineDone" | "Validated"
  | "RootCauseDone" | "PreventionDone" | "AwaitReview" | "Finalized";

const ALLOWED_TRANSITIONS: Record<IncidentState, IncidentState[]> = {
  Ingested: ["TimelineDone"],
  TimelineDone: ["Validated"],
  Validated: ["RootCauseDone"],
  RootCauseDone: ["PreventionDone"],
  PreventionDone: ["AwaitReview"],
  AwaitReview: ["Finalized", "TimelineDone", "RootCauseDone", "PreventionDone"],
  Finalized: [],
};

function isAllowed(from: IncidentState, to: IncidentState): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

describe("state machine transitions", () => {
  it("allows Ingested → TimelineDone", () => {
    expect(isAllowed("Ingested", "TimelineDone")).toBe(true);
  });

  it("allows TimelineDone → Validated", () => {
    expect(isAllowed("TimelineDone", "Validated")).toBe(true);
  });

  it("allows Validated → RootCauseDone", () => {
    expect(isAllowed("Validated", "RootCauseDone")).toBe(true);
  });

  it("allows RootCauseDone → PreventionDone", () => {
    expect(isAllowed("RootCauseDone", "PreventionDone")).toBe(true);
  });

  it("allows PreventionDone → AwaitReview", () => {
    expect(isAllowed("PreventionDone", "AwaitReview")).toBe(true);
  });

  it("allows AwaitReview → Finalized", () => {
    expect(isAllowed("AwaitReview", "Finalized")).toBe(true);
  });

  it("allows AwaitReview rollback to TimelineDone, RootCauseDone, PreventionDone", () => {
    expect(isAllowed("AwaitReview", "TimelineDone")).toBe(true);
    expect(isAllowed("AwaitReview", "RootCauseDone")).toBe(true);
    expect(isAllowed("AwaitReview", "PreventionDone")).toBe(true);
  });

  it("rejects Finalized → any state", () => {
    expect(isAllowed("Finalized", "Ingested")).toBe(false);
    expect(isAllowed("Finalized", "TimelineDone")).toBe(false);
    expect(isAllowed("Finalized", "AwaitReview")).toBe(false);
  });

  it("rejects skipping states (Ingested → Validated)", () => {
    expect(isAllowed("Ingested", "Validated")).toBe(false);
  });

  it("rejects backwards move (RootCauseDone → Validated)", () => {
    expect(isAllowed("RootCauseDone", "Validated")).toBe(false);
  });

  it("covers every state in the forward chain", () => {
    const chain: [IncidentState, IncidentState][] = [
      ["Ingested", "TimelineDone"],
      ["TimelineDone", "Validated"],
      ["Validated", "RootCauseDone"],
      ["RootCauseDone", "PreventionDone"],
      ["PreventionDone", "AwaitReview"],
      ["AwaitReview", "Finalized"],
    ];
    for (const [from, to] of chain) {
      expect(isAllowed(from, to)).toBe(true);
    }
  });

  it("rejects every impossible pair from each state", () => {
    const all: IncidentState[] = [
      "Ingested", "TimelineDone", "Validated",
      "RootCauseDone", "PreventionDone", "AwaitReview", "Finalized",
    ];
    for (const from of all) {
      for (const to of all) {
        const allowed = ALLOWED_TRANSITIONS[from] ?? [];
        if (from === to) continue;
        if (!allowed.includes(to)) {
          expect(isAllowed(from, to)).toBe(false);
        }
      }
    }
  });
});
