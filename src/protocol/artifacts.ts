import {
  BRIDGE_CONTRACT_VERSION,
  encodedSize,
  hasExactKeys,
  isRecord,
  validOpaqueId,
} from "./rpc";
// Keep the artifact codec independent from hello negotiation. These values are
// the frozen v1 wire limits and are separately asserted by the hello codec.
export const MAX_OUTPUT_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const MAX_OUTPUT_ARTIFACT_CHUNK_BYTES = 192 * 1024;

const CHECKSUM = /^sha256:[0-9a-f]{64}$/u;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_ARTIFACT_FRAME_BYTES = 768 * 1024;

export type ArtifactPurpose = "screenshot" | "download";
export type ArtifactPhase = "begin" | "chunk" | "end" | "abort";
export type ArtifactAbortReason =
  | "ARTIFACT_TOO_LARGE"
  | "CANCELED"
  | "CONNECTION_LOST"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL_ERROR"
  | "OUTCOME_UNKNOWN";

export interface OutputArtifactBinding {
  contextId: string;
  browserSessionId: string;
  turnId: string;
  actionId: string;
  opId: string;
  artifactId: string;
  direction: "output";
  purpose: ArtifactPurpose;
}

export interface ArtifactDescriptor extends Record<string, unknown> {
  artifact_id: string;
  mime_type: string;
  byte_count: number;
  sha256: string;
  purpose: ArtifactPurpose;
}

export type ArtifactAck =
  | (OutputArtifactBinding & {
      phase: "begin" | "chunk";
      status: "accepted" | "duplicate";
      nextChunkIndex: number;
      receivedBytes: number;
    })
  | (OutputArtifactBinding & {
      phase: "end";
      status: "complete";
      descriptor: ArtifactDescriptor;
    })
  | (OutputArtifactBinding & {
      phase: ArtifactPhase;
      status: "aborted";
      reasonCode: ArtifactAbortReason;
    });

export class ArtifactSchemaError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "ArtifactSchemaError";
  }
}

function invalid(): never {
  throw new ArtifactSchemaError("BROWSER_ARTIFACT_INVALID");
}

function identifier(value: unknown): string {
  if (!validOpaqueId(value)) invalid();
  return value;
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) invalid();
  return Number(value);
}

function abortReason(value: unknown): ArtifactAbortReason {
  if (
    value !== "ARTIFACT_TOO_LARGE"
    && value !== "CANCELED"
    && value !== "CONNECTION_LOST"
    && value !== "DEADLINE_EXCEEDED"
    && value !== "INTERNAL_ERROR"
    && value !== "OUTCOME_UNKNOWN"
  ) invalid();
  return value;
}

function common(binding: OutputArtifactBinding): Record<string, unknown> {
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    context_id: binding.contextId,
    browser_session_id: binding.browserSessionId,
    turn_id: binding.turnId,
    action_id: binding.actionId,
    op_id: binding.opId,
    artifact_id: binding.artifactId,
    direction: binding.direction,
    purpose: binding.purpose,
  };
}

function validateBinding(binding: OutputArtifactBinding): void {
  identifier(binding.contextId);
  identifier(binding.browserSessionId);
  identifier(binding.turnId);
  identifier(binding.actionId);
  identifier(binding.opId);
  identifier(binding.artifactId);
  if (binding.direction !== "output" || (binding.purpose !== "screenshot" && binding.purpose !== "download")) invalid();
}

function validateFrame(value: Record<string, unknown>): Record<string, unknown> {
  if (encodedSize(value) > MAX_ARTIFACT_FRAME_BYTES) invalid();
  return value;
}

export function buildArtifactBeginParams(
  binding: OutputArtifactBinding,
  metadata: { mimeType: string; byteCount: number; sha256: string },
): Record<string, unknown> {
  validateBinding(binding);
  if (!MIME_TYPE.test(metadata.mimeType) || !CHECKSUM.test(metadata.sha256)) invalid();
  safeInteger(metadata.byteCount, MAX_OUTPUT_ARTIFACT_BYTES);
  return validateFrame({
    ...common(binding),
    mime_type: metadata.mimeType,
    byte_count: metadata.byteCount,
    sha256: metadata.sha256,
  });
}

export function buildArtifactChunkParams(
  binding: OutputArtifactBinding,
  chunkIndex: number,
  data: string,
): Record<string, unknown> {
  validateBinding(binding);
  safeInteger(chunkIndex);
  if (!data || !CANONICAL_BASE64.test(data)) invalid();
  let decoded: string;
  try {
    decoded = atob(data);
  } catch {
    return invalid();
  }
  if (decoded.length < 1 || decoded.length > MAX_OUTPUT_ARTIFACT_CHUNK_BYTES || btoa(decoded) !== data) invalid();
  return validateFrame({ ...common(binding), chunk_index: chunkIndex, data });
}

export function buildArtifactEndParams(binding: OutputArtifactBinding): Record<string, unknown> {
  validateBinding(binding);
  return validateFrame(common(binding));
}

export function buildArtifactAbortParams(
  binding: OutputArtifactBinding,
  reasonCode: ArtifactAbortReason,
): Record<string, unknown> {
  validateBinding(binding);
  return validateFrame({ ...common(binding), reason_code: abortReason(reasonCode) });
}

function parseCommon(value: Record<string, unknown>): OutputArtifactBinding {
  if (value.contract_version !== BRIDGE_CONTRACT_VERSION || value.direction !== "output") invalid();
  if (value.purpose !== "screenshot" && value.purpose !== "download") invalid();
  return {
    contextId: identifier(value.context_id),
    browserSessionId: identifier(value.browser_session_id),
    turnId: identifier(value.turn_id),
    actionId: identifier(value.action_id),
    opId: identifier(value.op_id),
    artifactId: identifier(value.artifact_id),
    direction: "output",
    purpose: value.purpose,
  };
}

function sameBinding(actual: OutputArtifactBinding, expected: OutputArtifactBinding): boolean {
  return actual.contextId === expected.contextId
    && actual.browserSessionId === expected.browserSessionId
    && actual.turnId === expected.turnId
    && actual.actionId === expected.actionId
    && actual.opId === expected.opId
    && actual.artifactId === expected.artifactId
    && actual.direction === expected.direction
    && actual.purpose === expected.purpose;
}

function parseDescriptor(value: unknown): ArtifactDescriptor {
  if (!isRecord(value) || !hasExactKeys(value, ["artifact_id", "mime_type", "byte_count", "sha256", "purpose"])) invalid();
  if (typeof value.mime_type !== "string" || !MIME_TYPE.test(value.mime_type)) invalid();
  if (typeof value.sha256 !== "string" || !CHECKSUM.test(value.sha256)) invalid();
  if (value.purpose !== "screenshot" && value.purpose !== "download") invalid();
  return {
    artifact_id: identifier(value.artifact_id),
    mime_type: value.mime_type,
    byte_count: safeInteger(value.byte_count, MAX_OUTPUT_ARTIFACT_BYTES),
    sha256: value.sha256,
    purpose: value.purpose,
  };
}

export function parseArtifactAck(
  value: unknown,
  expectedBinding: OutputArtifactBinding,
  expectedPhase: ArtifactPhase,
): ArtifactAck {
  if (!isRecord(value) || encodedSize(value) > MAX_ARTIFACT_FRAME_BYTES) invalid();
  const baseKeys = [
    "contract_version",
    "context_id",
    "browser_session_id",
    "turn_id",
    "action_id",
    "op_id",
    "artifact_id",
    "direction",
    "purpose",
    "phase",
    "status",
  ];
  if (value.phase !== expectedPhase) invalid();
  const actualBinding = parseCommon(value);
  if (!sameBinding(actualBinding, expectedBinding)) invalid();
  if (value.status === "aborted") {
    if (!hasExactKeys(value, [...baseKeys, "reason_code"])) invalid();
    return { ...actualBinding, phase: expectedPhase, status: "aborted", reasonCode: abortReason(value.reason_code) };
  }
  if (expectedPhase === "begin" || expectedPhase === "chunk") {
    if (
      !hasExactKeys(value, [...baseKeys, "next_chunk_index", "received_bytes"])
      || (value.status !== "accepted" && value.status !== "duplicate")
    ) invalid();
    return {
      ...actualBinding,
      phase: expectedPhase,
      status: value.status,
      nextChunkIndex: safeInteger(value.next_chunk_index),
      receivedBytes: safeInteger(value.received_bytes, MAX_OUTPUT_ARTIFACT_BYTES),
    };
  }
  if (expectedPhase === "end") {
    if (!hasExactKeys(value, [...baseKeys, "descriptor"]) || value.status !== "complete") invalid();
    return { ...actualBinding, phase: "end", status: "complete", descriptor: parseDescriptor(value.descriptor) };
  }
  if (!hasExactKeys(value, [...baseKeys, "reason_code"]) || value.status !== "aborted") invalid();
  return { ...actualBinding, phase: "abort", status: "aborted", reasonCode: abortReason(value.reason_code) };
}
