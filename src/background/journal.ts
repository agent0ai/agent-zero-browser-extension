import type { InstallInstanceId, LoadGenerationId } from "./lifecycle";
import type { RetentionReason, TabLease } from "./leases";
import { buildBrowserEventParams, type CriticalBrowserEventRecord } from "../protocol/browser-events";

export const DURABLE_LEDGER_SCHEMA_VERSION = 1 as const;
export const DEFAULT_JOURNAL_LIMITS = Object.freeze({
  softBytes: 4 * 1024 * 1024,
  maxNonterminalOperations: 256,
  maxTerminalOperations: 2_048,
  maxCriticalEvents: 1_024,
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
});
const MAX_CANCEL_CONTROL_TOMBSTONES = 2_048;
const MAX_CHALLENGE_CONTROL_TOMBSTONES = 2_048;

export interface JournalLimits {
  softBytes: number;
  maxNonterminalOperations: number;
  maxTerminalOperations: number;
  maxCriticalEvents: number;
  terminalRetentionMs: number;
}

export type DurableMutationStage =
  | "prepared"
  | "waiting_approval"
  | "effect_started"
  | "succeeded"
  | "failed"
  | "canceled"
  | "outcome_unknown";

export type MutationOutcome = "not_applied" | "applied" | "unknown";

export interface SafeMutationReceipt {
  outcome: MutationOutcome;
  code: string | null;
  leaseHandleDigest: string | null;
}

export interface MutationJournalRecord {
  loadGenerationId: LoadGenerationId;
  opId: string | null;
  actionId: string;
  contextId: string | null;
  browserSessionId: string | null;
  turnId: string | null;
  kind: string;
  canonicalParameterHash: string;
  stage: DurableMutationStage;
  safeReceipt: SafeMutationReceipt | null;
  createdAt: number;
  updatedAt: number;
  acknowledgedAt: number | null;
}

export type CancelControlStatus = "canceled" | "already_completed" | "not_found" | "outcome_unknown";

export interface CancelControlRecord {
  controlId: string;
  canonicalRequestHash: string;
  status: CancelControlStatus;
  safeReceipt: SafeMutationReceipt | null;
  createdAt: number;
}

export interface ChallengeControlRecord {
  loadGenerationId: LoadGenerationId;
  controlId: string;
  challengeId: string;
  canonicalRequestHash: string;
  status: "resolved";
  decision: "deny" | "allow_once" | "allow_turn" | "decline" | "approve_once";
  createdAt: number;
}

export type DurableLeaseState = "active" | "finalizing" | "closed" | "released" | "retained" | "outcome_unknown" | "orphan";

export interface RedactedUrlIdentity {
  origin: string;
  pathDigest: string;
}

export interface DurableLeaseShadow {
  loadGenerationId: LoadGenerationId;
  leaseIdDigest: string;
  leaseHandleDigest: string;
  exactIdentityDigest: string;
  browserInstanceId: string;
  providerTabId: number;
  providerWindowId: number;
  providerGroupId: number | null;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  origin: "created" | "claimed";
  disposition: "ephemeral" | "deliverable" | "handoff";
  state: DurableLeaseState;
  urlIdentity: RedactedUrlIdentity;
  userIntervened: boolean;
  finalizationControlId: string | null;
  retentionReason: RetentionReason | null;
  updatedAt: number;
}

export type CriticalEventRecord = CriticalBrowserEventRecord;

export interface GenerationSummary {
  loadGenerationId: LoadGenerationId;
  state: "current" | "prior";
  startedAt: number;
  endedAt: number | null;
}

export interface DurableSafetyLedger {
  schemaVersion: typeof DURABLE_LEDGER_SCHEMA_VERSION;
  installInstanceId: InstallInstanceId;
  revision: number;
  activeGenerationId: LoadGenerationId | null;
  generations: readonly GenerationSummary[];
  leases: readonly DurableLeaseShadow[];
  operations: readonly MutationJournalRecord[];
  cancelControls: readonly CancelControlRecord[];
  challengeControls: readonly ChallengeControlRecord[];
  criticalEvents: readonly CriticalEventRecord[];
  eventAckCursors: Readonly<Record<string, number>>;
}

export type JournalErrorCode =
  | "REVISION_CONFLICT"
  | "JOURNAL_CAPACITY_EXCEEDED"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "LEASE_SHADOW_NOT_FOUND"
  | "LEASE_IDENTITY_MISMATCH"
  | "INVALID_LEASE_TRANSITION"
  | "INVALID_STAGE_TRANSITION"
  | "EVENT_GENERATION_UNKNOWN"
  | "EVENT_SEQUENCE_GAP";

export interface JournalFailure {
  ok: false;
  ledger: DurableSafetyLedger;
  code: JournalErrorCode;
}

export type JournalResult<T> = { ok: true; ledger: DurableSafetyLedger; value: T } | JournalFailure;

export type PrepareMutationDisposition = "prepared" | "resume_existing" | "replay_terminal" | "durable_receipt";
export type RecordCancelControlDisposition = "recorded" | "replay_existing";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TERMINAL_STAGES = new Set<DurableMutationStage>([
  "succeeded",
  "failed",
  "canceled",
  "outcome_unknown",
]);
const COMPACTABLE_STAGES = new Set<DurableMutationStage>(["succeeded", "failed", "canceled"]);
const MUTATION_TERMINAL_RESERVE_BYTES = 2_048;

function requireTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer timestamp.`);
  }
}

function requireProviderId(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

function requireIdentifier(name: string, value: string, maxLength = 256): void {
  if (!value || value.length > maxLength || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${name} must be a bounded opaque identifier.`);
  }
}

function requireDigest(name: string, value: string): void {
  if (!DIGEST_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hex digest.`);
  }
}

function requireErrorCode(code: string | null): void {
  if (code !== null && !ERROR_CODE_PATTERN.test(code)) {
    throw new Error("Receipt and event codes must be bounded symbolic codes.");
  }
}

function isTerminal(stage: DurableMutationStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateLimits(limits: JournalLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
}

function compactEligibleOperations(
  operations: readonly MutationJournalRecord[],
  now: number,
  limits: JournalLimits,
): readonly MutationJournalRecord[] {
  const cutoff = now - limits.terminalRetentionMs;
  return operations.filter(
    (record) =>
      !(
        COMPACTABLE_STAGES.has(record.stage) &&
        record.acknowledgedAt !== null &&
        record.acknowledgedAt <= cutoff
      ),
  );
}

function boundedCandidate(
  original: DurableSafetyLedger,
  candidate: DurableSafetyLedger,
  now: number,
  limits: JournalLimits,
): { ok: true; ledger: DurableSafetyLedger } | JournalFailure {
  validateLimits(limits);
  const compacted: DurableSafetyLedger = {
    ...candidate,
    operations: compactEligibleOperations(candidate.operations, now, limits),
  };
  const nonterminalCount = compacted.operations.filter((record) => !isTerminal(record.stage)).length;
  const terminalCount = compacted.operations.length - nonterminalCount;
  if (
    nonterminalCount > limits.maxNonterminalOperations ||
    terminalCount > limits.maxTerminalOperations ||
    compacted.cancelControls.length > MAX_CANCEL_CONTROL_TOMBSTONES ||
    compacted.challengeControls.length > MAX_CHALLENGE_CONTROL_TOMBSTONES ||
    compacted.criticalEvents.length > limits.maxCriticalEvents ||
    encodedBytes(compacted) > limits.softBytes
  ) {
    return { ok: false, ledger: original, code: "JOURNAL_CAPACITY_EXCEEDED" };
  }
  return {
    ok: true,
    ledger: { ...compacted, revision: original.revision + 1 },
  };
}

function revisionMatches(
  ledger: DurableSafetyLedger,
  expectedRevision: number,
): JournalFailure | null {
  return expectedRevision === ledger.revision
    ? null
    : { ok: false, ledger, code: "REVISION_CONFLICT" };
}

export function createDurableSafetyLedger(installInstanceId: InstallInstanceId): DurableSafetyLedger {
  return {
    schemaVersion: DURABLE_LEDGER_SCHEMA_VERSION,
    installInstanceId,
    revision: 0,
    activeGenerationId: null,
    generations: [],
    leases: [],
    operations: [],
    cancelControls: [],
    challengeControls: [],
    criticalEvents: [],
    eventAckCursors: {},
  };
}

export function redactUrlIdentity(rawUrl: string, digestPath: (path: string) => string): RedactedUrlIdentity {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs can be represented in the durable ledger.");
  }
  const pathDigest = digestPath(parsed.pathname);
  requireDigest("pathDigest", pathDigest);
  if (parsed.origin.length > 512) {
    throw new Error("URL origin exceeds the durable ledger bound.");
  }
  return { origin: parsed.origin, pathDigest };
}

export function createDurableLeaseShadow(input: {
  lease: TabLease;
  rawUrl: string;
  leaseIdDigest: string;
  leaseHandleDigest: string;
  exactIdentityDigest: string;
  digestPath: (path: string) => string;
  now: number;
}): DurableLeaseShadow {
  requireTimestamp("now", input.now);
  requireDigest("leaseIdDigest", input.leaseIdDigest);
  requireDigest("leaseHandleDigest", input.leaseHandleDigest);
  requireDigest("exactIdentityDigest", input.exactIdentityDigest);
  requireIdentifier("browserInstanceId", input.lease.identity.browserInstanceId);
  requireIdentifier("contextId", input.lease.contextId);
  requireIdentifier("browserSessionId", input.lease.browserSessionId);
  requireIdentifier("turnId", input.lease.turnId);
  requireProviderId("providerTabId", input.lease.identity.providerTabId);
  requireProviderId("providerWindowId", input.lease.identity.providerWindowId);
  if (input.lease.providerGroupId !== null) {
    requireProviderId("providerGroupId", input.lease.providerGroupId);
  }
  return {
    loadGenerationId: input.lease.loadGenerationId,
    leaseIdDigest: input.leaseIdDigest,
    leaseHandleDigest: input.leaseHandleDigest,
    exactIdentityDigest: input.exactIdentityDigest,
    browserInstanceId: input.lease.identity.browserInstanceId,
    providerTabId: input.lease.identity.providerTabId,
    providerWindowId: input.lease.identity.providerWindowId,
    providerGroupId: input.lease.providerGroupId,
    contextId: input.lease.contextId,
    browserSessionId: input.lease.browserSessionId,
    turnId: input.lease.turnId,
    origin: input.lease.origin,
    disposition: input.lease.disposition,
    state: input.lease.state,
    urlIdentity: redactUrlIdentity(input.rawUrl, input.digestPath),
    userIntervened: input.lease.userIntervened,
    finalizationControlId: input.lease.finalizationControlId,
    retentionReason: input.lease.retentionReason,
    updatedAt: input.now,
  };
}

export function upsertDurableLease(
  ledger: DurableSafetyLedger,
  input: { expectedRevision: number; shadow: DurableLeaseShadow; now: number },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<DurableLeaseShadow> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  requireDigest("leaseIdDigest", input.shadow.leaseIdDigest);
  requireDigest("leaseHandleDigest", input.shadow.leaseHandleDigest);
  const existing = ledger.leases.find(
    (candidate) => candidate.leaseHandleDigest === input.shadow.leaseHandleDigest,
  );
  if (existing && existing.leaseIdDigest !== input.shadow.leaseIdDigest) {
    return { ok: false, ledger, code: "LEASE_IDENTITY_MISMATCH" };
  }
  if (ledger.leases.some(
    (candidate) => candidate.leaseIdDigest === input.shadow.leaseIdDigest
      && candidate.leaseHandleDigest !== input.shadow.leaseHandleDigest,
  )) {
    return { ok: false, ledger, code: "LEASE_IDENTITY_MISMATCH" };
  }
  const leases = ledger.leases.filter(
    (candidate) => candidate.leaseHandleDigest !== input.shadow.leaseHandleDigest,
  );
  const result = boundedCandidate(ledger, { ...ledger, leases: [...leases, input.shadow] }, input.now, limits);
  return result.ok ? { ...result, value: input.shadow } : result;
}

const ALLOWED_LEASE_TRANSITIONS: Readonly<Record<DurableLeaseState, readonly DurableLeaseState[]>> = {
  active: ["finalizing", "closed", "released", "retained", "outcome_unknown", "orphan"],
  finalizing: ["closed", "released", "retained", "outcome_unknown", "orphan"],
  closed: [],
  released: [],
  retained: [],
  outcome_unknown: ["closed", "retained"],
  orphan: ["retained"],
};

export function transitionDurableLease(
  ledger: DurableSafetyLedger,
  input: {
    expectedRevision: number;
    expectedLeaseIdDigest: string;
    leaseHandleDigest: string;
    expectedExactIdentityDigest: string;
    expectedState: DurableLeaseState;
    state: DurableLeaseState;
    now: number;
    providerTabId?: number;
    providerWindowId?: number;
    providerGroupId?: number | null;
    exactIdentityDigest?: string;
    disposition?: DurableLeaseShadow["disposition"];
    userIntervened?: boolean;
    finalizationControlId?: string | null;
    retentionReason?: RetentionReason | null;
  },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<DurableLeaseShadow> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  requireDigest("expectedLeaseIdDigest", input.expectedLeaseIdDigest);
  requireDigest("leaseHandleDigest", input.leaseHandleDigest);
  requireDigest("expectedExactIdentityDigest", input.expectedExactIdentityDigest);
  if (input.exactIdentityDigest !== undefined) requireDigest("exactIdentityDigest", input.exactIdentityDigest);
  if (input.providerTabId !== undefined) requireProviderId("providerTabId", input.providerTabId);
  if (input.providerWindowId !== undefined) requireProviderId("providerWindowId", input.providerWindowId);
  if (input.providerGroupId !== undefined && input.providerGroupId !== null) {
    requireProviderId("providerGroupId", input.providerGroupId);
  }
  if (input.finalizationControlId) requireIdentifier("finalizationControlId", input.finalizationControlId);

  const index = ledger.leases.findIndex((lease) => lease.leaseHandleDigest === input.leaseHandleDigest);
  if (index < 0) return { ok: false, ledger, code: "LEASE_SHADOW_NOT_FOUND" };
  const current = ledger.leases[index];
  if (
    current.leaseIdDigest !== input.expectedLeaseIdDigest
    || current.exactIdentityDigest !== input.expectedExactIdentityDigest
  ) {
    return { ok: false, ledger, code: "LEASE_IDENTITY_MISMATCH" };
  }
  if (current.state === input.state && current.state === input.expectedState) {
    const idempotent =
      (input.providerTabId === undefined || input.providerTabId === current.providerTabId) &&
      (input.providerWindowId === undefined || input.providerWindowId === current.providerWindowId) &&
      (input.providerGroupId === undefined || input.providerGroupId === current.providerGroupId) &&
      (input.exactIdentityDigest === undefined || input.exactIdentityDigest === current.exactIdentityDigest) &&
      (input.disposition === undefined || input.disposition === current.disposition) &&
      (input.userIntervened === undefined || input.userIntervened === current.userIntervened) &&
      (input.finalizationControlId === undefined || input.finalizationControlId === current.finalizationControlId) &&
      (input.retentionReason === undefined || input.retentionReason === current.retentionReason);
    if (!idempotent) return { ok: false, ledger, code: "INVALID_LEASE_TRANSITION" };
    return { ok: true, ledger, value: current };
  }
  if (
    current.state !== input.expectedState ||
    !ALLOWED_LEASE_TRANSITIONS[current.state].includes(input.state)
  ) {
    return { ok: false, ledger, code: "INVALID_LEASE_TRANSITION" };
  }

  const shadow: DurableLeaseShadow = {
    ...current,
    state: input.state,
    providerTabId: input.providerTabId ?? current.providerTabId,
    providerWindowId: input.providerWindowId ?? current.providerWindowId,
    providerGroupId:
      input.providerGroupId === undefined ? current.providerGroupId : input.providerGroupId,
    exactIdentityDigest: input.exactIdentityDigest ?? current.exactIdentityDigest,
    disposition: input.disposition ?? current.disposition,
    userIntervened: input.userIntervened ?? current.userIntervened,
    finalizationControlId:
      input.finalizationControlId === undefined
        ? current.finalizationControlId
        : input.finalizationControlId,
    retentionReason:
      input.retentionReason === undefined ? current.retentionReason : input.retentionReason,
    updatedAt: input.now,
  };
  const leases = [...ledger.leases];
  leases[index] = shadow;
  const result = boundedCandidate(ledger, { ...ledger, leases }, input.now, limits);
  return result.ok ? { ...result, value: shadow } : result;
}

export function prepareMutation(
  ledger: DurableSafetyLedger,
  input: {
    expectedRevision: number;
    loadGenerationId: LoadGenerationId;
    opId?: string;
    actionId: string;
    contextId?: string;
    browserSessionId?: string;
    turnId?: string;
    kind: string;
    canonicalParameterHash: string;
    now: number;
  },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<{ disposition: PrepareMutationDisposition; record: MutationJournalRecord }> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireIdentifier("actionId", input.actionId);
  if (input.opId !== undefined) requireIdentifier("opId", input.opId);
  if (input.contextId !== undefined) requireIdentifier("contextId", input.contextId);
  if (input.browserSessionId !== undefined) requireIdentifier("browserSessionId", input.browserSessionId);
  if (input.turnId !== undefined) requireIdentifier("turnId", input.turnId);
  requireIdentifier("kind", input.kind, 64);
  requireDigest("canonicalParameterHash", input.canonicalParameterHash);
  requireTimestamp("now", input.now);

  const existing = ledger.operations.find((record) => record.actionId === input.actionId);
  if (existing) {
    if (existing.canonicalParameterHash !== input.canonicalParameterHash || existing.kind !== input.kind) {
      return { ok: false, ledger, code: "IDEMPOTENCY_CONFLICT" };
    }
    const sameGeneration = existing.loadGenerationId === input.loadGenerationId;
    if (sameGeneration) {
      const disposition: PrepareMutationDisposition = isTerminal(existing.stage)
        ? "replay_terminal"
        : "resume_existing";
      return { ok: true, ledger, value: { disposition, record: existing } };
    }
    if (isTerminal(existing.stage)) {
      return { ok: true, ledger, value: { disposition: "durable_receipt", record: existing } };
    }

    const record: MutationJournalRecord = {
      ...existing,
      stage: "outcome_unknown",
      safeReceipt: { outcome: "unknown", code: "STALE_GENERATION", leaseHandleDigest: null },
      updatedAt: input.now,
    };
    const operations = ledger.operations.map((candidate) =>
      candidate.actionId === record.actionId ? record : candidate,
    );
    const result = boundedCandidate(ledger, { ...ledger, operations }, input.now, limits);
    return result.ok
      ? { ...result, value: { disposition: "durable_receipt", record } }
      : result;
  }

  const record: MutationJournalRecord = {
    loadGenerationId: input.loadGenerationId,
    opId: input.opId ?? null,
    actionId: input.actionId,
    contextId: input.contextId ?? null,
    browserSessionId: input.browserSessionId ?? null,
    turnId: input.turnId ?? null,
    kind: input.kind,
    canonicalParameterHash: input.canonicalParameterHash,
    stage: "prepared",
    safeReceipt: null,
    createdAt: input.now,
    updatedAt: input.now,
    acknowledgedAt: null,
  };
  const result = boundedCandidate(
    ledger,
    { ...ledger, operations: [...ledger.operations, record] },
    input.now,
    limits,
  );
  if (!result.ok) return result;
  const terminalReservations = result.ledger.operations.length;
  if (
    terminalReservations > limits.maxTerminalOperations ||
    result.ledger.criticalEvents.length >= limits.maxCriticalEvents ||
    encodedBytes(result.ledger) + MUTATION_TERMINAL_RESERVE_BYTES > limits.softBytes
  ) {
    return { ok: false, ledger, code: "JOURNAL_CAPACITY_EXCEEDED" };
  }
  return { ...result, value: { disposition: "prepared", record } };
}

export function recordCancelControl(
  ledger: DurableSafetyLedger,
  input: {
    expectedRevision: number;
    controlId: string;
    canonicalRequestHash: string;
    status: CancelControlStatus;
    safeReceipt: SafeMutationReceipt | null;
    now: number;
  },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<{ disposition: RecordCancelControlDisposition; record: CancelControlRecord }> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireIdentifier("controlId", input.controlId);
  requireDigest("canonicalRequestHash", input.canonicalRequestHash);
  requireTimestamp("now", input.now);
  if (
    input.status === "not_found"
      ? input.safeReceipt !== null
      : input.safeReceipt === null
  ) {
    throw new Error("Cancellation status and safe receipt do not match.");
  }
  if (input.safeReceipt) {
    requireErrorCode(input.safeReceipt.code);
    if (input.safeReceipt.leaseHandleDigest !== null) {
      requireDigest("leaseHandleDigest", input.safeReceipt.leaseHandleDigest);
    }
    if (input.status === "canceled" && input.safeReceipt.outcome !== "not_applied") {
      throw new Error("Canceled controls require a not-applied receipt.");
    }
    if (input.status === "outcome_unknown" && input.safeReceipt.outcome !== "unknown") {
      throw new Error("Unknown controls require an unknown receipt.");
    }
  }

  const existing = ledger.cancelControls.find((record) => record.controlId === input.controlId);
  if (existing) {
    if (existing.canonicalRequestHash !== input.canonicalRequestHash) {
      return { ok: false, ledger, code: "IDEMPOTENCY_CONFLICT" };
    }
    return {
      ok: true,
      ledger,
      value: { disposition: "replay_existing", record: existing },
    };
  }

  const record: CancelControlRecord = {
    controlId: input.controlId,
    canonicalRequestHash: input.canonicalRequestHash,
    status: input.status,
    safeReceipt: input.safeReceipt,
    createdAt: input.now,
  };
  const result = boundedCandidate(
    ledger,
    { ...ledger, cancelControls: [...ledger.cancelControls, record] },
    input.now,
    limits,
  );
  return result.ok
    ? { ...result, value: { disposition: "recorded", record } }
    : result;
}

export function recordChallengeControl(
  ledger: DurableSafetyLedger,
  input: {
    expectedRevision: number;
    loadGenerationId: LoadGenerationId;
    controlId: string;
    challengeId: string;
    canonicalRequestHash: string;
    decision: ChallengeControlRecord["decision"];
    now: number;
  },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<{ disposition: "recorded" | "replay_existing"; record: ChallengeControlRecord }> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireIdentifier("controlId", input.controlId);
  requireIdentifier("challengeId", input.challengeId);
  requireDigest("canonicalRequestHash", input.canonicalRequestHash);
  requireTimestamp("now", input.now);
  if (!ledger.generations.some((generation) => generation.loadGenerationId === input.loadGenerationId)) {
    return { ok: false, ledger, code: "EVENT_GENERATION_UNKNOWN" };
  }

  const existingControl = ledger.challengeControls.find((record) => record.controlId === input.controlId);
  if (existingControl) {
    if (
      existingControl.loadGenerationId !== input.loadGenerationId
      || existingControl.challengeId !== input.challengeId
      || existingControl.canonicalRequestHash !== input.canonicalRequestHash
    ) return { ok: false, ledger, code: "IDEMPOTENCY_CONFLICT" };
    return {
      ok: true,
      ledger,
      value: { disposition: "replay_existing", record: existingControl },
    };
  }
  if (ledger.challengeControls.some((record) =>
    record.loadGenerationId === input.loadGenerationId && record.challengeId === input.challengeId,
  )) return { ok: false, ledger, code: "IDEMPOTENCY_CONFLICT" };

  const record: ChallengeControlRecord = {
    loadGenerationId: input.loadGenerationId,
    controlId: input.controlId,
    challengeId: input.challengeId,
    canonicalRequestHash: input.canonicalRequestHash,
    status: "resolved",
    decision: input.decision,
    createdAt: input.now,
  };
  const result = boundedCandidate(
    ledger,
    { ...ledger, challengeControls: [...ledger.challengeControls, record] },
    input.now,
    limits,
  );
  return result.ok
    ? { ...result, value: { disposition: "recorded", record } }
    : result;
}

const ALLOWED_STAGE_TRANSITIONS: Readonly<Record<DurableMutationStage, readonly DurableMutationStage[]>> = {
  prepared: ["waiting_approval", "effect_started", "failed", "canceled", "outcome_unknown"],
  waiting_approval: ["effect_started", "failed", "canceled", "outcome_unknown"],
  effect_started: ["succeeded", "failed", "canceled", "outcome_unknown"],
  succeeded: [],
  failed: [],
  canceled: [],
  outcome_unknown: [],
};

function validateReceipt(stage: DurableMutationStage, receipt: SafeMutationReceipt | null): void {
  if (!isTerminal(stage)) {
    if (receipt !== null) throw new Error("Nonterminal journal stages cannot include a receipt.");
    return;
  }
  if (!receipt) throw new Error("Terminal journal stages require a safe receipt.");
  requireErrorCode(receipt.code);
  if (receipt.leaseHandleDigest !== null) requireDigest("leaseHandleDigest", receipt.leaseHandleDigest);
  if (stage === "succeeded" && receipt.outcome !== "applied") {
    throw new Error("A succeeded mutation must have an applied receipt.");
  }
  if (stage === "outcome_unknown" && receipt.outcome !== "unknown") {
    throw new Error("An outcome_unknown mutation must have an unknown receipt.");
  }
}

export function transitionMutation(
  ledger: DurableSafetyLedger,
  input: {
    expectedRevision: number;
    loadGenerationId: LoadGenerationId;
    actionId: string;
    expectedStage: DurableMutationStage;
    stage: DurableMutationStage;
    safeReceipt?: SafeMutationReceipt | null;
    now: number;
  },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<MutationJournalRecord> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  const index = ledger.operations.findIndex(
    (record) => record.actionId === input.actionId && record.loadGenerationId === input.loadGenerationId,
  );
  if (index < 0) return { ok: false, ledger, code: "OPERATION_NOT_FOUND" };
  const current = ledger.operations[index];
  if (
    current.stage !== input.expectedStage ||
    !ALLOWED_STAGE_TRANSITIONS[current.stage].includes(input.stage)
  ) {
    return { ok: false, ledger, code: "INVALID_STAGE_TRANSITION" };
  }
  const receipt = input.safeReceipt ?? null;
  validateReceipt(input.stage, receipt);
  const record: MutationJournalRecord = {
    ...current,
    stage: input.stage,
    safeReceipt: receipt,
    updatedAt: input.now,
  };
  const operations = [...ledger.operations];
  operations[index] = record;
  const result = boundedCandidate(ledger, { ...ledger, operations }, input.now, limits);
  return result.ok ? { ...result, value: record } : result;
}

export function acknowledgeMutation(
  ledger: DurableSafetyLedger,
  input: { expectedRevision: number; actionId: string; now: number },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<MutationJournalRecord> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  const index = ledger.operations.findIndex((record) => record.actionId === input.actionId);
  if (index < 0) return { ok: false, ledger, code: "OPERATION_NOT_FOUND" };
  const current = ledger.operations[index];
  if (!isTerminal(current.stage)) {
    return { ok: false, ledger, code: "INVALID_STAGE_TRANSITION" };
  }
  const record = { ...current, acknowledgedAt: input.now, updatedAt: input.now };
  const operations = [...ledger.operations];
  operations[index] = record;
  const result = boundedCandidate(ledger, { ...ledger, operations }, input.now, limits);
  return result.ok ? { ...result, value: record } : result;
}

export function appendCriticalEvent(
  ledger: DurableSafetyLedger,
  input: { expectedRevision: number; event: CriticalEventRecord; now: number },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<CriticalEventRecord> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  buildBrowserEventParams(input.event);
  if (!ledger.generations.some((generation) => generation.loadGenerationId === input.event.loadGenerationId)) {
    return { ok: false, ledger, code: "EVENT_GENERATION_UNKNOWN" };
  }
  if (ledger.criticalEvents.some((event) => event.eventId === input.event.eventId)) {
    return { ok: false, ledger, code: "IDEMPOTENCY_CONFLICT" };
  }

  const cursor = ledger.eventAckCursors[input.event.loadGenerationId] ?? 0;
  const sameGeneration = ledger.criticalEvents.filter(
    (event) => event.loadGenerationId === input.event.loadGenerationId,
  );
  const highestStored = sameGeneration.reduce((maximum, event) => Math.max(maximum, event.sequence), cursor);
  if (input.event.sequence !== highestStored + 1) {
    return { ok: false, ledger, code: "EVENT_SEQUENCE_GAP" };
  }
  const result = boundedCandidate(
    ledger,
    { ...ledger, criticalEvents: [...ledger.criticalEvents, input.event] },
    input.now,
    limits,
  );
  return result.ok ? { ...result, value: input.event } : result;
}

export function acknowledgeCriticalEvents(
  ledger: DurableSafetyLedger,
  input: {
    expectedRevision: number;
    loadGenerationId: LoadGenerationId;
    highestContiguousSequence: number;
    now: number;
  },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<number> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  if (!Number.isSafeInteger(input.highestContiguousSequence) || input.highestContiguousSequence < 0) {
    throw new Error("Critical event acknowledgement must be a nonnegative safe integer.");
  }
  if (!ledger.generations.some((generation) => generation.loadGenerationId === input.loadGenerationId)) {
    return { ok: false, ledger, code: "EVENT_GENERATION_UNKNOWN" };
  }
  const currentCursor = ledger.eventAckCursors[input.loadGenerationId] ?? 0;
  if (input.highestContiguousSequence < currentCursor) {
    return { ok: false, ledger, code: "EVENT_SEQUENCE_GAP" };
  }
  const available = new Set(
    ledger.criticalEvents
      .filter((event) => event.loadGenerationId === input.loadGenerationId)
      .map((event) => event.sequence),
  );
  for (let sequence = currentCursor + 1; sequence <= input.highestContiguousSequence; sequence += 1) {
    if (!available.has(sequence)) {
      return { ok: false, ledger, code: "EVENT_SEQUENCE_GAP" };
    }
  }
  const criticalEvents = ledger.criticalEvents.filter(
    (event) =>
      event.loadGenerationId !== input.loadGenerationId || event.sequence > input.highestContiguousSequence,
  );
  const eventAckCursors = {
    ...ledger.eventAckCursors,
    [input.loadGenerationId]: input.highestContiguousSequence,
  };
  const result = boundedCandidate(
    ledger,
    { ...ledger, criticalEvents, eventAckCursors },
    input.now,
    limits,
  );
  return result.ok ? { ...result, value: input.highestContiguousSequence } : result;
}

export function resetLedgerGeneration(
  ledger: DurableSafetyLedger,
  input: { expectedRevision: number; loadGenerationId: LoadGenerationId; now: number },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<LoadGenerationId> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  if (ledger.activeGenerationId === input.loadGenerationId) {
    return { ok: true, ledger, value: input.loadGenerationId };
  }
  const generations = ledger.generations.map((generation) =>
    generation.state === "current"
      ? { ...generation, state: "prior" as const, endedAt: input.now }
      : generation,
  );
  if (!generations.some((generation) => generation.loadGenerationId === input.loadGenerationId)) {
    generations.push({
      loadGenerationId: input.loadGenerationId,
      state: "current",
      startedAt: input.now,
      endedAt: null,
    });
  }
  const operations = ledger.operations.map((record): MutationJournalRecord => {
    if (isTerminal(record.stage)) return record;
    return {
      ...record,
      stage: "outcome_unknown",
      safeReceipt: { outcome: "unknown", code: "WORKER_GENERATION_RESET", leaseHandleDigest: null },
      updatedAt: input.now,
    };
  });
  const leases = ledger.leases.map((lease): DurableLeaseShadow =>
    lease.state === "active" || lease.state === "finalizing"
      ? { ...lease, state: "orphan", updatedAt: input.now }
      : lease,
  );
  const result = boundedCandidate(
    ledger,
    {
      ...ledger,
      activeGenerationId: input.loadGenerationId,
      generations,
      operations,
      leases,
      challengeControls: ledger.challengeControls.filter(
        (record) => record.loadGenerationId === input.loadGenerationId,
      ),
    },
    input.now,
    limits,
  );
  return result.ok ? { ...result, value: input.loadGenerationId } : result;
}

export function compactDurableLedger(
  ledger: DurableSafetyLedger,
  input: { expectedRevision: number; now: number },
  limits: JournalLimits = DEFAULT_JOURNAL_LIMITS,
): JournalResult<number> {
  const mismatch = revisionMatches(ledger, input.expectedRevision);
  if (mismatch) return mismatch;
  requireTimestamp("now", input.now);
  const operations = compactEligibleOperations(ledger.operations, input.now, limits);
  const removed = ledger.operations.length - operations.length;
  const result = boundedCandidate(ledger, { ...ledger, operations }, input.now, limits);
  return result.ok ? { ...result, value: removed } : result;
}
