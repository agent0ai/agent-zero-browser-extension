import {
  createLoadGenerationId,
  createInstallInstanceId,
  createWorkerBootId,
  isLoadGenerationId,
  isTabHandle,
  persistedLifecycleProjection,
  planLifecycleBoot,
  transitionLifecycle,
  type InstallInstanceId,
  type LifecyclePhase,
  type LifecycleState,
  type LoadGenerationId,
} from "./lifecycle";
import { createGroupRegistry, type GroupRegistry } from "./groups";
import {
  createDurableSafetyLedger,
  resetLedgerGeneration,
  type DurableSafetyLedger,
} from "./journal";
import { isLeaseId, type TabLease } from "./leases";
import type { NativeConnectionSnapshot } from "./native-port";
import { parseActionDataClassification, type ActionDataClassification } from "../protocol/challenges";

export const LOCAL_LEDGER_KEY = "a0.browser-bridge.local-ledger.v1" as const;
export const SESSION_RUNTIME_KEY = "a0.browser-bridge.session-runtime.v1" as const;
export const LEGACY_BACKGROUND_KEY = "agent-zero-chrome-background" as const;
export const LOCAL_ACTIVATION_EVIDENCE_KEY = "a0.browser-bridge.activation-evidence.v1" as const;

const SESSION_SCHEMA_VERSION = 1 as const;
const ACTIVATION_EVIDENCE_SCHEMA_VERSION = 1 as const;
const INSTALL_ID_PATTERN = /^a0i1\.[0-9a-f]{32}$/u;

export interface LocalActivationEvidenceReceipt {
  schemaVersion: typeof ACTIVATION_EVIDENCE_SCHEMA_VERSION;
  storageMigrationState: "v1_ready";
  legacyControlPlaneInactive: true;
  legacyStorageKeyRemoved: typeof LEGACY_BACKGROUND_KEY;
}

export interface RuntimeSessionProjection {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  projectionRevision: number;
  lifecycle: ReturnType<typeof persistedLifecycleProjection>;
  phase: LifecyclePhase;
  browserInstanceId: string;
  leasesByHandle: Record<string, TabLease>;
  groups: GroupRegistry;
  connection: NativeConnectionSnapshot;
  lastAckedEventSequence: number;
  reconnectAttempt: number;
  nextReconnectAtMs: number | null;
  stagedCandidate: StagedTabCandidate | null;
  finalizedTurns: readonly FinalizedTurnBarrier[];
  finalizationControls: readonly FinalizationControlRecord[];
  pendingChallenges: readonly PendingBrowserChallenge[];
}

export interface PendingSiteChallenge {
  challengeId: string;
  loadGenerationId: LoadGenerationId;
  leaseId: string;
  tabHandle: string;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  opId: string;
  actionId: string;
  sourceOrigin: string;
  destinationOrigin: string;
  documentId: string | null;
  documentEpoch: number;
  canonicalParameterHash: string;
  targetFingerprint: string;
  expiresAtMs: number;
}

export interface PendingActionChallenge {
  challengeId: string;
  loadGenerationId: LoadGenerationId;
  leaseId: string;
  tabHandle: string;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  opId: string;
  actionId: string;
  sourceOrigin: string;
  documentId: string;
  documentEpoch: number;
  canonicalParameterHash: string;
  targetFingerprint: string;
  actionClass: "sensitive_input" | "external_side_effect" | "unknown";
  dataClassification: ActionDataClassification;
  expiresAtMs: number;
}

export type PendingBrowserChallenge = PendingSiteChallenge | PendingActionChallenge;

export interface FinalizedTurnBarrier {
  contextId: string;
  browserSessionId: string;
  turnId: string;
  controlId: string;
  createdAtMs: number;
}

export interface StoredFinalizationResult extends Record<string, unknown> {
  contract_version: 1;
  control_id: string;
  closed: string[];
  released: string[];
  retained: Array<{ lease_id: string; tab_handle: string; reason: string }>;
  already_finalized: string[];
  errors: Array<{ lease_id: string; tab_handle: string; code: string }>;
}

export interface FinalizationControlRecord {
  controlId: string;
  canonicalRequestHash: string;
  status: "pending" | "completed";
  result: StoredFinalizationResult | null;
  createdAtMs: number;
  completedAtMs: number | null;
}

export interface StagedTabCandidate {
  candidateHandle: string;
  loadGenerationId: LoadGenerationId;
  browserInstanceId: string;
  providerTabId: number;
  providerWindowId: number;
  url: string;
  title: string;
  selectionText: string;
  expiresAtMs: number;
}

export interface RuntimeStoreSnapshot {
  lifecycle: LifecycleState;
  session: RuntimeSessionProjection;
  ledger: DurableSafetyLedger;
  activationEvidence: LocalActivationEvidenceReceipt;
}

type SnapshotReducer = (snapshot: RuntimeStoreSnapshot) => RuntimeStoreSnapshot;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInstallInstanceId = (value: unknown): value is InstallInstanceId =>
  typeof value === "string" && INSTALL_ID_PATTERN.test(value);

function isLedger(value: unknown): value is DurableSafetyLedger {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1
    && isInstallInstanceId(value.installInstanceId)
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && (value.activeGenerationId === null || isLoadGenerationId(value.activeGenerationId))
    && Array.isArray(value.generations)
    && Array.isArray(value.leases)
    && Array.isArray(value.operations)
    && (value.cancelControls === undefined || Array.isArray(value.cancelControls))
    && (
      value.challengeControls === undefined
      || (Array.isArray(value.challengeControls) && value.challengeControls.every(isStoredChallengeControlRecord))
    )
    && Array.isArray(value.criticalEvents)
    && isRecord(value.eventAckCursors)
  );
}

function isUsableLease(value: unknown, loadGenerationId: LoadGenerationId): value is TabLease {
  if (!isRecord(value) || !isTabHandle(value.tabHandle)) return false;
  const identity = value.identity;
  return (
    isLeaseId(value.leaseId)
    &&
    value.loadGenerationId === loadGenerationId
    && typeof value.contextId === "string"
    && typeof value.browserSessionId === "string"
    && typeof value.turnId === "string"
    && (value.origin === "created" || value.origin === "claimed")
    && isRecord(identity)
    && Number.isSafeInteger(identity.providerTabId)
    && Number.isSafeInteger(identity.providerWindowId)
  );
}

function isStagedCandidate(
  value: unknown,
  loadGenerationId: LoadGenerationId,
  browserInstanceId: string,
): value is StagedTabCandidate {
  if (!isRecord(value)) return false;
  return (
    typeof value.candidateHandle === "string"
    && value.candidateHandle.startsWith("a0c1.")
    && value.loadGenerationId === loadGenerationId
    && value.browserInstanceId === browserInstanceId
    && Number.isSafeInteger(value.providerTabId)
    && Number(value.providerTabId) >= 0
    && Number.isSafeInteger(value.providerWindowId)
    && Number(value.providerWindowId) >= 0
    && typeof value.url === "string"
    && value.url.length <= 16_384
    && typeof value.title === "string"
    && value.title.length <= 512
    && typeof value.selectionText === "string"
    && value.selectionText.length <= 8_192
    && Number.isSafeInteger(value.expiresAtMs)
    && Number(value.expiresAtMs) > Date.now()
  );
}

function isFinalizedTurnBarrier(value: unknown): value is FinalizedTurnBarrier {
  if (!isRecord(value)) return false;
  return [value.contextId, value.browserSessionId, value.turnId, value.controlId].every(
    (item) => typeof item === "string" && item.length > 0 && item.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(item),
  ) && Number.isSafeInteger(value.createdAtMs) && Number(value.createdAtMs) >= 0;
}

const isBoundedStoredString = (value: unknown, maximum = 256): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= maximum
  && !/[\u0000-\u001f\u007f]/u.test(value);

function isStoredFinalizationResult(value: unknown, controlId: string): value is StoredFinalizationResult {
  if (!isRecord(value) || value.contract_version !== 1 || value.control_id !== controlId) return false;
  if (
    !Array.isArray(value.closed)
    || !Array.isArray(value.released)
    || !Array.isArray(value.retained)
    || !Array.isArray(value.already_finalized)
    || !Array.isArray(value.errors)
    || [value.closed, value.released, value.retained, value.already_finalized, value.errors]
      .some((items) => items.length > 256)
  ) return false;
  if (!value.closed.every((item) => isBoundedStoredString(item))) return false;
  if (!value.released.every((item) => isBoundedStoredString(item))) return false;
  if (!value.already_finalized.every((item) => isBoundedStoredString(item))) return false;
  if (!value.retained.every((item) =>
    isRecord(item)
    && isBoundedStoredString(item.lease_id)
    && isBoundedStoredString(item.tab_handle)
    && isBoundedStoredString(item.reason, 64),
  )) return false;
  return value.errors.every((item) =>
    isRecord(item)
    && isBoundedStoredString(item.lease_id)
    && isBoundedStoredString(item.tab_handle)
    && typeof item.code === "string"
    && /^[A-Z][A-Z0-9_]{0,63}$/u.test(item.code),
  );
}

function isFinalizationControlRecord(value: unknown): value is FinalizationControlRecord {
  if (!isRecord(value) || !isBoundedStoredString(value.controlId)) return false;
  if (typeof value.canonicalRequestHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.canonicalRequestHash)) return false;
  if (value.status !== "pending" && value.status !== "completed") return false;
  if (!Number.isSafeInteger(value.createdAtMs) || Number(value.createdAtMs) < 0) return false;
  if (value.status === "pending") return value.result === null && value.completedAtMs === null;
  return isStoredFinalizationResult(value.result, value.controlId)
    && Number.isSafeInteger(value.completedAtMs)
    && Number(value.completedAtMs) >= Number(value.createdAtMs);
}

function isStoredChallengeControlRecord(value: unknown): boolean {
  return (
    isRecord(value)
    && isLoadGenerationId(value.loadGenerationId)
    && isBoundedStoredString(value.controlId)
    && isBoundedStoredString(value.challengeId)
    && typeof value.canonicalRequestHash === "string"
    && /^[0-9a-f]{64}$/u.test(value.canonicalRequestHash)
    && value.status === "resolved"
    && (value.decision === "deny" || value.decision === "allow_once" || value.decision === "allow_turn"
      || value.decision === "decline" || value.decision === "approve_once")
    && Number.isSafeInteger(value.createdAt)
    && Number(value.createdAt) >= 0
  );
}

function isExactHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      && parsed.origin === value
    );
  } catch {
    return false;
  }
}

function isPendingSiteChallenge(value: unknown, loadGenerationId: LoadGenerationId): value is PendingSiteChallenge {
  if (!isRecord(value) || value.loadGenerationId !== loadGenerationId) return false;
  return (
    isBoundedStoredString(value.challengeId)
    && isLeaseId(value.leaseId)
    && isTabHandle(value.tabHandle)
    && [value.contextId, value.browserSessionId, value.turnId, value.opId, value.actionId]
      .every((item) => isBoundedStoredString(item))
    && isExactHttpOrigin(value.sourceOrigin)
    && isExactHttpOrigin(value.destinationOrigin)
    && (value.documentId === null || isBoundedStoredString(value.documentId))
    && Number.isSafeInteger(value.documentEpoch)
    && Number(value.documentEpoch) >= 0
    && typeof value.canonicalParameterHash === "string"
    && /^[0-9a-f]{64}$/u.test(value.canonicalParameterHash)
    && typeof value.targetFingerprint === "string"
    && /^[0-9a-f]{64}$/u.test(value.targetFingerprint)
    && Number.isSafeInteger(value.expiresAtMs)
    && Number(value.expiresAtMs) > 0
  );
}

function isPendingActionChallenge(value: unknown, loadGenerationId: LoadGenerationId): value is PendingActionChallenge {
  if (!isRecord(value) || value.loadGenerationId !== loadGenerationId) return false;
  let dataClassification: ActionDataClassification;
  try {
    if (
      value.dataClassification !== "none"
      && (
        !isRecord(value.dataClassification)
        || Object.keys(value.dataClassification).length !== 3
        || !Object.hasOwn(value.dataClassification, "kind")
        || !Object.hasOwn(value.dataClassification, "sensitivity")
        || !Object.hasOwn(value.dataClassification, "textSha256")
      )
    ) return false;
    dataClassification = parseActionDataClassification(
      value.dataClassification === "none"
        ? "none"
        : isRecord(value.dataClassification)
          ? {
              kind: value.dataClassification.kind,
              sensitivity: value.dataClassification.sensitivity,
              text_sha256: value.dataClassification.textSha256,
            }
          : value.dataClassification,
    );
  } catch {
    return false;
  }
  return (
    isBoundedStoredString(value.challengeId)
    && isLeaseId(value.leaseId)
    && isTabHandle(value.tabHandle)
    && [value.contextId, value.browserSessionId, value.turnId, value.opId, value.actionId, value.documentId]
      .every((item) => isBoundedStoredString(item))
    && isExactHttpOrigin(value.sourceOrigin)
    && Number.isSafeInteger(value.documentEpoch)
    && Number(value.documentEpoch) >= 0
    && typeof value.canonicalParameterHash === "string"
    && /^[0-9a-f]{64}$/u.test(value.canonicalParameterHash)
    && typeof value.targetFingerprint === "string"
    && /^[0-9a-f]{64}$/u.test(value.targetFingerprint)
    && (value.actionClass === "sensitive_input" || value.actionClass === "external_side_effect" || value.actionClass === "unknown")
    && (dataClassification === "none"
      ? value.dataClassification === "none"
      : isRecord(value.dataClassification)
        && value.dataClassification.kind === dataClassification.kind
        && value.dataClassification.sensitivity === dataClassification.sensitivity
        && value.dataClassification.textSha256 === dataClassification.textSha256)
    && Number.isSafeInteger(value.expiresAtMs)
    && Number(value.expiresAtMs) > 0
  );
}

function isPendingBrowserChallenge(value: unknown, loadGenerationId: LoadGenerationId): value is PendingBrowserChallenge {
  return isPendingSiteChallenge(value, loadGenerationId) || isPendingActionChallenge(value, loadGenerationId);
}

function resumableSession(
  value: unknown,
  lifecycle: LifecycleState,
): RuntimeSessionProjection | null {
  if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION) return null;
  if (!isRecord(value.lifecycle) || value.lifecycle.loadGenerationId !== lifecycle.loadGenerationId) return null;
  if (!Number.isSafeInteger(value.projectionRevision) || Number(value.projectionRevision) < 0) return null;
  if (typeof value.browserInstanceId !== "string" || !value.browserInstanceId) return null;
  if (!isRecord(value.leasesByHandle)) return null;

  const leasesByHandle: Record<string, TabLease> = {};
  for (const [handle, lease] of Object.entries(value.leasesByHandle)) {
    if (handle !== (isRecord(lease) ? lease.tabHandle : undefined) || !isUsableLease(lease, lifecycle.loadGenerationId)) {
      return null;
    }
    leasesByHandle[handle] = lease;
  }
  const leaseIds = Object.values(leasesByHandle).map((lease) => lease.leaseId);
  if (new Set(leaseIds).size !== leaseIds.length) return null;

  const connection = isRecord(value.connection)
    && typeof value.connection.state === "string"
    && typeof value.connection.reasonCode === "string"
      ? value.connection as unknown as NativeConnectionSnapshot
      : { state: "disconnected" as const, reasonCode: "worker_restarted" };
  const finalizedTurns = value.finalizedTurns === undefined ? [] : value.finalizedTurns;
  const finalizationControls = value.finalizationControls === undefined ? [] : value.finalizationControls;
  const pendingChallenges = value.pendingChallenges === undefined ? [] : value.pendingChallenges;
  if (
    !Array.isArray(finalizedTurns)
    || finalizedTurns.length > 2_048
    || finalizedTurns.some((barrier) => !isFinalizedTurnBarrier(barrier))
    || !Array.isArray(finalizationControls)
    || finalizationControls.length > 2_048
    || finalizationControls.some((control) => !isFinalizationControlRecord(control))
    || !Array.isArray(pendingChallenges)
    || pendingChallenges.length > 128
    || pendingChallenges.some((challenge) => !isPendingBrowserChallenge(challenge, lifecycle.loadGenerationId))
  ) return null;
  const finalizedTurnKeys = finalizedTurns.map(
    (barrier) => `${barrier.contextId}\u0000${barrier.browserSessionId}\u0000${barrier.turnId}`,
  );
  if (new Set(finalizedTurnKeys).size !== finalizedTurnKeys.length) return null;
  if (new Set(finalizationControls.map((control) => control.controlId)).size !== finalizationControls.length) return null;
  if (
    new Set(pendingChallenges.map((challenge) => challenge.challengeId)).size !== pendingChallenges.length
    || new Set(pendingChallenges.map((challenge) => challenge.actionId)).size !== pendingChallenges.length
  ) return null;

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    projectionRevision: Number(value.projectionRevision),
    lifecycle: persistedLifecycleProjection(lifecycle),
    phase: lifecycle.phase,
    browserInstanceId: value.browserInstanceId,
    leasesByHandle,
    groups: isRecord(value.groups) && isRecord(value.groups.intentsByBrowserSession)
      ? value.groups as unknown as GroupRegistry
      : createGroupRegistry(),
    connection,
    lastAckedEventSequence:
      Number.isSafeInteger(value.lastAckedEventSequence) && Number(value.lastAckedEventSequence) >= 0
        ? Number(value.lastAckedEventSequence)
        : 0,
    reconnectAttempt:
      Number.isSafeInteger(value.reconnectAttempt) && Number(value.reconnectAttempt) >= 0
        ? Number(value.reconnectAttempt)
        : 0,
    nextReconnectAtMs:
      Number.isSafeInteger(value.nextReconnectAtMs) && Number(value.nextReconnectAtMs) >= 0
        ? Number(value.nextReconnectAtMs)
        : null,
    stagedCandidate: isStagedCandidate(
      value.stagedCandidate,
      lifecycle.loadGenerationId,
      value.browserInstanceId,
    ) ? value.stagedCandidate : null,
    finalizedTurns,
    finalizationControls,
    pendingChallenges,
  };
}

function freshSession(lifecycle: LifecycleState): RuntimeSessionProjection {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    projectionRevision: 0,
    lifecycle: persistedLifecycleProjection(lifecycle),
    phase: lifecycle.phase,
    browserInstanceId: `a0b1.${crypto.randomUUID()}`,
    leasesByHandle: {},
    groups: createGroupRegistry(),
    connection: { state: "disconnected", reasonCode: "native_not_connected" },
    lastAckedEventSequence: 0,
    reconnectAttempt: 0,
    nextReconnectAtMs: null,
    stagedCandidate: null,
    finalizedTurns: [],
    finalizationControls: [],
    pendingChallenges: [],
  };
}

export class RuntimeStore {
  private snapshotValue: RuntimeStoreSnapshot | null = null;
  private hydratePromise: Promise<RuntimeStoreSnapshot> | null = null;
  private writeTail: Promise<void> = Promise.resolve();

  get snapshot(): RuntimeStoreSnapshot {
    if (!this.snapshotValue) throw new Error("Runtime state has not been hydrated.");
    return this.snapshotValue;
  }

  hydrate(): Promise<RuntimeStoreSnapshot> {
    if (this.snapshotValue) return Promise.resolve(this.snapshot);
    if (!this.hydratePromise) {
      this.hydratePromise = this.hydrateOnce().catch((error) => {
        this.hydratePromise = null;
        throw error;
      });
    }
    return this.hydratePromise;
  }

  private async hydrateOnce(): Promise<RuntimeStoreSnapshot> {

    await Promise.all([
      chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
      chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    ]);
    // Delete the legacy key by name without loading its API key or draft into memory.
    await chrome.storage.local.remove(LEGACY_BACKGROUND_KEY);

    const [localValues, sessionValues] = await Promise.all([
      chrome.storage.local.get(LOCAL_LEDGER_KEY),
      chrome.storage.session.get(SESSION_RUNTIME_KEY),
    ]);
    const loadedLedger = localValues[LOCAL_LEDGER_KEY];
    const usableLedger = isLedger(loadedLedger)
      ? {
          ...loadedLedger,
          cancelControls: Array.isArray(loadedLedger.cancelControls) ? loadedLedger.cancelControls : [],
          challengeControls: Array.isArray(loadedLedger.challengeControls) ? loadedLedger.challengeControls : [],
        }
      : null;
    const installInstanceId = usableLedger
      ? usableLedger.installInstanceId
      : createInstallInstanceId();
    let ledger = usableLedger
      ? usableLedger
      : createDurableSafetyLedger(installInstanceId);

    const loadedSession = sessionValues[SESSION_RUNTIME_KEY];
    const persistedLifecycle = isRecord(loadedSession) ? loadedSession.lifecycle : undefined;
    let boot = planLifecycleBoot({
      installInstanceId,
      workerBootId: createWorkerBootId(),
      persistedSession: persistedLifecycle,
      newGenerationId: createLoadGenerationId(),
    });

    let session = boot.disposition === "resume_generation"
      ? resumableSession(loadedSession, boot.state)
      : null;
    if (boot.disposition === "resume_generation" && !session) {
      boot = planLifecycleBoot({
        installInstanceId,
        workerBootId: createWorkerBootId(),
        newGenerationId: createLoadGenerationId(),
      });
    }
    if (!session) {
      const reset = resetLedgerGeneration(ledger, {
        expectedRevision: ledger.revision,
        loadGenerationId: boot.state.loadGenerationId,
        now: Date.now(),
      });
      if (!reset.ok) throw new Error(`Durable ledger reset failed: ${reset.code}`);
      ledger = reset.ledger;
      session = freshSession(boot.state);
    }

    const activationEvidence: LocalActivationEvidenceReceipt = {
      schemaVersion: ACTIVATION_EVIDENCE_SCHEMA_VERSION,
      storageMigrationState: "v1_ready",
      legacyControlPlaneInactive: true,
      legacyStorageKeyRemoved: LEGACY_BACKGROUND_KEY,
    };
    const snapshot = { lifecycle: boot.state, session, ledger, activationEvidence };
    await Promise.all([
      chrome.storage.local.set({
        [LOCAL_LEDGER_KEY]: ledger,
        [LOCAL_ACTIVATION_EVIDENCE_KEY]: activationEvidence,
      }),
      chrome.storage.session.set({ [SESSION_RUNTIME_KEY]: session }),
    ]);
    // Expose activation evidence only after every durable v1 write succeeds.
    this.snapshotValue = snapshot;
    return snapshot;
  }

  transitionPhase(phase: LifecyclePhase): Promise<RuntimeStoreSnapshot> {
    return this.enqueue((snapshot) => {
      if (snapshot.lifecycle.phase === phase) return snapshot;
      const result = transitionLifecycle(snapshot.lifecycle, snapshot.lifecycle.revision, phase);
      if (!result.ok) throw new Error(`Lifecycle transition failed: ${result.code}`);
      return {
        ...snapshot,
        lifecycle: result.state,
        session: {
          ...snapshot.session,
          phase,
          lifecycle: persistedLifecycleProjection(result.state),
          projectionRevision: snapshot.session.projectionRevision + 1,
        },
      };
    }, false);
  }

  setConnection(connection: NativeConnectionSnapshot): Promise<RuntimeStoreSnapshot> {
    return this.enqueue((snapshot) => ({
      ...snapshot,
      session: {
        ...snapshot.session,
        connection,
        projectionRevision: snapshot.session.projectionRevision + 1,
      },
    }), false);
  }

  updateSession(
    reducer: (session: RuntimeSessionProjection) => RuntimeSessionProjection,
  ): Promise<RuntimeStoreSnapshot> {
    return this.enqueue((snapshot) => {
      const next = reducer(snapshot.session);
      return {
        ...snapshot,
        session: {
          ...next,
          projectionRevision: snapshot.session.projectionRevision + 1,
        },
      };
    }, false);
  }

  updateLedger(
    reducer: (ledger: DurableSafetyLedger) => DurableSafetyLedger,
  ): Promise<RuntimeStoreSnapshot> {
    return this.enqueue((snapshot) => ({ ...snapshot, ledger: reducer(snapshot.ledger) }), true);
  }

  updateBoth(reducer: SnapshotReducer): Promise<RuntimeStoreSnapshot> {
    return this.enqueue((snapshot) => {
      const next = reducer(snapshot);
      return {
        ...next,
        session: {
          ...next.session,
          projectionRevision: snapshot.session.projectionRevision + 1,
        },
      };
    }, true);
  }

  private enqueue(reducer: SnapshotReducer, persistLedger: boolean): Promise<RuntimeStoreSnapshot> {
    let resolveResult!: (value: RuntimeStoreSnapshot) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<RuntimeStoreSnapshot>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeTail = this.writeTail.then(async () => {
      try {
        const current = this.snapshot;
        const next = reducer(current);
        if (persistLedger) {
          await chrome.storage.local.set({ [LOCAL_LEDGER_KEY]: next.ledger });
        }
        await chrome.storage.session.set({ [SESSION_RUNTIME_KEY]: next.session });
        this.snapshotValue = next;
        resolveResult(next);
      } catch (error) {
        rejectResult(error);
      }
    });
    return result;
  }
}
