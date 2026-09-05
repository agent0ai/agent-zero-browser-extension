import {
  BRIDGE_CONTRACT_VERSION,
  encodedSize,
  hasExactKeys,
  isRecord,
  validOpaqueId,
} from "./rpc";

const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_CHALLENGE_CONTROL_BYTES = 64 * 1024;

export type SiteChallengeDecision = "deny" | "allow_once" | "allow_turn";
export type ActionChallengeDecision = "decline" | "approve_once";
export type ConsequentialActionClass = "sensitive_input" | "external_side_effect" | "unknown";
export interface SensitiveTextDataClassification {
  kind: "text";
  sensitivity: "sensitive";
  textSha256: string;
}
export type ActionDataClassification = "none" | SensitiveTextDataClassification;

export interface SiteChallengeGrant {
  originGrantId: string;
  scope: "operation" | "turn";
  origin: string;
  expiresAtMs: number;
}

export interface ActionChallengeGrant {
  actionGrantId: string;
  scope: "operation";
  origin: string;
  actionClass: ConsequentialActionClass;
  canonicalParameterHash: string;
  targetFingerprint: string;
  dataClassification: ActionDataClassification;
  expiresAtMs: number;
}

interface BrowserResolveChallengeRequestBase {
  contractVersion: typeof BRIDGE_CONTRACT_VERSION;
  controlId: string;
  challengeId: string;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  opId: string;
  actionId: string;
  tabHandle: string;
  documentId: string | null;
  documentEpoch: number;
  canonicalParameterHash: string;
  targetFingerprint: string;
  origin: string;
}

export interface SiteBrowserResolveChallengeRequest extends BrowserResolveChallengeRequestBase {
  actionClass: "navigate";
  decision: SiteChallengeDecision;
  grant: SiteChallengeGrant | null;
}

export interface ActionBrowserResolveChallengeRequest extends BrowserResolveChallengeRequestBase {
  documentId: string;
  actionClass: ConsequentialActionClass;
  dataClassification: ActionDataClassification;
  decision: ActionChallengeDecision;
  grant: ActionChallengeGrant | null;
}

export type BrowserResolveChallengeRequest =
  | SiteBrowserResolveChallengeRequest
  | ActionBrowserResolveChallengeRequest;

export interface BrowserResolveChallengeResult extends Record<string, unknown> {
  contract_version: typeof BRIDGE_CONTRACT_VERSION;
  control_id: string;
  challenge_id: string;
  status: "resolved";
  decision: SiteChallengeDecision | ActionChallengeDecision;
}

export class ChallengeSchemaError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "ChallengeSchemaError";
  }
}

function invalid(): never {
  throw new ChallengeSchemaError("BROWSER_CHALLENGE_INVALID");
}

function identifier(value: unknown): string {
  if (!validOpaqueId(value)) invalid();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid();
  return value;
}

export function parseActionDataClassification(value: unknown): ActionDataClassification {
  if (value === "none") return "none";
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["kind", "sensitivity", "text_sha256"])
    || value.kind !== "text"
    || value.sensitivity !== "sensitive"
  ) invalid();
  return {
    kind: "text",
    sensitivity: "sensitive",
    textSha256: digest(value.text_sha256),
  };
}

export function buildActionDataClassification(value: ActionDataClassification): "none" | Record<string, unknown> {
  return value === "none"
    ? "none"
    : {
        kind: value.kind,
        sensitivity: value.sensitivity,
        text_sha256: value.textSha256,
      };
}

export function actionDataClassificationsEqual(
  left: ActionDataClassification,
  right: ActionDataClassification,
): boolean {
  return left === "none"
    ? right === "none"
    : right !== "none"
      && left.kind === right.kind
      && left.sensitivity === right.sensitivity
      && left.textSha256 === right.textSha256;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

function positiveTimestamp(value: unknown): number {
  const parsed = nonnegativeInteger(value);
  if (parsed < 1) invalid();
  return parsed;
}

function exactOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) invalid();
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.origin !== value
    ) invalid();
    return parsed.origin;
  } catch {
    return invalid();
  }
}

function parseGrant(value: unknown): SiteChallengeGrant {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["origin_grant_id", "scope", "origin", "expires_at_ms"])
  ) invalid();
  if (value.scope !== "operation" && value.scope !== "turn") invalid();
  return {
    originGrantId: identifier(value.origin_grant_id),
    scope: value.scope,
    origin: exactOrigin(value.origin),
    expiresAtMs: positiveTimestamp(value.expires_at_ms),
  };
}

function parseActionGrant(value: unknown): ActionChallengeGrant {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "action_grant_id",
      "scope",
      "origin",
      "action_class",
      "canonical_parameter_hash",
      "target_fingerprint",
      "data_classification",
      "expires_at_ms",
    ])
    || value.scope !== "operation"
    || (value.action_class !== "sensitive_input"
      && value.action_class !== "external_side_effect"
      && value.action_class !== "unknown")
  ) invalid();
  return {
    actionGrantId: identifier(value.action_grant_id),
    scope: "operation",
    origin: exactOrigin(value.origin),
    actionClass: value.action_class,
    canonicalParameterHash: digest(value.canonical_parameter_hash),
    targetFingerprint: digest(value.target_fingerprint),
    dataClassification: parseActionDataClassification(value.data_classification),
    expiresAtMs: positiveTimestamp(value.expires_at_ms),
  };
}

export function parseBrowserResolveChallengeRequest(value: unknown): BrowserResolveChallengeRequest {
  if (!isRecord(value) || encodedSize(value) > MAX_CHALLENGE_CONTROL_BYTES) invalid();
  const commonKeys = [
      "contract_version",
      "control_id",
      "challenge_id",
      "context_id",
      "browser_session_id",
      "turn_id",
      "op_id",
      "action_id",
      "tab_handle",
      "document_id",
      "document_epoch",
      "canonical_parameter_hash",
      "target_fingerprint",
      "origin",
      "action_class",
      "decision",
      "grant",
  ] as const;
  const common = {
    contractVersion: BRIDGE_CONTRACT_VERSION,
    controlId: identifier(value.control_id),
    challengeId: identifier(value.challenge_id),
    contextId: identifier(value.context_id),
    browserSessionId: identifier(value.browser_session_id),
    turnId: identifier(value.turn_id),
    opId: identifier(value.op_id),
    actionId: identifier(value.action_id),
    tabHandle: identifier(value.tab_handle),
    documentId: value.document_id === null ? null : identifier(value.document_id),
    documentEpoch: nonnegativeInteger(value.document_epoch),
    canonicalParameterHash: digest(value.canonical_parameter_hash),
    targetFingerprint: digest(value.target_fingerprint),
    origin: exactOrigin(value.origin),
  };
  if (value.contract_version !== BRIDGE_CONTRACT_VERSION) invalid();
  if (value.action_class === "navigate") {
    if (
      !hasExactKeys(value, commonKeys)
      || (value.decision !== "deny" && value.decision !== "allow_once" && value.decision !== "allow_turn")
    ) invalid();
    const decision = value.decision;
    const grant = value.grant === null ? null : parseGrant(value.grant);
    if (
      (decision === "deny" && grant !== null)
      || (decision === "allow_once" && grant?.scope !== "operation")
      || (decision === "allow_turn" && grant?.scope !== "turn")
    ) invalid();
    return { ...common, actionClass: "navigate", decision, grant };
  }
  if (
    !hasExactKeys(value, [...commonKeys, "data_classification"])
    || value.document_id === null
    || (value.action_class !== "sensitive_input"
      && value.action_class !== "external_side_effect"
      && value.action_class !== "unknown")
    || (value.decision !== "decline" && value.decision !== "approve_once")
  ) invalid();
  const decision = value.decision;
  const grant = value.grant === null ? null : parseActionGrant(value.grant);
  if ((decision === "decline" && grant !== null) || (decision === "approve_once" && grant === null)) invalid();
  return {
    ...common,
    documentId: identifier(value.document_id),
    actionClass: value.action_class,
    dataClassification: parseActionDataClassification(value.data_classification),
    decision,
    grant,
  };
}

export function buildBrowserResolveChallengeResult(
  request: Pick<BrowserResolveChallengeRequest, "controlId" | "challengeId" | "decision">,
): BrowserResolveChallengeResult {
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    control_id: request.controlId,
    challenge_id: request.challengeId,
    status: "resolved",
    decision: request.decision,
  };
}

export function parseBrowserResolveChallengeResult(value: unknown): BrowserResolveChallengeResult {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["contract_version", "control_id", "challenge_id", "status", "decision"])
    || value.contract_version !== BRIDGE_CONTRACT_VERSION
    || value.status !== "resolved"
    || (value.decision !== "deny"
      && value.decision !== "allow_once"
      && value.decision !== "allow_turn"
      && value.decision !== "decline"
      && value.decision !== "approve_once")
  ) invalid();
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    control_id: identifier(value.control_id),
    challenge_id: identifier(value.challenge_id),
    status: "resolved",
    decision: value.decision,
  };
}
