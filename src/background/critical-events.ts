import {
  buildBrowserAckEventsResult,
  buildBrowserEventParams,
  type BrowserAckEventsRequest,
  type CriticalBrowserEventRecord,
} from "../protocol/browser-events";
import {
  acknowledgeCriticalEvents,
  appendCriticalEvent,
  type DurableLeaseShadow,
  type DurableSafetyLedger,
} from "./journal";
import { NativeRequestError } from "./native-port";
import type { TabLease } from "./leases";
import type { RuntimeStore, StoredFinalizationResult } from "./runtime-store";

type LeaseChange = CriticalBrowserEventRecord & { eventType: "lease.changed" };
type TurnFinalized = CriticalBrowserEventRecord & { eventType: "turn.finalized" };
type ChallengeRequired = CriticalBrowserEventRecord & { eventType: "challenge.required" };

type AppendResult<T extends CriticalBrowserEventRecord> =
  | { ok: true; ledger: DurableSafetyLedger; event: T | null }
  | { ok: false; ledger: DurableSafetyLedger; code: string };

function nextSequence(ledger: DurableSafetyLedger, loadGenerationId: string): number {
  const cursor = ledger.eventAckCursors[loadGenerationId] ?? 0;
  return ledger.criticalEvents
    .filter((event) => event.loadGenerationId === loadGenerationId)
    .reduce((highest, event) => Math.max(highest, event.sequence), cursor) + 1;
}

function leaseTransition(
  previous: DurableLeaseShadow | null,
  lease: TabLease,
): Pick<LeaseChange["data"], "change" | "reasonCode"> | null {
  if (!previous) return { change: "created", reasonCode: null };
  if (previous.state === lease.state) return null;
  if (lease.state === "finalizing") return { change: "finalizing", reasonCode: "FINALIZATION_STARTED" };
  if (lease.state === "closed") {
    return lease.finalizationControlId
      ? { change: "finalized", reasonCode: "FINALIZED_CLOSED" }
      : { change: "tab_closed", reasonCode: "TAB_CLOSED" };
  }
  if (lease.state === "released") {
    return lease.userIntervened || lease.retentionReason === "user_takeover"
      ? { change: "user_takeover", reasonCode: "USER_TAKEOVER" }
      : { change: "finalized", reasonCode: "FINALIZED_RELEASED" };
  }
  if (lease.state === "retained") return { change: "finalized", reasonCode: "FINALIZED_RETAINED" };
  if (lease.state === "outcome_unknown") {
    return { change: "finalized", reasonCode: "FINALIZATION_OUTCOME_UNKNOWN" };
  }
  if (lease.state === "orphan") return { change: "orphaned", reasonCode: "LEASE_ORPHANED" };
  return null;
}

export function appendLeaseChangedEvent(
  ledger: DurableSafetyLedger,
  input: {
    previous: DurableLeaseShadow | null;
    lease: TabLease;
    leaseIdDigest: string;
    browserIdDigest: string;
    opId?: string | null;
    actionId?: string | null;
    now: number;
  },
): AppendResult<LeaseChange> {
  const transition = leaseTransition(input.previous, input.lease);
  if (!transition) return { ok: true, ledger, event: null };
  const event: LeaseChange = {
    eventId: crypto.randomUUID(),
    loadGenerationId: input.lease.loadGenerationId,
    sequence: nextSequence(ledger, input.lease.loadGenerationId),
    delivery: "critical",
    eventType: "lease.changed",
    observedAt: input.now,
    contextId: input.lease.contextId,
    browserSessionId: input.lease.browserSessionId,
    turnId: input.lease.turnId,
    opId: input.opId ?? null,
    actionId: input.actionId ?? null,
    data: {
      leaseIdDigest: input.leaseIdDigest,
      browserIdDigest: input.browserIdDigest,
      state: input.lease.state,
      ownership: input.lease.origin,
      disposition: input.lease.disposition,
      ...transition,
    },
  };
  const appended = appendCriticalEvent(ledger, {
    expectedRevision: ledger.revision,
    event,
    now: input.now,
  });
  return appended.ok
    ? { ok: true, ledger: appended.ledger, event: appended.value as LeaseChange }
    : { ok: false, ledger: appended.ledger, code: appended.code };
}

export function appendTurnFinalizedEvent(
  ledger: DurableSafetyLedger,
  input: {
    loadGenerationId: string;
    contextId: string;
    browserSessionId: string;
    turnId: string;
    controlId: string;
    result: StoredFinalizationResult;
    now: number;
  },
): AppendResult<TurnFinalized> {
  const existing = ledger.criticalEvents.find((event): event is TurnFinalized =>
    event.eventType === "turn.finalized"
    && event.loadGenerationId === input.loadGenerationId
    && event.contextId === input.contextId
    && event.browserSessionId === input.browserSessionId
    && event.turnId === input.turnId
    && event.data.controlId === input.controlId,
  );
  if (existing) return { ok: true, ledger, event: existing };
  const event: TurnFinalized = {
    eventId: crypto.randomUUID(),
    loadGenerationId: input.loadGenerationId,
    sequence: nextSequence(ledger, input.loadGenerationId),
    delivery: "critical",
    eventType: "turn.finalized",
    observedAt: input.now,
    contextId: input.contextId,
    browserSessionId: input.browserSessionId,
    turnId: input.turnId,
    opId: null,
    actionId: null,
    data: {
      controlId: input.controlId,
      status: "completed",
      closedCount: input.result.closed.length,
      releasedCount: input.result.released.length,
      retainedCount: input.result.retained.length,
      alreadyFinalizedCount: input.result.already_finalized.length,
      errorCount: input.result.errors.length,
    },
  };
  const appended = appendCriticalEvent(ledger, {
    expectedRevision: ledger.revision,
    event,
    now: input.now,
  });
  return appended.ok
    ? { ok: true, ledger: appended.ledger, event: appended.value as TurnFinalized }
    : { ok: false, ledger: appended.ledger, code: appended.code };
}

export function appendChallengeRequiredEvent(
  ledger: DurableSafetyLedger,
  input: {
    loadGenerationId: string;
    contextId: string;
    browserSessionId: string;
    turnId: string;
    opId: string;
    actionId: string;
    data: ChallengeRequired["data"];
    now: number;
  },
): AppendResult<ChallengeRequired> {
  const event: ChallengeRequired = {
    eventId: crypto.randomUUID(),
    loadGenerationId: input.loadGenerationId,
    sequence: nextSequence(ledger, input.loadGenerationId),
    delivery: "critical",
    eventType: "challenge.required",
    observedAt: input.now,
    contextId: input.contextId,
    browserSessionId: input.browserSessionId,
    turnId: input.turnId,
    opId: input.opId,
    actionId: input.actionId,
    data: input.data,
  };
  const appended = appendCriticalEvent(ledger, {
    expectedRevision: ledger.revision,
    event,
    now: input.now,
  });
  return appended.ok
    ? { ok: true, ledger: appended.ledger, event: appended.value as ChallengeRequired }
    : { ok: false, ledger: appended.ledger, code: appended.code };
}

export interface CriticalEventTransport {
  browserEvent(event: CriticalBrowserEventRecord): void;
}

export class CriticalEventRelay {
  private connectionKey: string | null = null;
  private deliveryTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Pick<RuntimeStore, "snapshot" | "updateBoth">,
    private readonly transport: CriticalEventTransport,
  ) {}

  activate(connectionKey: string): void {
    if (this.connectionKey === connectionKey) return;
    this.connectionKey = connectionKey;
    this.replayCurrentGeneration();
  }

  deactivate(): void {
    this.connectionKey = null;
  }

  publishPersisted(event: CriticalBrowserEventRecord): void {
    const connectionKey = this.connectionKey;
    if (!connectionKey || event.loadGenerationId !== this.store.snapshot.lifecycle.loadGenerationId) return;
    this.enqueueDelivery(connectionKey, event);
  }

  replayCurrentGeneration(): void {
    const connectionKey = this.connectionKey;
    if (!connectionKey) return;
    const generation = this.store.snapshot.lifecycle.loadGenerationId;
    const pending = this.store.snapshot.ledger.criticalEvents
      .filter((event) => event.loadGenerationId === generation)
      .sort((left, right) => left.sequence - right.sequence);
    for (const event of pending) this.enqueueDelivery(connectionKey, event);
  }

  async acknowledge(request: BrowserAckEventsRequest): Promise<Record<string, unknown>> {
    await this.store.updateBoth((snapshot) => {
      const result = acknowledgeCriticalEvents(snapshot.ledger, {
        expectedRevision: snapshot.ledger.revision,
        loadGenerationId: request.loadGenerationId as typeof snapshot.lifecycle.loadGenerationId,
        highestContiguousSequence: request.highestContiguousEventSequence,
        now: Date.now(),
      });
      if (!result.ok) {
        throw new NativeRequestError(
          "The critical browser event acknowledgement was not contiguous for its generation.",
          result.code === "EVENT_GENERATION_UNKNOWN" ? "INVALID_STATE" : "EVENT_SEQUENCE_GAP",
        );
      }
      return {
        ...snapshot,
        ledger: result.ledger,
        session: request.loadGenerationId === snapshot.lifecycle.loadGenerationId
          ? { ...snapshot.session, lastAckedEventSequence: result.value }
          : snapshot.session,
      };
    });
    return buildBrowserAckEventsResult(request);
  }

  private enqueueDelivery(connectionKey: string, event: CriticalBrowserEventRecord): void {
    this.deliveryTail = this.deliveryTail.then(async () => {
      if (this.connectionKey !== connectionKey) return;
      const snapshot = this.store.snapshot;
      if (
        snapshot.lifecycle.loadGenerationId !== event.loadGenerationId
        || !snapshot.ledger.criticalEvents.some((candidate) =>
          candidate.loadGenerationId === event.loadGenerationId
          && candidate.sequence === event.sequence
          && candidate.eventId === event.eventId,
        )
      ) return;
      try {
        buildBrowserEventParams(event);
        this.transport.browserEvent(event);
      } catch {
        // The durable record remains pending. Native reconnect/reconcile replays it.
      }
    });
  }
}
