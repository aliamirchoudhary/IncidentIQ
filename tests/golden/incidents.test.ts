import { describe, it, expect } from "vitest";
import { createIncident, addEvent, analyzeIncident, waitForChainCompletion } from "../helpers";

type IncidentCategory = "database" | "deployment" | "network";

interface GoldenTestCase {
  category: IncidentCategory;
  title: string;
  summary: string;
  events: Array<{ detail: string; timestamp: string }>;
  expectedKeywords: string[];
}

const GOLDEN_INCIDENTS: GoldenTestCase[] = [
  {
    category: "database",
    title: "Golden: Database Connection Exhaustion",
    summary: "Production database connection pool exhausted causing API timeouts",
    events: [
      { detail: "Database connection pool reached 100% utilization at 10:00 UTC", timestamp: "2026-07-13T10:00:00Z" },
      { detail: "API response times increased from 50ms to 15s at 10:01 UTC", timestamp: "2026-07-13T10:01:00Z" },
      { detail: "Connection pool automatically scaled up at 10:05 UTC,恢复正常", timestamp: "2026-07-13T10:05:00Z" },
    ],
    expectedKeywords: ["database", "connection", "pool"],
  },
  {
    category: "deployment",
    title: "Golden: Failed Deployment Rollback",
    summary: "New release v2.1.3 caused cascading failures, rolled back",
    events: [
      { detail: "Deploying version 2.1.3 to production at 22:00 UTC", timestamp: "2026-07-13T22:00:00Z" },
      { detail: "Error rate spiked to 25% on /api/orders endpoint at 22:03 UTC", timestamp: "2026-07-13T22:03:00Z" },
      { detail: "Rollback to v2.1.2 initiated at 22:05 UTC", timestamp: "2026-07-13T22:05:00Z" },
      { detail: "Rollback completed, error rate returned to baseline 0.1% at 22:08 UTC", timestamp: "2026-07-13T22:08:00Z" },
    ],
    expectedKeywords: ["deploy", "rollback", "error"],
  },
  {
    category: "network",
    title: "Golden: CDN Edge Node Failure",
    summary: "Regional CDN edge node went offline causing elevated latency for APAC users",
    events: [
      { detail: "APAC region latency spiked from 30ms to 800ms at 14:00 UTC", timestamp: "2026-07-13T14:00:00Z" },
      { detail: "CDN provider reported edge node HKG-42 offline at 14:02 UTC", timestamp: "2026-07-13T14:02:00Z" },
      { detail: "Traffic rerouted to SIN-17 edge node at 14:05 UTC", timestamp: "2026-07-13T14:05:00Z" },
      { detail: "Latency returned to 35ms for APAC users at 14:06 UTC", timestamp: "2026-07-13T14:06:00Z" },
    ],
    expectedKeywords: ["latency", "edge", "region"],
  },
];

describe("golden incidents", () => {
  for (const testCase of GOLDEN_INCIDENTS) {
    it(`processes ${testCase.category} incident and returns structured output`, async () => {
      const id = await createIncident(testCase.title, testCase.summary);
      for (const ev of testCase.events) {
        await addEvent(id, ev.detail, ev.timestamp);
      }

      await analyzeIncident(id);
      const report = await waitForChainCompletion(id, 300_000);

      // Structure assertions (strict)
      expect(report).toHaveProperty("id");
      expect(report).toHaveProperty("title", testCase.title);
      expect(report).toHaveProperty("status");
      expect(["AwaitReview", "Finalized"]).toContain(report.status);

      // Timeline assertions
      expect(Array.isArray(report.timeline)).toBe(true);
      expect(report.timeline.length).toBeGreaterThan(0);
      for (const entry of report.timeline) {
        expect(entry).toHaveProperty("time");
        expect(entry).toHaveProperty("event");
        expect(typeof entry.confidence).toBe("number");
      }

      // Root cause assertions
      expect(report.rootCause).toBeDefined();
      expect(typeof report.rootCause.cause).toBe("string");
      expect(report.rootCause.cause.length).toBeGreaterThan(0);
      expect(typeof report.rootCause.confidence).toBe("number");
      expect(report.rootCause.confidence).toBeGreaterThanOrEqual(0);
      expect(report.rootCause.confidence).toBeLessThanOrEqual(1);
      expect(typeof report.rootCause.evidence).toBe("string");

      // Recommendations assertions
      expect(Array.isArray(report.recommendations)).toBe(true);
      expect(report.recommendations.length).toBeGreaterThan(0);
      for (const rec of report.recommendations) {
        expect(typeof rec.recommendation).toBe("string");
        expect(rec.recommendation.length).toBeGreaterThan(0);
      }

      // Content assertion (loose — keyword match, not exact string)
      const allText = [
        report.rootCause.cause,
        report.rootCause.evidence,
        ...report.recommendations.map((r: any) => r.recommendation),
        report.reportSummary ?? "",
      ].join(" ").toLowerCase();

      for (const keyword of testCase.expectedKeywords) {
        expect(allText).toContain(keyword.toLowerCase());
      }
    }, 300_000);
  }
});
