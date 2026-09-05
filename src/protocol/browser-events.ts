import { BRIDGE_CONTRACT_VERSION, encodedSize, hasExactKeys, isRecord, validOpaqueId } from "./rpc";
import {
  buildActionDataClassification,
  parseActionDataClassification,
  type ActionDataClassification,
} from "./challenges";

export const CRITICAL_BROWSER_EVENT_TYPES = ["lease.changed", "turn.finalized", "challenge.required"] as const;
export const LEASE_EVENT_STATES = [
  "active",
  "finalizing",
  "closed",
  "released",
  "retained",
  "outcome_unknown",
  "orphan",
] as const;
export const LEASE_EVENT_OWNERSHIPS = ["created", "claimed"] as const;
export const LEASE_EVENT_DISPOSITIONS = ["ephemeral", "deliverable", "handoff"] as const;
export const LEASE_EVENT_CHANGES = [
  "created",
  "finalizing",
  "tab_closed",
  "user_takeover",
  "finalized",
  "orphaned",
] as const;
export const LEASE_EVENT_REASON_CODES = [
  "FINALIZATION_STARTED",
  "TAB_CLOSED",
  "USER_TAKEOVER",
  "LEASE_ORPHANED",
  "FINALIZED_CLOSED",
  "FINALIZED_RELEASED",
  "FINALIZED_RETAINED",
  "FINALIZATION_OUTCOME_UNKNOWN",
] as const;

const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_EVENT_METADATA_BYTES = 64 * 1024;

type CriticalBrowserEventType = (typeof CRITICAL_BROWSER_EVENT_TYPES)[number];
type LeaseEventState = (typeof LEASE_EVENT_STATES)[number];
type LeaseEventOwnership = (typeof LEASE_EVENT_OWNERSHIPS)[number];
type LeaseEventDisposition = (typeof LEASE_EVENT_DISPOSITIONS)[number];
type LeaseEventChange = (typeof LEASE_EVENT_CHANGES)[number];
type LeaseEventReasonCode = (typeof LEASE_EVENT_REASON_CODES)[number];

export interface LeaseChangedEventData {
  leaseIdDigest: string;
  browserIdDigest: string;
  state: LeaseEventState;
  ownership: LeaseEventOwnership;
  disposition: LeaseEventDisposition;
  change: LeaseEventChange;
  reasonCode: LeaseEventReasonCode | null;
}

export interface TurnFinalizedEventData {
  controlId: string;
  status: "completed";
  closedCount: number;
  releasedCount: number;
  retainedCount: number;
  alreadyFinalizedCount: number;
  errorCount: number;
}

export interface SiteChallengeRequiredEventData {
  challengeId: string;
  kind: "site";
  origin: string;
  actionClass: "navigate";
  canonicalParameterHash: string;
  targetFingerprint: string;
  leaseIdDigest: string;
  browserIdDigest: string;
  documentId: string | null;
  documentEpoch: number;
  summary: string;
  options: readonly ["deny", "allow_once", "allow_turn"];
  expiresAtMs: number;
}

export interface ActionChallengeRequiredEventData {
  challengeId: string;
  kind: "action";
  origin: string;
  actionClass: "sensitive_input" | "external_side_effect" | "unknown";
  canonicalParameterHash: string;
  targetFingerprint: string;
  leaseIdDigest: string;
  browserIdDigest: string;
  documentId: string;
  documentEpoch: number;
  summary: string;
  options: readonly ["decline", "approve_once"];
  dataClassification: ActionDataClassification;
  expiresAtMs: number;
}

export type ChallengeRequiredEventData =
  | SiteChallengeRequiredEventData
  | ActionChallengeRequiredEventData;

export type CriticalBrowserEventRecord = {
  eventId: string;
  loadGenerationId: string;
  sequence: number;
  delivery: "critical";
  observedAt: number;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  opId: string | null;
  actionId: string | null;
} & (
  | { eventType: "lease.changed"; data: LeaseChangedEventData }
  | { eventType: "turn.finalized"; data: TurnFinalizedEventData }
  | { eventType: "challenge.required"; data: ChallengeRequiredEventData }
);

export type BrowserEventParams = {
  contract_version: 1;
  event_id: string;
  load_generation_id: string;
  event_sequence: number;
  delivery: "critical";
  event_type: CriticalBrowserEventType;
  observed_at_ms: number;
  context_id: string;
  browser_session_id: string;
  turn_id: string;
  op_id: string | null;
  action_id: string | null;
  data: Record<string, unknown>;
};

export interface BrowserAckEventsRequest {
  contractVersion: 1;
  loadGenerationId: string;
  highestContiguousEventSequence: number;
}

export class BrowserEventSchemaError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "BrowserEventSchemaError";
  }
}

function requireExactRecord(
  value: unknown,
  required: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, required) || encodedSize(value) > MAX_EVENT_METADATA_BYTES) {
    throw new BrowserEventSchemaError(code);
  }
  return value;
}

function requireIdentifier(value: unknown, code: string): string {
  if (!validOpaqueId(value)) throw new BrowserEventSchemaError(code);
  return value;
}

function requireNullableIdentifier(value: unknown, code: string): string | null {
  return value === null ? null : requireIdentifier(value, code);
}

function requireSafeInteger(value: unknown, code: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new BrowserEventSchemaError(code);
  }
  return Number(value);
}

function requirePositiveSequence(value: unknown, code: string): number {
  const parsed = requireSafeInteger(value, code);
  if (parsed < 1) throw new BrowserEventSchemaError(code);
  return parsed;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new BrowserEventSchemaError(code);
  return value as T;
}

function requireDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new BrowserEventSchemaError(code);
  return value;
}

function requireOrigin(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 512) throw new BrowserEventSchemaError(code);
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.origin !== value
    ) throw new BrowserEventSchemaError(code);
    return parsed.origin;
  } catch {
    throw new BrowserEventSchemaError(code);
  }
}

function parseLeaseChangedData(value: unknown): LeaseChangedEventData {
  const code = "BROWSER_EVENT_INVALID";
  const data = requireExactRecord(value, [
    "lease_id_digest",
    "browser_id_digest",
    "state",
    "ownership",
    "disposition",
    "change",
    "reason_code",
  ], code);
  const change = requireEnum(data.change, LEASE_EVENT_CHANGES, code);
  const reasonCode = data.reason_code === null
    ? null
    : requireEnum(data.reason_code, LEASE_EVENT_REASON_CODES, code);
  const state = requireEnum(data.state, LEASE_EVENT_STATES, code);
  const expectedReason: LeaseEventReasonCode | null = change === "created"
    ? null
    : change === "finalizing"
      ? "FINALIZATION_STARTED"
      : change === "tab_closed"
        ? "TAB_CLOSED"
        : change === "user_takeover"
          ? "USER_TAKEOVER"
          : change === "orphaned"
            ? "LEASE_ORPHANED"
            : state === "closed"
              ? "FINALIZED_CLOSED"
              : state === "released"
                ? "FINALIZED_RELEASED"
                : state === "retained"
                  ? "FINALIZED_RETAINED"
                  : "FINALIZATION_OUTCOME_UNKNOWN";
  const stateMatches = change === "created" ? state === "active"
    : change === "finalizing" ? state === "finalizing"
      : change === "tab_closed" ? state === "closed"
        : change === "user_takeover" ? state === "released"
          : change === "orphaned" ? state === "orphan"
            : ["closed", "released", "retained", "outcome_unknown"].includes(state);
  if (!stateMatches || reasonCode !== expectedReason) throw new BrowserEventSchemaError(code);
  return {
    leaseIdDigest: requireDigest(data.lease_id_digest, code),
    browserIdDigest: requireDigest(data.browser_id_digest, code),
    state,
    ownership: requireEnum(data.ownership, LEASE_EVENT_OWNERSHIPS, code),
    disposition: requireEnum(data.disposition, LEASE_EVENT_DISPOSITIONS, code),
    change,
    reasonCode,
  };
}

function parseTurnFinalizedData(value: unknown): TurnFinalizedEventData {
  const code = "BROWSER_EVENT_INVALID";
  const data = requireExactRecord(value, [
    "control_id",
    "status",
    "closed_count",
    "released_count",
    "retained_count",
    "already_finalized_count",
    "error_count",
  ], code);
  if (data.status !== "completed") throw new BrowserEventSchemaError(code);
  return {
    controlId: requireIdentifier(data.control_id, code),
    status: "completed",
    closedCount: requireSafeInteger(data.closed_count, code, 256),
    releasedCount: requireSafeInteger(data.released_count, code, 256),
    retainedCount: requireSafeInteger(data.retained_count, code, 256),
    alreadyFinalizedCount: requireSafeInteger(data.already_finalized_count, code, 256),
    errorCount: requireSafeInteger(data.error_count, code, 256),
  };
}

function parseChallengeRequiredData(value: unknown): ChallengeRequiredEventData {
  const code = "BROWSER_EVENT_INVALID";
  if (!isRecord(value)) throw new BrowserEventSchemaError(code);
  const commonKeys = [
    "challenge_id",
    "kind",
    "origin",
    "action_class",
    "canonical_parameter_hash",
    "target_fingerprint",
    "lease_id_digest",
    "browser_id_digest",
    "document_id",
    "document_epoch",
    "summary",
    "options",
    "expires_at_ms",
  ] as const;
  const data = requireExactRecord(
    value,
    value.kind === "action" ? [...commonKeys, "data_classification"] : commonKeys,
    code,
  );
  const common = {
    challengeId: requireIdentifier(data.challenge_id, code),
    origin: requireOrigin(data.origin, code),
    canonicalParameterHash: requireDigest(data.canonical_parameter_hash, code),
    targetFingerprint: requireDigest(data.target_fingerprint, code),
    leaseIdDigest: requireDigest(data.lease_id_digest, code),
    browserIdDigest: requireDigest(data.browser_id_digest, code),
    documentEpoch: requireSafeInteger(data.document_epoch, code),
    summary: data.summary as string,
    expiresAtMs: requireSafeInteger(data.expires_at_ms, code),
  };
  if (
    typeof data.summary !== "string"
    || data.summary.length < 1
    || data.summary.length > 512
    || !/^[\x20-\x7e]+$/u.test(data.summary)
    || common.expiresAtMs < 1
  ) throw new BrowserEventSchemaError(code);
  if (data.kind === "action") {
    if (
      (data.action_class !== "sensitive_input"
        && data.action_class !== "external_side_effect"
        && data.action_class !== "unknown")
      || data.document_id === null
      || !Array.isArray(data.options)
      || data.options.length !== 2
      || data.options[0] !== "decline"
      || data.options[1] !== "approve_once"
    ) throw new BrowserEventSchemaError(code);
    let dataClassification: ActionDataClassification;
    try {
      dataClassification = parseActionDataClassification(data.data_classification);
    } catch {
      throw new BrowserEventSchemaError(code);
    }
    return {
      ...common,
      kind: "action",
      actionClass: data.action_class,
      documentId: requireNullableIdentifier(data.document_id, code) as string,
      options: ["decline", "approve_once"],
      dataClassification,
    };
  }
  if (
    data.kind !== "site"
    || data.action_class !== "navigate"
    || typeof data.summary !== "string"
    || data.summary.length < 1
    || data.summary.length > 512
    || !/^[\x20-\x7e]+$/u.test(data.summary)
    || !Array.isArray(data.options)
    || data.options.length !== 3
    || data.options[0] !== "deny"
    || data.options[1] !== "allow_once"
    || data.options[2] !== "allow_turn"
  ) throw new BrowserEventSchemaError(code);
  return {
    ...common,
    kind: "site",
    actionClass: "navigate",
    documentId: requireNullableIdentifier(data.document_id, code),
    options: ["deny", "allow_once", "allow_turn"],
  };
}

export function parseBrowserEventParams(value: unknown): CriticalBrowserEventRecord {
  const code = "BROWSER_EVENT_INVALID";
  const root = requireExactRecord(value, [
    "contract_version",
    "event_id",
    "load_generation_id",
    "event_sequence",
    "delivery",
    "event_type",
    "observed_at_ms",
    "context_id",
    "browser_session_id",
    "turn_id",
    "op_id",
    "action_id",
    "data",
  ], code);
  if (root.contract_version !== BRIDGE_CONTRACT_VERSION || root.delivery !== "critical") {
    throw new BrowserEventSchemaError(code);
  }
  const common = {
    eventId: requireIdentifier(root.event_id, code),
    loadGenerationId: requireIdentifier(root.load_generation_id, code),
    sequence: requirePositiveSequence(root.event_sequence, code),
    delivery: "critical" as const,
    observedAt: requireSafeInteger(root.observed_at_ms, code),
    contextId: requireIdentifier(root.context_id, code),
    browserSessionId: requireIdentifier(root.browser_session_id, code),
    turnId: requireIdentifier(root.turn_id, code),
    opId: requireNullableIdentifier(root.op_id, code),
    actionId: requireNullableIdentifier(root.action_id, code),
  };
  const eventType = requireEnum(root.event_type, CRITICAL_BROWSER_EVENT_TYPES, code);
  if (eventType === "lease.changed") return { ...common, eventType, data: parseLeaseChangedData(root.data) };
  if (eventType === "turn.finalized") return { ...common, eventType, data: parseTurnFinalizedData(root.data) };
  if (common.opId === null || common.actionId === null) throw new BrowserEventSchemaError(code);
  return { ...common, eventType, data: parseChallengeRequiredData(root.data) };
}

export function buildBrowserEventParams(event: CriticalBrowserEventRecord): BrowserEventParams {
  const data = event.eventType === "lease.changed"
    ? {
        lease_id_digest: event.data.leaseIdDigest,
        browser_id_digest: event.data.browserIdDigest,
        state: event.data.state,
        ownership: event.data.ownership,
        disposition: event.data.disposition,
        change: event.data.change,
        reason_code: event.data.reasonCode,
      }
    : event.eventType === "turn.finalized" ? {
        control_id: event.data.controlId,
        status: event.data.status,
        closed_count: event.data.closedCount,
        released_count: event.data.releasedCount,
        retained_count: event.data.retainedCount,
        already_finalized_count: event.data.alreadyFinalizedCount,
        error_count: event.data.errorCount,
      }
    : {
        challenge_id: event.data.challengeId,
        kind: event.data.kind,
        origin: event.data.origin,
        action_class: event.data.actionClass,
        canonical_parameter_hash: event.data.canonicalParameterHash,
        target_fingerprint: event.data.targetFingerprint,
        lease_id_digest: event.data.leaseIdDigest,
        browser_id_digest: event.data.browserIdDigest,
        document_id: event.data.documentId,
        document_epoch: event.data.documentEpoch,
        summary: event.data.summary,
        options: [...event.data.options],
        ...(event.data.kind === "action"
          ? { data_classification: buildActionDataClassification(event.data.dataClassification) }
          : {}),
        expires_at_ms: event.data.expiresAtMs,
      };
  const wire = {
    contract_version: BRIDGE_CONTRACT_VERSION,
    event_id: event.eventId,
    load_generation_id: event.loadGenerationId,
    event_sequence: event.sequence,
    delivery: event.delivery,
    event_type: event.eventType,
    observed_at_ms: event.observedAt,
    context_id: event.contextId,
    browser_session_id: event.browserSessionId,
    turn_id: event.turnId,
    op_id: event.opId,
    action_id: event.actionId,
    data,
  } satisfies BrowserEventParams;
  parseBrowserEventParams(wire);
  return wire;
}

export function parseBrowserEventResult(value: unknown): { contractVersion: 1; eventId: string; status: "accepted" } {
  const code = "BROWSER_EVENT_RESULT_INVALID";
  const root = requireExactRecord(value, ["contract_version", "event_id", "status"], code);
  if (root.contract_version !== BRIDGE_CONTRACT_VERSION || root.status !== "accepted") {
    throw new BrowserEventSchemaError(code);
  }
  return { contractVersion: 1, eventId: requireIdentifier(root.event_id, code), status: "accepted" };
}

export function parseBrowserAckEventsParams(value: unknown): BrowserAckEventsRequest {
  const code = "BROWSER_EVENT_ACK_INVALID";
  const root = requireExactRecord(value, [
    "contract_version",
    "load_generation_id",
    "highest_contiguous_event_sequence",
  ], code);
  if (root.contract_version !== BRIDGE_CONTRACT_VERSION) throw new BrowserEventSchemaError(code);
  return {
    contractVersion: 1,
    loadGenerationId: requireIdentifier(root.load_generation_id, code),
    highestContiguousEventSequence: requireSafeInteger(root.highest_contiguous_event_sequence, code),
  };
}

export function buildBrowserAckEventsResult(request: BrowserAckEventsRequest): Record<string, unknown> {
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    load_generation_id: request.loadGenerationId,
    highest_contiguous_event_sequence: request.highestContiguousEventSequence,
    status: "acknowledged",
  };
}
