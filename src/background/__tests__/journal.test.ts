import {
  acknowledgeCriticalEvents,
  acknowledgeMutation,
  appendCriticalEvent,
  compactDurableLedger,
  createDurableLeaseShadow,
  createDurableSafetyLedger,
  prepareMutation,
  recordCancelControl,
  resetLedgerGeneration,
  transitionDurableLease,
  transitionMutation,
  upsertDurableLease,
  type DurableSafetyLedger,
  type CriticalEventRecord,
  type JournalLimits,
  type JournalResult,
} from "../journal";
import { createLease } from "../leases";
import {
  createInstallInstanceId,
  createLoadGenerationId,
  createTabHandle,
  type EntropySource,
} from "../lifecycle";

const entropy = (value: number): EntropySource => (length) => new Uint8Array(length).fill(value);
const installId = createInstallInstanceId(entropy(0x01));
const generation = createLoadGenerationId(entropy(0x02));
const otherGeneration = createLoadGenerationId(entropy(0x03));
const digest = (value: string) => value.repeat(64).slice(0, 64);
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function requireSuccess<T>(result: JournalResult<T>): { ledger: DurableSafetyLedger; value: T } {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result;
}

function limits(overrides: Partial<JournalLimits> = {}): JournalLimits {
  return {
    softBytes: 4 * 1024 * 1024,
    maxNonterminalOperations: 256,
    maxTerminalOperations: 2_048,
    maxCriticalEvents: 1_024,
    terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    ...overrides,
  };
}

function criticalEvent(
  loadGenerationId: typeof generation,
  sequence: number,
  eventId: string,
  state: "released" | "closed" = "closed",
): CriticalEventRecord {
  return {
    eventId,
    loadGenerationId,
    sequence,
    delivery: "critical",
    eventType: "lease.changed",
    observedAt: sequence,
    contextId: "context-1",
    browserSessionId: "session-1",
    turnId: "turn-1",
    opId: null,
    actionId: null,
    data: {
      leaseIdDigest: hashB,
      browserIdDigest: hashA,
      state,
      ownership: "created",
      disposition: "ephemeral",
      change: state === "released" ? "user_takeover" : "tab_closed",
      reasonCode: state === "released" ? "USER_TAKEOVER" : "TAB_CLOSED",
    },
  };
}

describe("durable MV3 safety journal", () => {
  it("stores only a redacted URL identity and bounded symbolic data", () => {
    const lease = createLease({
      tabHandle: createTabHandle(generation, entropy(0x04)),
      loadGenerationId: generation,
      contextId: "context-1",
      browserSessionId: "session-1",
      turnId: "turn-1",
      origin: "created",
      disposition: "ephemeral",
      siteOrigin: "https://example.com",
      identity: {
        browserInstanceId: "browser-1",
        providerTabId: 10,
        providerWindowId: 5,
        documentId: "document-1",
        documentEpoch: 1,
      },
    });
    const shadow = createDurableLeaseShadow({
      lease,
      rawUrl: "https://example.com/private/form?secret=hunter2#account",
      leaseIdDigest: digest("d"),
      leaseHandleDigest: hashA,
      exactIdentityDigest: hashB,
      digestPath: () => digest("c"),
      now: 1,
    });
    const serialized = JSON.stringify(shadow);

    expect(shadow.urlIdentity).toEqual({ origin: "https://example.com", pathDigest: "c".repeat(64) });
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("account");
    expect(serialized).not.toContain("document-1");
    expect(serialized).not.toContain(lease.leaseId);
    expect(serialized).not.toContain(lease.tabHandle);
  });

  it("requires a prepared write before effect_started and serializes revisions", () => {
    const ledger = createDurableSafetyLedger(installId);
    const prepared = requireSuccess(
      prepareMutation(ledger, {
        expectedRevision: 0,
        loadGenerationId: generation,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashA,
        now: 10,
      }),
    );
    expect(prepared.value).toMatchObject({ disposition: "prepared", record: { stage: "prepared" } });

    expect(
      transitionMutation(prepared.ledger, {
        expectedRevision: 0,
        loadGenerationId: generation,
        actionId: "action-1",
        expectedStage: "prepared",
        stage: "effect_started",
        now: 11,
      }),
    ).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });

    const effectStarted = requireSuccess(
      transitionMutation(prepared.ledger, {
        expectedRevision: 1,
        loadGenerationId: generation,
        actionId: "action-1",
        expectedStage: "prepared",
        stage: "effect_started",
        now: 11,
      }),
    );
    expect(effectStarted.value.stage).toBe("effect_started");
  });

  it("replays equal idempotency records and rejects changed parameters", () => {
    const prepared = requireSuccess(
      prepareMutation(createDurableSafetyLedger(installId), {
        expectedRevision: 0,
        loadGenerationId: generation,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashA,
        now: 10,
      }),
    );
    expect(
      prepareMutation(prepared.ledger, {
        expectedRevision: 1,
        loadGenerationId: generation,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashA,
        now: 11,
      }),
    ).toMatchObject({ ok: true, value: { disposition: "resume_existing" } });
    expect(
      prepareMutation(prepared.ledger, {
        expectedRevision: 1,
        loadGenerationId: generation,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashB,
        now: 11,
      }),
    ).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("records cancellation tombstones and binds control replay to the full request hash", () => {
    const first = requireSuccess(recordCancelControl(createDurableSafetyLedger(installId), {
      expectedRevision: 0,
      controlId: "control-1",
      canonicalRequestHash: hashA,
      status: "canceled",
      safeReceipt: { outcome: "not_applied", code: "CANCELED", leaseHandleDigest: null },
      now: 10,
    }));
    expect(first.value).toMatchObject({ disposition: "recorded", record: { status: "canceled" } });
    expect(recordCancelControl(first.ledger, {
      expectedRevision: 1,
      controlId: "control-1",
      canonicalRequestHash: hashA,
      status: "outcome_unknown",
      safeReceipt: { outcome: "unknown", code: "OUTCOME_UNKNOWN", leaseHandleDigest: null },
      now: 11,
    })).toMatchObject({
      ok: true,
      value: { disposition: "replay_existing", record: { status: "canceled" } },
    });
    expect(recordCancelControl(first.ledger, {
      expectedRevision: 1,
      controlId: "control-1",
      canonicalRequestHash: hashB,
      status: "not_found",
      safeReceipt: null,
      now: 11,
    })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed when the cancellation tombstone bound is exhausted", () => {
    const ledger = {
      ...createDurableSafetyLedger(installId),
      cancelControls: Array.from({ length: 2_048 }, (_, index) => ({
        controlId: `control-${index}`,
        canonicalRequestHash: hashA,
        status: "not_found" as const,
        safeReceipt: null,
        createdAt: index,
      })),
    };
    expect(recordCancelControl(ledger, {
      expectedRevision: 0,
      controlId: "control-overflow",
      canonicalRequestHash: hashA,
      status: "not_found",
      safeReceipt: null,
      now: 2_049,
    })).toMatchObject({ ok: false, code: "JOURNAL_CAPACITY_EXCEEDED" });
  });

  it("converts a stale-generation incomplete duplicate to a durable unknown receipt", () => {
    const prepared = requireSuccess(
      prepareMutation(createDurableSafetyLedger(installId), {
        expectedRevision: 0,
        loadGenerationId: generation,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashA,
        now: 10,
      }),
    );
    const replay = requireSuccess(
      prepareMutation(prepared.ledger, {
        expectedRevision: 1,
        loadGenerationId: otherGeneration,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashA,
        now: 11,
      }),
    );

    expect(replay.value).toMatchObject({
      disposition: "durable_receipt",
      record: {
        stage: "outcome_unknown",
        safeReceipt: { outcome: "unknown", code: "STALE_GENERATION" },
      },
    });
    expect(replay.ledger.revision).toBe(2);
  });

  it("turns incomplete mutations and active leases into unknown retained recovery records on reset", () => {
    let ledger = requireSuccess(
      prepareMutation(createDurableSafetyLedger(installId), {
        expectedRevision: 0,
        loadGenerationId: generation,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashA,
        now: 10,
      }),
    ).ledger;
    const lease = createLease({
      tabHandle: createTabHandle(generation, entropy(0x04)),
      loadGenerationId: generation,
      contextId: "context-1",
      browserSessionId: "session-1",
      turnId: "turn-1",
      origin: "created",
      disposition: "ephemeral",
      siteOrigin: "https://example.com",
      identity: {
        browserInstanceId: "browser-1",
        providerTabId: 10,
        providerWindowId: 5,
        documentId: null,
        documentEpoch: 1,
      },
    });
    const shadow = createDurableLeaseShadow({
      lease,
      rawUrl: "https://example.com/path?private=true",
      leaseIdDigest: digest("d"),
      leaseHandleDigest: hashA,
      exactIdentityDigest: hashB,
      digestPath: () => digest("c"),
      now: 11,
    });
    ledger = requireSuccess(upsertDurableLease(ledger, { expectedRevision: 1, shadow, now: 11 })).ledger;

    const reset = requireSuccess(
      resetLedgerGeneration(ledger, {
        expectedRevision: 2,
        loadGenerationId: otherGeneration,
        now: 12,
      }),
    );
    expect(reset.ledger.operations[0]).toMatchObject({
      stage: "outcome_unknown",
      safeReceipt: { outcome: "unknown", code: "WORKER_GENERATION_RESET" },
    });
    expect(reset.ledger.leases[0].state).toBe("orphan");
  });

  it("transitions a durable lease only through its exact handle and identity digests", () => {
    const lease = createLease({
      tabHandle: createTabHandle(generation, entropy(0x04)),
      loadGenerationId: generation,
      contextId: "context-1",
      browserSessionId: "session-1",
      turnId: "turn-1",
      origin: "created",
      disposition: "ephemeral",
      siteOrigin: "https://example.com",
      identity: {
        browserInstanceId: "browser-1",
        providerTabId: 10,
        providerWindowId: 5,
        documentId: null,
        documentEpoch: 1,
      },
    });
    const shadow = createDurableLeaseShadow({
      lease,
      rawUrl: "https://example.com/path",
      leaseIdDigest: digest("d"),
      leaseHandleDigest: hashA,
      exactIdentityDigest: hashB,
      digestPath: () => digest("c"),
      now: 1,
    });
    const stored = requireSuccess(
      upsertDurableLease(createDurableSafetyLedger(installId), {
        expectedRevision: 0,
        shadow,
        now: 1,
      }),
    );

    expect(
      transitionDurableLease(stored.ledger, {
        expectedRevision: 1,
        expectedLeaseIdDigest: "e".repeat(64),
        leaseHandleDigest: hashA,
        expectedExactIdentityDigest: hashB,
        expectedState: "active",
        state: "finalizing",
        now: 2,
      }),
    ).toMatchObject({ ok: false, code: "LEASE_IDENTITY_MISMATCH" });

    expect(
      transitionDurableLease(stored.ledger, {
        expectedRevision: 1,
        expectedLeaseIdDigest: digest("d"),
        leaseHandleDigest: hashA,
        expectedExactIdentityDigest: "d".repeat(64),
        expectedState: "active",
        state: "finalizing",
        now: 2,
      }),
    ).toMatchObject({ ok: false, code: "LEASE_IDENTITY_MISMATCH" });

    const finalizing = requireSuccess(
      transitionDurableLease(stored.ledger, {
        expectedRevision: 1,
        expectedLeaseIdDigest: digest("d"),
        leaseHandleDigest: hashA,
        expectedExactIdentityDigest: hashB,
        expectedState: "active",
        state: "finalizing",
        finalizationControlId: "control-1",
        now: 2,
      }),
    );
    expect(finalizing.value).toMatchObject({
      state: "finalizing",
      finalizationControlId: "control-1",
    });
    expect(
      transitionDurableLease(finalizing.ledger, {
        expectedRevision: 2,
        expectedLeaseIdDigest: digest("d"),
        leaseHandleDigest: hashA,
        expectedExactIdentityDigest: hashB,
        expectedState: "finalizing",
        state: "closed",
        now: 3,
      }),
    ).toMatchObject({ ok: true, value: { state: "closed" } });
  });

  it("fails closed at operation and event bounds without changing the ledger", () => {
    const tiny = limits({ maxNonterminalOperations: 1, maxCriticalEvents: 1 });
    const first = requireSuccess(
      prepareMutation(
        createDurableSafetyLedger(installId),
        {
          expectedRevision: 0,
          loadGenerationId: generation,
          actionId: "action-1",
          kind: "tabs.open",
          canonicalParameterHash: hashA,
          now: 1,
        },
        tiny,
      ),
    );
    const overflow = prepareMutation(
      first.ledger,
      {
        expectedRevision: 1,
        loadGenerationId: generation,
        actionId: "action-2",
        kind: "tabs.open",
        canonicalParameterHash: hashB,
        now: 2,
      },
      tiny,
    );
    expect(overflow).toMatchObject({ ok: false, code: "JOURNAL_CAPACITY_EXCEEDED" });
    expect(overflow.ledger).toBe(first.ledger);

    const withGeneration = requireSuccess(resetLedgerGeneration(createDurableSafetyLedger(installId), {
      expectedRevision: 0,
      loadGenerationId: generation,
      now: 1,
    })).ledger;
    const event = requireSuccess(
      appendCriticalEvent(
        withGeneration,
        {
          expectedRevision: 1,
          event: criticalEvent(generation, 1, "event-1", "released"),
          now: 1,
        },
        tiny,
      ),
    );
    expect(
      appendCriticalEvent(
        event.ledger,
        {
          expectedRevision: 2,
          event: criticalEvent(generation, 2, "event-2"),
          now: 2,
        },
        tiny,
      ),
    ).toMatchObject({ ok: false, code: "JOURNAL_CAPACITY_EXCEEDED" });
  });

  it("acknowledges events only through a contiguous cursor in the same generation", () => {
    const withGeneration = requireSuccess(resetLedgerGeneration(createDurableSafetyLedger(installId), {
      expectedRevision: 0,
      loadGenerationId: generation,
      now: 1,
    })).ledger;
    const first = requireSuccess(
      appendCriticalEvent(withGeneration, {
        expectedRevision: 1,
        event: criticalEvent(generation, 1, "event-1"),
        now: 1,
      }),
    );
    expect(
      acknowledgeCriticalEvents(first.ledger, {
        expectedRevision: 2,
        loadGenerationId: otherGeneration,
        highestContiguousSequence: 1,
        now: 2,
      }),
    ).toMatchObject({ ok: false, code: "EVENT_GENERATION_UNKNOWN" });
    const acked = requireSuccess(
      acknowledgeCriticalEvents(first.ledger, {
        expectedRevision: 2,
        loadGenerationId: generation,
        highestContiguousSequence: 1,
        now: 2,
      }),
    );
    expect(acked.ledger.criticalEvents).toHaveLength(0);
    expect(acked.ledger.eventAckCursors[generation]).toBe(1);
  });

  it("compacts only acknowledged old safe terminals and never unknown outcomes", () => {
    let ledger = requireSuccess(
      prepareMutation(createDurableSafetyLedger(installId), {
        expectedRevision: 0,
        loadGenerationId: generation,
        actionId: "action-1",
        kind: "tabs.open",
        canonicalParameterHash: hashA,
        now: 1,
      }),
    ).ledger;
    ledger = requireSuccess(
      transitionMutation(ledger, {
        expectedRevision: 1,
        loadGenerationId: generation,
        actionId: "action-1",
        expectedStage: "prepared",
        stage: "failed",
        safeReceipt: { outcome: "not_applied", code: "CHROME_REJECTED", leaseHandleDigest: null },
        now: 2,
      }),
    ).ledger;
    ledger = requireSuccess(acknowledgeMutation(ledger, { expectedRevision: 2, actionId: "action-1", now: 3 })).ledger;
    ledger = requireSuccess(
      prepareMutation(ledger, {
        expectedRevision: 3,
        loadGenerationId: generation,
        actionId: "action-2",
        kind: "tabs.open",
        canonicalParameterHash: hashB,
        now: 4,
      }),
    ).ledger;
    ledger = requireSuccess(
      transitionMutation(ledger, {
        expectedRevision: 4,
        loadGenerationId: generation,
        actionId: "action-2",
        expectedStage: "prepared",
        stage: "outcome_unknown",
        safeReceipt: { outcome: "unknown", code: "RESULT_LOST", leaseHandleDigest: null },
        now: 5,
      }),
    ).ledger;

    const compacted = requireSuccess(
      compactDurableLedger(ledger, {
        expectedRevision: 5,
        now: 3 + 7 * 24 * 60 * 60 * 1_000,
      }),
    );
    expect(compacted.value).toBe(1);
    expect(compacted.ledger.operations).toHaveLength(1);
    expect(compacted.ledger.operations[0]).toMatchObject({ actionId: "action-2", stage: "outcome_unknown" });
  });
});
