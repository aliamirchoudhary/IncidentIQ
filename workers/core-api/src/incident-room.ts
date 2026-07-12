import { DurableObject } from "cloudflare:workers";

export type IncidentState =
  | "Ingested"
  | "TimelineDone"
  | "Validated"
  | "RootCauseDone"
  | "PreventionDone"
  | "AwaitReview"
  | "Finalized";

const ALLOWED_TRANSITIONS: Record<IncidentState, IncidentState[]> = {
  Ingested: ["TimelineDone"],
  TimelineDone: ["Validated"],
  Validated: ["RootCauseDone"],
  RootCauseDone: ["PreventionDone"],
  PreventionDone: ["AwaitReview"],
  AwaitReview: ["Finalized"],
  Finalized: [],
};

const INITIAL_DATA: IncidentData = {
  state: "Ingested",
  version: 1,
  incident: null,
  events: [],
  timeline: null,
  rootCause: null,
  prevention: null,
  report: null,
  validationStatus: null,
};

interface IncidentData {
  state: IncidentState;
  version: number;
  incident: { id: string; title: string; summary: string } | null;
  events: Array<{ timestamp: string | null; detail: string; source?: string }>;
  timeline: unknown;
  rootCause: unknown;
  prevention: unknown;
  report: unknown;
  validationStatus: unknown;
}

export class IncidentRoom extends DurableObject {
  private cached: IncidentData | null = null;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
  }

  private storageKey(): string {
    return `data:${this.ctx.id.toString()}`;
  }

  private async load(): Promise<IncidentData> {
    if (this.cached) return this.cached;
    const key = this.storageKey();
    const stored = await this.ctx.storage.get<IncidentData>(key);
    if (stored) {
      this.cached = stored;
      return stored;
    }
    await this.ctx.storage.put(key, INITIAL_DATA);
    this.cached = INITIAL_DATA;
    return INITIAL_DATA;
  }

  private async save(): Promise<void> {
    if (this.cached) {
      await this.ctx.storage.put(this.storageKey(), this.cached);
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async getState(): Promise<{ state: IncidentState; version: number }> {
    const data = await this.load();
    return { state: data.state, version: data.version };
  }

  async getData(): Promise<IncidentData> {
    return this.load();
  }

  async setIncident(incident: { id: string; title: string; summary: string }): Promise<void> {
    const data = await this.load();
    data.incident = incident;
    await this.save();
  }

  async addEvent(event: { timestamp: string | null; detail: string; source?: string }): Promise<{ state: IncidentState; version: number }> {
    const data = await this.load();
    data.events.push(event);
    await this.save();
    return { state: data.state, version: data.version };
  }

  async transition(target: IncidentState): Promise<{ success: boolean; state?: IncidentState; version?: number; error?: string }> {
    const data = await this.load();
    const allowed = ALLOWED_TRANSITIONS[data.state];

    if (!allowed || !allowed.includes(target)) {
      return {
        success: false,
        error: `Illegal transition: ${data.state} → ${target}. Allowed from ${data.state}: [${(allowed ?? []).join(", ")}]`,
      };
    }

    data.state = target;
    data.version += 1;
    await this.save();

    return { success: true, state: data.state, version: data.version };
  }

  async setAgentResult(slot: "timeline" | "rootCause" | "prevention" | "report", value: unknown): Promise<void> {
    const data = await this.load();
    data[slot] = value;
    await this.save();
  }

  async setValidationStatus(value: unknown): Promise<void> {
    const data = await this.load();
    data.validationStatus = value;
    await this.save();
  }
}
