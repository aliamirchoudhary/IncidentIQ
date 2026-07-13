import { describe, it, expect } from "vitest";
import { apiJson } from "../helpers";

async function createDebugDo(): Promise<string> {
  const res = await apiJson<{ id: string }>("POST", "/api/v1/debug/do/create");
  if (res.error) throw new Error(`create failed: ${res.error.message}`);
  return res.data!.id;
}

async function getDoState(id: string): Promise<{ state: string; version: number }> {
  const res = await apiJson<{ state: string; version: number }>("GET", `/api/v1/debug/do/${id}`);
  if (res.error) throw new Error(`get failed: ${res.error.message}`);
  return { state: res.data!.state, version: res.data!.version };
}

async function transitionDo(id: string, target: string): Promise<{ success: boolean; state?: string; version?: number; error?: string }> {
  const res = await apiJson<any>("POST", `/api/v1/debug/do/${id}`, { transition: target });
  if (res.data) return { success: true, state: res.data.state, version: res.data.version };
  if (res.error?.code === "ILLEGAL_TRANSITION") return { success: false, error: res.error.message };
  if (res.error) throw new Error(`transition failed: ${res.error.code} ${res.error.message}`);
  return { success: false };
}

describe("DO state machine", () => {
  let doId: string;

  it("creates a new DO in Ingested state", async () => {
    doId = await createDebugDo();
    const state = await getDoState(doId);
    expect(state.state).toBe("Ingested");
    expect(state.version).toBe(1);
  });

  it("transitions Ingested → TimelineDone", async () => {
    const r = await transitionDo(doId, "TimelineDone");
    expect(r.success).toBe(true);
    expect(r.state).toBe("TimelineDone");
    expect(r.version).toBeGreaterThanOrEqual(2);
  });

  it("transitions TimelineDone → Validated", async () => {
    const r = await transitionDo(doId, "Validated");
    expect(r.success).toBe(true);
    expect(r.state).toBe("Validated");
  });

  it("transitions Validated → RootCauseDone", async () => {
    const r = await transitionDo(doId, "RootCauseDone");
    expect(r.success).toBe(true);
    expect(r.state).toBe("RootCauseDone");
  });

  it("transitions RootCauseDone → PreventionDone", async () => {
    const r = await transitionDo(doId, "PreventionDone");
    expect(r.success).toBe(true);
    expect(r.state).toBe("PreventionDone");
  });

  it("transitions PreventionDone → AwaitReview", async () => {
    const r = await transitionDo(doId, "AwaitReview");
    expect(r.success).toBe(true);
    expect(r.state).toBe("AwaitReview");
  });

  it("transitions AwaitReview → Finalized", async () => {
    const r = await transitionDo(doId, "Finalized");
    expect(r.success).toBe(true);
    expect(r.state).toBe("Finalized");
  });

  it("version increments with each transition", async () => {
    // Create a fresh DO to count transitions cleanly
    const freshId = await createDebugDo();
    const initial = await getDoState(freshId);
    expect(initial.version).toBe(1);

    const r = await transitionDo(freshId, "TimelineDone");
    expect(r.version).toBe(2);
  });

  it("rejects illegal transitions with 409", async () => {
    const freshId = await createDebugDo();
    const r = await transitionDo(freshId, "Finalized");
    expect(r.success).toBe(false);
    expect(r.error).toContain("Illegal transition");
  });

  it("rejects Finalized → any state", async () => {
    const r = await transitionDo(doId, "Ingested");
    expect(r.success).toBe(false);
    expect(r.error).toContain("Illegal transition");
  });

  it("allows AwaitReview rollback to TimelineDone", async () => {
    const freshId = await createDebugDo();
    // Walk to AwaitReview
    for (const s of ["TimelineDone", "Validated", "RootCauseDone", "PreventionDone", "AwaitReview"]) {
      const r = await transitionDo(freshId, s);
      expect(r.success).toBe(true);
    }
    // Now rollback
    const r = await transitionDo(freshId, "TimelineDone");
    expect(r.success).toBe(true);
    expect(r.state).toBe("TimelineDone");
  });
});
