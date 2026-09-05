import {
  applyFinalizationOutcome,
  createLease,
  createLeaseId,
  isLeaseId,
  markLeaseOrphan,
  markLeaseUserTakeover,
  planLeaseFinalization,
  transferLeaseOnTabReplacement,
  type FinalizationRequest,
  type TabLease,
} from "../leases";
import { createLoadGenerationId, createTabHandle, type EntropySource } from "../lifecycle";

const entropy = (value: number): EntropySource => (length) => new Uint8Array(length).fill(value);
const generation = createLoadGenerationId(entropy(0x11));

function makeLease(overrides: Partial<Parameters<typeof createLease>[0]> = {}): TabLease {
  return createLease({
    tabHandle: createTabHandle(generation, entropy(0x22)),
    loadGenerationId: generation,
    contextId: "context-1",
    browserSessionId: "browser-session-1",
    turnId: "turn-1",
    origin: "created",
    disposition: "ephemeral",
    siteOrigin: "https://example.com",
    identity: {
      browserInstanceId: "browser-instance-1",
      providerTabId: 42,
      providerWindowId: 7,
      documentId: "document-1",
      documentEpoch: 1,
    },
    groupIntentId: "group-intent-1",
    providerGroupId: 5,
    ...overrides,
  });
}

function finalizeRequest(lease: TabLease, overrides: Partial<FinalizationRequest> = {}): FinalizationRequest {
  return {
    tabHandle: lease.tabHandle,
    loadGenerationId: lease.loadGenerationId,
    contextId: lease.contextId,
    browserSessionId: lease.browserSessionId,
    turnId: lease.turnId,
    controlId: "control-1",
    browserInstanceId: lease.identity.browserInstanceId,
    providerTabId: lease.identity.providerTabId,
    providerWindowId: lease.identity.providerWindowId,
    tabExists: true,
    identityIntact: true,
    extensionOwnedGroupIntact: true,
    ...overrides,
  };
}

describe("tab lease finalization", () => {
  it("creates a distinct opaque lease identity separate from the tab handle", () => {
    const lease = makeLease();

    expect(isLeaseId(lease.leaseId)).toBe(true);
    expect(lease.leaseId).not.toBe(lease.tabHandle);
    expect(createLeaseId(() => "123e4567-e89b-42d3-a456-426614174000"))
      .toBe("a0l1.123e4567-e89b-42d3-a456-426614174000");
  });

  it("closes only an exact current-generation created ephemeral lease", () => {
    const lease = makeLease();
    const plan = planLeaseFinalization(lease, finalizeRequest(lease));

    expect(plan).toMatchObject({
      action: "close_exact_tab",
      providerTabId: 42,
      controlId: "control-1",
    });
    expect(plan.lease.state).toBe("finalizing");
    expect(applyFinalizationOutcome(plan.lease, "control-1", "closed").state).toBe("closed");
  });

  it("releases claimed tabs without grouping or closing them", () => {
    const claimed = makeLease({ origin: "claimed", groupIntentId: null, providerGroupId: 91 });
    const plan = planLeaseFinalization(claimed, finalizeRequest(claimed));

    expect(plan).toMatchObject({
      action: "release_tab",
      reason: "claimed_tab",
      ungroup: false,
    });
  });

  it("releases non-ephemeral created tabs and ungroups only an intact owned group", () => {
    const deliverable = makeLease({ disposition: "deliverable" });
    expect(planLeaseFinalization(deliverable, finalizeRequest(deliverable))).toMatchObject({
      action: "release_tab",
      reason: "non_ephemeral",
      ungroup: true,
    });
    expect(
      planLeaseFinalization(
        deliverable,
        finalizeRequest(deliverable, { extensionOwnedGroupIntact: false }),
      ),
    ).toMatchObject({ action: "release_tab", ungroup: false });
  });

  it.each([
    ["generation_mismatch", (lease: TabLease) => ({ loadGenerationId: createLoadGenerationId(entropy(0x33)) })],
    ["context_mismatch", () => ({ contextId: "different-context" })],
    ["identity_mismatch", () => ({ providerTabId: 404 })],
    ["tab_missing", () => ({ tabExists: false })],
  ] as const)("retains on %s", (reason, change) => {
    const lease = makeLease();
    const plan = planLeaseFinalization(lease, finalizeRequest(lease, change(lease)));
    expect(plan).toMatchObject({ action: "retain_tab", reason });
  });

  it("treats uncorrelated user intervention as release-and-retain", () => {
    const lease = { ...makeLease(), overlayAttached: true, debuggerAttached: true };
    const takenOver = markLeaseUserTakeover(lease, "regrouped");

    expect(takenOver).toMatchObject({
      state: "released",
      userIntervened: true,
      retentionReason: "user_takeover",
      overlayAttached: false,
      debuggerAttached: false,
    });
    expect(planLeaseFinalization(takenOver, finalizeRequest(takenOver))).toMatchObject({
      action: "retain_tab",
      reason: "user_takeover",
    });
  });

  it("retains while a correlated group mutation is unresolved", () => {
    const lease = {
      ...makeLease(),
      expectedGroupActionId: "action-group-1",
      expectedGroupWindowId: 7,
      expectedProviderGroupId: 5 as const,
    };
    expect(planLeaseFinalization(lease, finalizeRequest(lease))).toMatchObject({
      action: "retain_tab",
      reason: "unresolved_reconciliation",
    });
  });

  it("never upgrades a lost close result or an orphan into permission to close", () => {
    const lease = makeLease();
    const plan = planLeaseFinalization(lease, finalizeRequest(lease));
    const unknown = applyFinalizationOutcome(plan.lease, "control-1", "result_lost");
    const orphan = markLeaseOrphan(lease);

    expect(unknown.state).toBe("outcome_unknown");
    expect(planLeaseFinalization(unknown, finalizeRequest(unknown))).toMatchObject({
      action: "retain_tab",
      reason: "outcome_unknown",
    });
    expect(planLeaseFinalization(orphan, finalizeRequest(orphan))).toMatchObject({
      action: "retain_tab",
      reason: "unresolved_reconciliation",
    });
  });

  it("preserves terminal state under repeated finalization", () => {
    const lease = makeLease();
    const plan = planLeaseFinalization(lease, finalizeRequest(lease));
    const closed = applyFinalizationOutcome(plan.lease, "control-1", "closed");
    const replay = planLeaseFinalization(closed, finalizeRequest(closed));

    expect(replay).toMatchObject({ action: "retain_tab", reason: "not_active" });
    expect(replay.lease).toBe(closed);
    expect(replay.lease.state).toBe("closed");
  });

  it("transfers provider identity only for an exact tabs.onReplaced match", () => {
    const lease = makeLease();
    expect(transferLeaseOnTabReplacement(lease, 41, 99)).toBe(lease);
    expect(transferLeaseOnTabReplacement(lease, 42, 99)).toMatchObject({
      identity: { providerTabId: 99, documentId: null, documentEpoch: 2 },
    });
  });
});
