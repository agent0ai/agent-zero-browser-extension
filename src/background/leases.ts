import {
  tabHandleBelongsToGeneration,
  type LoadGenerationId,
  type TabHandle,
} from "./lifecycle";

export type LeaseOrigin = "created" | "claimed";
export type LeaseDisposition = "ephemeral" | "deliverable" | "handoff";
export type LeaseState =
  | "active"
  | "finalizing"
  | "closed"
  | "released"
  | "retained"
  | "outcome_unknown"
  | "orphan";

export type UserTakeoverReason =
  | "moved"
  | "pinned"
  | "unpinned"
  | "ungrouped"
  | "regrouped"
  | "shared_group"
  | "window_changed"
  | "other";

export type RetentionReason =
  | "user_takeover"
  | "claimed_tab"
  | "non_ephemeral"
  | "generation_mismatch"
  | "handle_mismatch"
  | "context_mismatch"
  | "browser_session_mismatch"
  | "turn_mismatch"
  | "control_mismatch"
  | "identity_mismatch"
  | "tab_missing"
  | "protected"
  | "ambiguous"
  | "unresolved_reconciliation"
  | "not_active"
  | "outcome_unknown";

export interface ExactTabIdentity {
  browserInstanceId: string;
  providerTabId: number;
  providerWindowId: number;
  documentId: string | null;
  documentEpoch: number;
}

export interface TabLease {
  leaseId: string;
  tabHandle: TabHandle;
  loadGenerationId: LoadGenerationId;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  origin: LeaseOrigin;
  disposition: LeaseDisposition;
  state: LeaseState;
  siteOrigin: string;
  identity: ExactTabIdentity;
  groupIntentId: string | null;
  providerGroupId: number | null;
  expectedGroupActionId: string | null;
  expectedGroupWindowId: number | null;
  expectedProviderGroupId: number | "new" | null;
  finalizationControlId: string | null;
  userIntervened: boolean;
  userTakeoverReason: UserTakeoverReason | null;
  isProtected: boolean;
  isAmbiguous: boolean;
  unresolvedReconciliation: boolean;
  overlayAttached: boolean;
  debuggerAttached: boolean;
  retentionReason: RetentionReason | null;
  revision: number;
}

export interface CreateLeaseInput {
  tabHandle: TabHandle;
  loadGenerationId: LoadGenerationId;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  origin: LeaseOrigin;
  disposition: LeaseDisposition;
  siteOrigin: string;
  identity: ExactTabIdentity;
  groupIntentId?: string | null;
  providerGroupId?: number | null;
  isProtected?: boolean;
}

export interface FinalizationRequest {
  tabHandle: TabHandle;
  loadGenerationId: LoadGenerationId;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  controlId: string;
  browserInstanceId: string;
  providerTabId: number;
  providerWindowId: number;
  tabExists: boolean;
  identityIntact: boolean;
  extensionOwnedGroupIntact: boolean;
}

export type FinalizationPlan =
  | {
      action: "close_exact_tab";
      controlId: string;
      providerTabId: number;
      removeOverlay: boolean;
      detachDebugger: boolean;
      lease: TabLease;
    }
  | {
      action: "release_tab";
      controlId: string;
      providerTabId: number;
      ungroup: boolean;
      removeOverlay: boolean;
      detachDebugger: boolean;
      reason: "claimed_tab" | "non_ephemeral";
      lease: TabLease;
    }
  | {
      action: "retain_tab";
      controlId: string;
      providerTabId: number;
      removeOverlay: boolean;
      detachDebugger: boolean;
      reason: RetentionReason;
      lease: TabLease;
    };

function requireBoundedId(name: string, value: string, maxLength = 256): void {
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be a non-empty bounded identifier.`);
  }
}

function requireProviderId(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function normalizeSiteOrigin(siteOrigin: string): string {
  const parsed = new URL(siteOrigin);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== siteOrigin) {
    throw new Error("siteOrigin must be an exact HTTP(S) origin.");
  }
  return parsed.origin;
}

const LEASE_ID_PATTERN = /^a0l1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isLeaseId(value: unknown): value is string {
  return typeof value === "string" && LEASE_ID_PATTERN.test(value);
}

export function createLeaseId(randomUuid: () => string = () => crypto.randomUUID()): string {
  const leaseId = `a0l1.${randomUuid()}`;
  if (!isLeaseId(leaseId)) throw new Error("Lease entropy source returned an invalid UUID.");
  return leaseId;
}

export function createLease(input: CreateLeaseInput): TabLease {
  if (!tabHandleBelongsToGeneration(input.tabHandle, input.loadGenerationId)) {
    throw new Error("Tab handle does not belong to the lease generation.");
  }
  requireBoundedId("contextId", input.contextId);
  requireBoundedId("browserSessionId", input.browserSessionId);
  requireBoundedId("turnId", input.turnId);
  requireBoundedId("browserInstanceId", input.identity.browserInstanceId);
  requireProviderId("providerTabId", input.identity.providerTabId);
  requireProviderId("providerWindowId", input.identity.providerWindowId);
  requireProviderId("documentEpoch", input.identity.documentEpoch);
  if (input.identity.documentId !== null) {
    requireBoundedId("documentId", input.identity.documentId);
  }
  if (input.groupIntentId) {
    requireBoundedId("groupIntentId", input.groupIntentId);
  }
  if (input.providerGroupId !== null && input.providerGroupId !== undefined) {
    requireProviderId("providerGroupId", input.providerGroupId);
  }
  if (input.origin === "claimed" && input.groupIntentId) {
    throw new Error("Claimed tabs cannot join an extension-owned group intent.");
  }

  return {
    leaseId: createLeaseId(),
    tabHandle: input.tabHandle,
    loadGenerationId: input.loadGenerationId,
    contextId: input.contextId,
    browserSessionId: input.browserSessionId,
    turnId: input.turnId,
    origin: input.origin,
    disposition: input.disposition,
    state: "active",
    siteOrigin: normalizeSiteOrigin(input.siteOrigin),
    identity: { ...input.identity },
    groupIntentId: input.origin === "created" ? input.groupIntentId ?? null : null,
    providerGroupId: input.providerGroupId ?? null,
    expectedGroupActionId: null,
    expectedGroupWindowId: null,
    expectedProviderGroupId: null,
    finalizationControlId: null,
    userIntervened: false,
    userTakeoverReason: null,
    isProtected: input.isProtected ?? false,
    isAmbiguous: false,
    unresolvedReconciliation: false,
    overlayAttached: false,
    debuggerAttached: false,
    retentionReason: null,
    revision: 0,
  };
}

export function markLeaseUserTakeover(lease: TabLease, reason: UserTakeoverReason): TabLease {
  if (lease.state !== "active" && lease.state !== "finalizing") {
    return lease;
  }
  return {
    ...lease,
    state: "released",
    userIntervened: true,
    userTakeoverReason: reason,
    overlayAttached: false,
    debuggerAttached: false,
    expectedGroupActionId: null,
    expectedGroupWindowId: null,
    expectedProviderGroupId: null,
    finalizationControlId: null,
    retentionReason: "user_takeover",
    revision: lease.revision + 1,
  };
}

export function markLeaseOrphan(lease: TabLease): TabLease {
  return {
    ...lease,
    state: "orphan",
    overlayAttached: false,
    debuggerAttached: false,
    expectedGroupActionId: null,
    expectedGroupWindowId: null,
    expectedProviderGroupId: null,
    finalizationControlId: null,
    unresolvedReconciliation: true,
    retentionReason: "unresolved_reconciliation",
    revision: lease.revision + 1,
  };
}

function retainPlan(lease: TabLease, request: FinalizationRequest, reason: RetentionReason): FinalizationPlan {
  const alreadyTerminal = lease.state !== "active" && lease.state !== "finalizing";
  const state: LeaseState = alreadyTerminal
    ? lease.state
    : reason === "user_takeover"
      ? "released"
      : "retained";
  const retentionReason = alreadyTerminal ? lease.retentionReason : reason;
  const unchanged =
    lease.state === state &&
    !lease.overlayAttached &&
    !lease.debuggerAttached &&
    lease.expectedGroupActionId === null &&
    lease.expectedGroupWindowId === null &&
    lease.expectedProviderGroupId === null &&
    lease.retentionReason === retentionReason;
  return {
    action: "retain_tab",
    controlId: request.controlId,
    providerTabId: lease.identity.providerTabId,
    removeOverlay: lease.overlayAttached,
    detachDebugger: lease.debuggerAttached,
    reason,
    lease: unchanged
      ? lease
      : {
          ...lease,
          state,
          overlayAttached: false,
          debuggerAttached: false,
          expectedGroupActionId: null,
          expectedGroupWindowId: null,
          expectedProviderGroupId: null,
          retentionReason,
          revision: lease.revision + 1,
        },
  };
}

export function planLeaseFinalization(lease: TabLease, request: FinalizationRequest): FinalizationPlan {
  requireBoundedId("controlId", request.controlId);

  if (
    request.loadGenerationId !== lease.loadGenerationId ||
    !tabHandleBelongsToGeneration(lease.tabHandle, request.loadGenerationId)
  ) {
    return retainPlan(lease, request, "generation_mismatch");
  }
  if (request.tabHandle !== lease.tabHandle) {
    return retainPlan(lease, request, "handle_mismatch");
  }
  if (request.contextId !== lease.contextId) {
    return retainPlan(lease, request, "context_mismatch");
  }
  if (request.browserSessionId !== lease.browserSessionId) {
    return retainPlan(lease, request, "browser_session_mismatch");
  }
  if (request.turnId !== lease.turnId) {
    return retainPlan(lease, request, "turn_mismatch");
  }
  if (lease.finalizationControlId !== null && lease.finalizationControlId !== request.controlId) {
    return retainPlan(lease, request, "control_mismatch");
  }
  if (lease.userIntervened || lease.retentionReason === "user_takeover") {
    return retainPlan(lease, request, "user_takeover");
  }
  if (lease.isProtected) {
    return retainPlan(lease, request, "protected");
  }
  if (lease.isAmbiguous) {
    return retainPlan(lease, request, "ambiguous");
  }
  if (lease.unresolvedReconciliation) {
    return retainPlan(lease, request, "unresolved_reconciliation");
  }
  if (lease.expectedGroupActionId !== null) {
    return retainPlan(lease, request, "unresolved_reconciliation");
  }
  if (lease.state === "outcome_unknown") {
    return retainPlan(lease, request, "outcome_unknown");
  }
  if (lease.state !== "active" && lease.state !== "finalizing") {
    return retainPlan(lease, request, "not_active");
  }
  if (!request.tabExists) {
    return retainPlan(lease, request, "tab_missing");
  }
  if (
    !request.identityIntact ||
    request.browserInstanceId !== lease.identity.browserInstanceId ||
    request.providerTabId !== lease.identity.providerTabId ||
    request.providerWindowId !== lease.identity.providerWindowId
  ) {
    return retainPlan(lease, request, "identity_mismatch");
  }

  const finalizingLease: TabLease = {
    ...lease,
    state: "finalizing",
    finalizationControlId: request.controlId,
    revision: lease.finalizationControlId === request.controlId ? lease.revision : lease.revision + 1,
  };

  if (lease.origin === "claimed") {
    return {
      action: "release_tab",
      controlId: request.controlId,
      providerTabId: lease.identity.providerTabId,
      ungroup: false,
      removeOverlay: lease.overlayAttached,
      detachDebugger: lease.debuggerAttached,
      reason: "claimed_tab",
      lease: finalizingLease,
    };
  }
  if (lease.disposition !== "ephemeral") {
    return {
      action: "release_tab",
      controlId: request.controlId,
      providerTabId: lease.identity.providerTabId,
      ungroup: Boolean(
        request.extensionOwnedGroupIntact && lease.groupIntentId !== null && lease.providerGroupId !== null,
      ),
      removeOverlay: lease.overlayAttached,
      detachDebugger: lease.debuggerAttached,
      reason: "non_ephemeral",
      lease: finalizingLease,
    };
  }

  return {
    action: "close_exact_tab",
    controlId: request.controlId,
    providerTabId: lease.identity.providerTabId,
    removeOverlay: lease.overlayAttached,
    detachDebugger: lease.debuggerAttached,
    lease: finalizingLease,
  };
}

export type FinalizationEffectOutcome = "closed" | "released" | "retained" | "result_lost";

export function applyFinalizationOutcome(
  lease: TabLease,
  controlId: string,
  outcome: FinalizationEffectOutcome,
): TabLease {
  if (lease.state !== "finalizing" || lease.finalizationControlId !== controlId) {
    return lease;
  }
  const state: LeaseState = outcome === "result_lost" ? "outcome_unknown" : outcome;
  return {
    ...lease,
    state,
    overlayAttached: false,
    debuggerAttached: false,
    expectedGroupActionId: null,
    expectedGroupWindowId: null,
    expectedProviderGroupId: null,
    retentionReason:
      outcome === "retained" ? lease.retentionReason ?? "unresolved_reconciliation" : lease.retentionReason,
    revision: lease.revision + 1,
  };
}

export function transferLeaseOnTabReplacement(
  lease: TabLease,
  removedProviderTabId: number,
  addedProviderTabId: number,
): TabLease {
  requireProviderId("addedProviderTabId", addedProviderTabId);
  if (lease.state !== "active" || lease.identity.providerTabId !== removedProviderTabId) {
    return lease;
  }
  return {
    ...lease,
    identity: {
      ...lease.identity,
      providerTabId: addedProviderTabId,
      documentId: null,
      documentEpoch: lease.identity.documentEpoch + 1,
    },
    revision: lease.revision + 1,
  };
}
