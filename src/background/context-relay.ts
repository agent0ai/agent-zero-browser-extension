import type {
  ContextCompleteNotification,
  ContextEvent,
  ContextEventNotification,
  ContextSendMessageResult,
  ContextSnapshotNotification,
  ContextSubscribeInput,
  ContextSubscribeResult,
  ContextSummary,
} from "../protocol/context";

const MAX_LOCAL_CONTEXT_EVENTS = 512;
const MAX_REMEMBERED_ANCHORS = 64;

export interface ContextTransport {
  contextList(limit?: number): Promise<{ contractVersion: 1; contexts: ContextSummary[] }>;
  contextSubscribe(input: ContextSubscribeInput): Promise<ContextSubscribeResult>;
  contextUnsubscribe(contextId: string): Promise<{ contextId: string; unsubscribed: true }>;
  contextSendMessage(input: {
    contextId: string;
    clientMessageId: string;
    text: string;
  }): Promise<ContextSendMessageResult>;
}

export interface ContextProjection {
  summary: ContextSummary;
  events: ContextEvent[];
  lastSequence: number;
  completionStatus: ContextCompleteNotification["status"] | null;
  historyBefore: number | null;
  hasMoreHistory: boolean;
}

export interface ContextPanelView {
  contexts: ContextSummary[];
  selectedContextId: string | null;
  suggestedContextId: string | null;
  selected: ContextProjection | null;
}

type StoredProjection = Omit<ContextProjection, "events"> & { events: Map<number, ContextEvent> };
type Panel = {
  anchorKey: string;
  selectedContextId: string | null;
  publish: (view: ContextPanelView) => void;
};

export class ContextRelayError extends Error {
  constructor(public readonly reasonCode: "CONTEXT_RELAY_INACTIVE" | "CONTEXT_NOT_ADVERTISED" | "PANEL_NOT_CONNECTED") {
    super(reasonCode);
    this.name = "ContextRelayError";
  }
}

export class ContextRelay {
  private connectionKey: string | null = null;
  private readonly advertised = new Map<string, ContextSummary>();
  private readonly projections = new Map<string, StoredProjection>();
  private readonly panels = new Map<string, Panel>();
  private readonly referenceCounts = new Map<string, number>();
  private readonly pendingSubscriptions = new Set<string>();
  private readonly lastSelectionByAnchor = new Map<string, string>();
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly transport: ContextTransport) {}

  activate(connectionKey: string): void {
    if (this.connectionKey === connectionKey) return;
    this.resetConnection(connectionKey);
  }

  deactivate(): void {
    if (this.connectionKey === null) return;
    this.resetConnection(null);
  }

  registerPanel(panelId: string, anchorKey: string, publish: Panel["publish"]): ContextPanelView {
    if (this.panels.has(panelId)) throw new ContextRelayError("PANEL_NOT_CONNECTED");
    this.panels.set(panelId, { anchorKey, selectedContextId: null, publish });
    return this.view(panelId);
  }

  async unregisterPanel(panelId: string): Promise<void> {
    await this.mutate(async () => {
      const panel = this.panels.get(panelId);
      if (!panel) return;
      this.panels.delete(panelId);
      if (!panel.selectedContextId) return;
      this.rememberSelection(panel.anchorKey, panel.selectedContextId);
      await this.releaseReference(panel.selectedContextId);
    });
  }

  async list(panelId: string): Promise<ContextPanelView> {
    return await this.mutate(async () => {
      const connectionKey = this.requireActive();
      this.requirePanel(panelId);
      const result = await this.transport.contextList(64);
      if (connectionKey !== this.connectionKey) throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
      const advertisedIds = new Set(result.contexts.map((context) => context.contextId));
      this.advertised.clear();
      for (const context of result.contexts) {
        this.advertised.set(context.contextId, { ...context });
        const projection = this.projections.get(context.contextId);
        if (projection) projection.summary = { ...context };
      }
      for (const contextId of [...this.projections.keys()]) {
        if (!advertisedIds.has(contextId)) this.projections.delete(contextId);
      }
      for (const [id, panel] of this.panels) {
        if (panel.selectedContextId && !advertisedIds.has(panel.selectedContextId)) {
          if (this.lastSelectionByAnchor.get(panel.anchorKey) === panel.selectedContextId) {
            this.lastSelectionByAnchor.delete(panel.anchorKey);
          }
          panel.selectedContextId = null;
        }
        this.publish(id);
      }
      this.referenceCounts.clear();
      for (const panel of this.panels.values()) {
        if (panel.selectedContextId) {
          this.referenceCounts.set(
            panel.selectedContextId,
            (this.referenceCounts.get(panel.selectedContextId) ?? 0) + 1,
          );
        }
      }
      return this.view(panelId);
    });
  }

  async subscribe(panelId: string, input: Omit<ContextSubscribeInput, "contextId"> & { contextId: string }): Promise<ContextPanelView> {
    return await this.mutate(async () => {
      const connectionKey = this.requireActive();
      const panel = this.requirePanel(panelId);
      if (!this.advertised.has(input.contextId)) throw new ContextRelayError("CONTEXT_NOT_ADVERTISED");

      if (panel.selectedContextId === input.contextId) {
        if (input.from !== undefined || input.history !== undefined || input.historyBefore !== undefined) {
          const acknowledgement = await this.transport.contextSubscribe(input);
          this.assertCurrentSubscription(connectionKey, input.contextId, acknowledgement);
          this.applyAcknowledgement(input.contextId, acknowledgement);
          this.publishSelected(input.contextId);
        }
        return this.view(panelId);
      }

      const previousContextId = panel.selectedContextId;
      if ((this.referenceCounts.get(input.contextId) ?? 0) === 0) {
        this.pendingSubscriptions.add(input.contextId);
        try {
          const acknowledgement = await this.transport.contextSubscribe(input);
          this.assertCurrentSubscription(connectionKey, input.contextId, acknowledgement);
          this.applyAcknowledgement(input.contextId, acknowledgement);
        } finally {
          this.pendingSubscriptions.delete(input.contextId);
        }
      }
      if (connectionKey !== this.connectionKey || !this.panels.has(panelId)) {
        throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
      }
      panel.selectedContextId = input.contextId;
      this.referenceCounts.set(input.contextId, (this.referenceCounts.get(input.contextId) ?? 0) + 1);
      this.rememberSelection(panel.anchorKey, input.contextId);
      if (previousContextId) await this.releaseReference(previousContextId);
      this.publish(panelId);
      return this.view(panelId);
    });
  }

  async unsubscribe(panelId: string, contextId: string): Promise<ContextPanelView> {
    return await this.mutate(async () => {
      this.requireActive();
      const panel = this.requirePanel(panelId);
      if (panel.selectedContextId !== contextId) throw new ContextRelayError("CONTEXT_NOT_ADVERTISED");
      panel.selectedContextId = null;
      this.lastSelectionByAnchor.delete(panel.anchorKey);
      await this.releaseReference(contextId);
      this.publish(panelId);
      return this.view(panelId);
    });
  }

  async sendMessage(
    panelId: string,
    input: { contextId: string; clientMessageId: string; text: string },
  ): Promise<ContextSendMessageResult> {
    const connectionKey = this.requireActive();
    const panel = this.requirePanel(panelId);
    if (
      panel.selectedContextId !== input.contextId
      || !this.advertised.has(input.contextId)
      || (this.referenceCounts.get(input.contextId) ?? 0) < 1
    ) {
      throw new ContextRelayError("CONTEXT_NOT_ADVERTISED");
    }
    const result = await this.transport.contextSendMessage(input);
    if (
      connectionKey !== this.connectionKey
      || result.contextId !== input.contextId
      || result.clientMessageId !== input.clientMessageId
    ) {
      throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
    }
    return result;
  }

  acceptSnapshot(snapshot: ContextSnapshotNotification): void {
    if (!this.accepts(snapshot.contextId)) return;
    const projection = this.projection(snapshot.contextId);
    for (const event of snapshot.events) {
      if (!projection.events.has(event.sequence)) projection.events.set(event.sequence, cloneEvent(event));
    }
    projection.lastSequence = Math.max(projection.lastSequence, snapshot.lastSequence);
    projection.completionStatus = snapshot.complete ? "completed" : null;
    if (snapshot.historyBefore !== undefined) {
      projection.historyBefore = snapshot.historyBefore;
      projection.hasMoreHistory = snapshot.hasMoreHistory === true;
    }
    this.enforceEventBound();
    this.publishSelected(snapshot.contextId);
  }

  acceptEvent(event: ContextEventNotification): void {
    if (!this.accepts(event.contextId)) return;
    const projection = this.projection(event.contextId);
    // A streaming log item keeps its stable sequence while its projected text
    // advances. Older paged snapshots above intentionally never overwrite it.
    projection.events.set(event.sequence, cloneEvent(event));
    projection.lastSequence = Math.max(projection.lastSequence, event.lastSequence);
    projection.completionStatus = null;
    this.enforceEventBound();
    this.publishSelected(event.contextId);
  }

  acceptComplete(completion: ContextCompleteNotification): void {
    if (!this.accepts(completion.contextId)) return;
    this.projection(completion.contextId).completionStatus = completion.status;
    this.publishSelected(completion.contextId);
  }

  private resetConnection(connectionKey: string | null): void {
    if (this.connectionKey !== connectionKey) this.lastSelectionByAnchor.clear();
    this.connectionKey = connectionKey;
    this.advertised.clear();
    this.projections.clear();
    this.referenceCounts.clear();
    this.pendingSubscriptions.clear();
    for (const [panelId, panel] of this.panels) {
      panel.selectedContextId = null;
      this.publish(panelId);
    }
  }

  private requireActive(): string {
    if (!this.connectionKey) throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
    return this.connectionKey;
  }

  private requirePanel(panelId: string): Panel {
    const panel = this.panels.get(panelId);
    if (!panel) throw new ContextRelayError("PANEL_NOT_CONNECTED");
    return panel;
  }

  private accepts(contextId: string): boolean {
    return this.connectionKey !== null
      && this.advertised.has(contextId)
      && ((this.referenceCounts.get(contextId) ?? 0) > 0 || this.pendingSubscriptions.has(contextId));
  }

  private projection(contextId: string): StoredProjection {
    const existing = this.projections.get(contextId);
    if (existing) return existing;
    const summary = this.advertised.get(contextId);
    if (!summary) throw new ContextRelayError("CONTEXT_NOT_ADVERTISED");
    const created: StoredProjection = {
      summary: { ...summary },
      events: new Map(),
      lastSequence: 0,
      completionStatus: null,
      historyBefore: null,
      hasMoreHistory: false,
    };
    this.projections.set(contextId, created);
    return created;
  }

  private applyAcknowledgement(contextId: string, result: ContextSubscribeResult): void {
    const projection = this.projection(contextId);
    projection.lastSequence = Math.max(projection.lastSequence, result.lastSequence);
    if (result.historyBefore !== undefined) {
      projection.historyBefore = result.historyBefore;
      projection.hasMoreHistory = result.hasMoreHistory === true;
    }
  }

  private assertCurrentSubscription(
    connectionKey: string,
    contextId: string,
    result: ContextSubscribeResult,
  ): void {
    if (connectionKey !== this.connectionKey || result.contextId !== contextId) {
      throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
    }
  }

  private async releaseReference(contextId: string): Promise<void> {
    const references = Math.max((this.referenceCounts.get(contextId) ?? 1) - 1, 0);
    if (references > 0) {
      this.referenceCounts.set(contextId, references);
      return;
    }
    this.referenceCounts.delete(contextId);
    if (!this.connectionKey) return;
    try {
      const result = await this.transport.contextUnsubscribe(contextId);
      if (result.contextId !== contextId) throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
    } catch {
      // Presentation teardown remains local even if the generation disappears mid-unsubscribe.
    }
  }

  private rememberSelection(anchorKey: string, contextId: string): void {
    this.lastSelectionByAnchor.delete(anchorKey);
    this.lastSelectionByAnchor.set(anchorKey, contextId);
    while (this.lastSelectionByAnchor.size > MAX_REMEMBERED_ANCHORS) {
      const oldest = this.lastSelectionByAnchor.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lastSelectionByAnchor.delete(oldest);
    }
  }

  private view(panelId: string): ContextPanelView {
    const panel = this.requirePanel(panelId);
    const selected = panel.selectedContextId ? this.projections.get(panel.selectedContextId) : undefined;
    const remembered = this.lastSelectionByAnchor.get(panel.anchorKey);
    return {
      contexts: [...this.advertised.values()].map((context) => ({ ...context })),
      selectedContextId: panel.selectedContextId,
      suggestedContextId: !panel.selectedContextId && remembered && this.advertised.has(remembered) ? remembered : null,
      selected: selected ? cloneProjection(selected) : null,
    };
  }

  private publish(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    try {
      panel.publish(this.view(panelId));
    } catch {
      // Port teardown is handled by the caller's disconnect listener.
    }
  }

  private publishSelected(contextId: string): void {
    for (const [panelId, panel] of this.panels) {
      if (panel.selectedContextId === contextId) this.publish(panelId);
    }
  }

  private enforceEventBound(): void {
    let total = [...this.projections.values()].reduce((count, projection) => count + projection.events.size, 0);
    while (total > MAX_LOCAL_CONTEXT_EVENTS) {
      let candidate: StoredProjection | null = null;
      let sequence = Number.POSITIVE_INFINITY;
      for (const projection of this.projections.values()) {
        const first = Math.min(...projection.events.keys());
        if (first < sequence) {
          candidate = projection;
          sequence = first;
        }
      }
      if (!candidate || !Number.isFinite(sequence)) break;
      candidate.events.delete(sequence);
      total -= 1;
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function cloneEvent(event: ContextEvent): ContextEvent {
  return { ...event, data: { ...event.data } } as ContextEvent;
}

function cloneProjection(projection: StoredProjection): ContextProjection {
  return {
    summary: { ...projection.summary },
    events: [...projection.events.values()].sort((left, right) => left.sequence - right.sequence).map(cloneEvent),
    lastSequence: projection.lastSequence,
    completionStatus: projection.completionStatus,
    historyBefore: projection.historyBefore,
    hasMoreHistory: projection.hasMoreHistory,
  };
}
