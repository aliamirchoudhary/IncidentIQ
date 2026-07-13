import { describe, it, expect } from "vitest";
import { apiJson } from "../helpers";

describe("DO concurrency guarantee", () => {
  it("exactly one of two simultaneous transitions succeeds", async () => {
    // Create fresh DO and advance to AwaitReview
    const createRes = await apiJson<{ id: string }>("POST", "/api/v1/debug/do/create");
    expect(createRes.error).toBeUndefined();
    const doId = createRes.data!.id;

    for (const s of ["TimelineDone", "Validated", "RootCauseDone", "PreventionDone", "AwaitReview"]) {
      const r = await apiJson<any>("POST", `/api/v1/debug/do/${doId}`, { transition: s });
      expect(r.data?.state).toBe(s);
    }

    // Fire two simultaneous Finalized transitions
    const [r1, r2] = await Promise.all([
      apiJson<any>("POST", `/api/v1/debug/do/${doId}`, { transition: "Finalized" }),
      apiJson<any>("POST", `/api/v1/debug/do/${doId}`, { transition: "Finalized" }),
    ]);

    const successes = [r1, r2].filter((r) => r.data?.state === "Finalized").length;
    expect(successes).toBe(1);

    // Verify the DO is in Finalized
    const final = await apiJson<{ state: string; version: number }>("GET", `/api/v1/debug/do/${doId}`);
    expect(final.data?.state).toBe("Finalized");
  });
});
