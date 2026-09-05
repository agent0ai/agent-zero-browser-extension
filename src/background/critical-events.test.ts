import { describe, expect, it, vi } from "vitest";

import type { CriticalBrowserEventRecord } from "../protocol/browser-events";
import { createInstallInstanceId, createLoadGenerationId, type EntropySource } from "./lifecycle";
import {
  appendCriticalEvent,
  createDurableSafetyLedger,
  resetLedgerGeneration,
  type DurableSafetyLedger,
} from "./journal";
import { CriticalEventRelay } from "./critical-events";
import type { RuntimeStore, RuntimeStoreSnapshot } from "./runtime-store";

const entropy = (byte: number): EntropySource => (length) => new Uint8Array(length).fill(byte);
const generation = createLoadGenerationId(entropy(2));
const otherGeneration = createLoadGenerationId(entropy(3));
const DIGEST = "a".repeat(64);

function event(sequence: number): CriticalBrowserEventRecord {
  return {
    eventId: `event-${sequence}`,
    loadGenerationId: generation,
    sequence,
    delivery: "critical",
    eventType: "lease.changed",
    observedAt: sequence,
    contextId: "context-one",
    browserSessionId: "session-one",
    turnId: "turn-one",
    opId: null,
    actionId: null,
    data: {
      leaseIdDigest: DIGEST,
      browserIdDigest: DIGEST,
      state: "closed",
      ownership: "created",
      disposition: "ephemeral",
      change: "tab_closed",
      reasonCode: "TAB_CLOSED",
    },
  };
}

function ledgerWith(...events: CriticalBrowserEventRecord[]): DurableSafetyLedger {
  const reset = resetLedgerGeneration(createDurableSafetyLedger(createInstallInstanceId(entropy(1))), {
    expectedRevision: 0,
    loadGenerationId: generation,
    now: 1,
  });
  if (!reset.ok) throw new Error(reset.code);
  let ledger = reset.ledger;
  for (const item of events) {
    const appended = appendCriticalEvent(ledger, {
      expectedRevision: ledger.revision,
      event: item,
      now: item.observedAt,
    });
    if (!appended.ok) throw new Error(appended.code);
    ledger = appended.ledger;
  }
  return ledger;
}

function fixture(initialLedger: DurableSafetyLedger) {
  let snapshot = {
    lifecycle: { loadGenerationId: generation },
    ledger: initialLedger,
    session: { lastAckedEventSequence: 0 },
  } as unknown as RuntimeStoreSnapshot;
  const store = {
    get snapshot() { return snapshot; },
    updateBoth: async (reducer: (value: RuntimeStoreSnapshot) => RuntimeStoreSnapshot) => {
      snapshot = reducer(snapshot);
      return snapshot;
    },
  } as Pick<RuntimeStore, "snapshot" | "updateBoth">;
  const browserEvent = vi.fn();
  const relay = new CriticalEventRelay(store, { browserEvent });
  return { relay, browserEvent, snapshot: () => snapshot };
}

describe("critical event relay", () => {
  it("replays persisted current-generation events in order on activation", async () => {
    const { relay, browserEvent } = fixture(ledgerWith(event(1), event(2)));
    relay.activate("connection-one");
    await vi.waitFor(() => expect(browserEvent).toHaveBeenCalledTimes(2));
    expect(browserEvent.mock.calls.map(([item]) => item.sequence)).toEqual([1, 2]);
  });

  it("never sends an event before its exact durable record exists", async () => {
    const pending = event(1);
    const { relay, browserEvent } = fixture(ledgerWith());
    relay.activate("connection-one");
    relay.publishPersisted(pending);
    await Promise.resolve();
    await Promise.resolve();
    expect(browserEvent).not.toHaveBeenCalled();
  });

  it("prunes only a contiguous cursor for the exact generation", async () => {
    const { relay, snapshot } = fixture(ledgerWith(event(1), event(2)));
    await expect(relay.acknowledge({
      contractVersion: 1,
      loadGenerationId: otherGeneration,
      highestContiguousEventSequence: 1,
    })).rejects.toMatchObject({ a0Code: "INVALID_STATE" });
    expect(snapshot().ledger.criticalEvents).toHaveLength(2);

    await expect(relay.acknowledge({
      contractVersion: 1,
      loadGenerationId: generation,
      highestContiguousEventSequence: 2,
    })).resolves.toEqual({
      contract_version: 1,
      load_generation_id: generation,
      highest_contiguous_event_sequence: 2,
      status: "acknowledged",
    });
    expect(snapshot().ledger.criticalEvents).toHaveLength(0);
    expect(snapshot().ledger.eventAckCursors[generation]).toBe(2);
    expect(snapshot().session.lastAckedEventSequence).toBe(2);
  });
});
