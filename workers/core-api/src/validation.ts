const MIN_EVENT_COUNT = 2;
const MAX_MISSING_TIMESTAMP_RATIO = 0.5;
const LARGE_GAP_HOURS = 24;
const CONTRADICTION_KEYWORDS = [
  "healthy", "operational", "restored", "resolved", "online", "up",
  "degraded", "outage", "down", "error", "crash", "failure", "unreachable", "timeout",
];

interface TimelineEntry {
  time: string;
  event: string;
  confidence: number;
  note?: string;
}

interface RawEvent {
  timestamp: string | null;
  detail: string;
  source?: string;
}

export interface ValidationIssue {
  type: "missing_timestamp" | "contradictory_events" | "insufficient_evidence" | "large_gap";
  detail: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function areContradictory(detail1: string, detail2: string): boolean {
  const d1 = detail1.toLowerCase();
  const d2 = detail2.toLowerCase();

  const c1 = CONTRADICTION_KEYWORDS.filter(k => d1.includes(k));
  const c2 = CONTRADICTION_KEYWORDS.filter(k => d2.includes(k));

  const allPositive = ["healthy", "operational", "restored", "resolved", "online", "up"];
  const allNegative = ["degraded", "outage", "down", "error", "crash", "failure", "unreachable", "timeout"];

  const hasPositive1 = c1.some(k => allPositive.includes(k));
  const hasNegative1 = c1.some(k => allNegative.includes(k));
  const hasPositive2 = c2.some(k => allPositive.includes(k));
  const hasNegative2 = c2.some(k => allNegative.includes(k));

  if ((hasPositive1 && hasNegative2) || (hasNegative1 && hasPositive2)) {
    return true;
  }

  const words1 = d1.split(/\s+/).filter(w => w.length > 3);
  const words2 = d2.split(/\s+/).filter(w => w.length > 3);
  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const overlap = [...set1].filter(w => set2.has(w)).length;
  const maxLen = Math.max(set1.size, set2.size);
  if (maxLen > 0 && overlap / maxLen > 0.7 && Math.abs(words1.length - words2.length) <= 2) {
    return true;
  }

  return false;
}

export function validateTimeline(
  timeline: TimelineEntry[],
  rawEvents: RawEvent[],
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (timeline.length < MIN_EVENT_COUNT) {
    issues.push({
      type: "insufficient_evidence",
      detail: `Only ${timeline.length} event(s) submitted, minimum is ${MIN_EVENT_COUNT}`,
    });
  }

  const missingTimestamp = rawEvents.filter(e => !e.timestamp || isNaN(new Date(e.timestamp).getTime())).length;
  const missingRatio = rawEvents.length > 0 ? missingTimestamp / rawEvents.length : 0;
  if (missingRatio > MAX_MISSING_TIMESTAMP_RATIO) {
    issues.push({
      type: "missing_timestamp",
      detail: `${missingTimestamp} of ${rawEvents.length} events (${Math.round(missingRatio * 100)}%) have no valid timestamp, exceeding the ${Math.round(MAX_MISSING_TIMESTAMP_RATIO * 100)}% threshold`,
    });
  }

  const timestampedEvents = rawEvents.filter(e => e.timestamp && !isNaN(new Date(e.timestamp).getTime()));
  for (let i = 0; i < timestampedEvents.length; i++) {
    for (let j = i + 1; j < timestampedEvents.length; j++) {
      const t1 = new Date(timestampedEvents[i].timestamp!).getTime();
      const t2 = new Date(timestampedEvents[j].timestamp!).getTime();
      if (Math.abs(t1 - t2) <= 1000) {
        if (areContradictory(timestampedEvents[i].detail, timestampedEvents[j].detail)) {
          issues.push({
            type: "contradictory_events",
            detail: `Events at ${timestampedEvents[i].timestamp} appear contradictory: "${timestampedEvents[i].detail.slice(0, 60)}" vs "${timestampedEvents[j].detail.slice(0, 60)}"`,
          });
        }
      }
    }
  }

  const withTime = timeline.filter(e => e.time && !isNaN(new Date(e.time).getTime()));
  if (withTime.length >= 2) {
    for (let i = 1; i < withTime.length; i++) {
      const gapMs = new Date(withTime[i].time).getTime() - new Date(withTime[i - 1].time).getTime();
      const gapHours = gapMs / (1000 * 60 * 60);
      if (gapHours > LARGE_GAP_HOURS) {
        issues.push({
          type: "large_gap",
          detail: `${Math.round(gapHours)} hour gap between "${withTime[i - 1].event.slice(0, 40)}" and "${withTime[i].event.slice(0, 40)}"`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}
