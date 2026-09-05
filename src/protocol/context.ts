import { BRIDGE_CONTRACT_VERSION, hasExactKeys, isRecord, validOpaqueId } from "./rpc";

export const MAX_CONTEXT_LIST_ITEMS = 64;
export const MAX_CONTEXT_PAGE_EVENTS = 50;
export const MAX_CONTEXT_EVENT_TEXT_BYTES = 8 * 1024;
export const MAX_CONTEXT_MESSAGE_TEXT_BYTES = 32 * 1024;

const textEncoder = new TextEncoder();
const CONTEXT_KINDS = ["chat", "task"] as const;
const CONTEXT_STATUSES = ["idle", "running", "paused"] as const;
const COMPLETION_STATUSES = ["completed", "canceled", "failed"] as const;
const MESSAGE_ROLES = ["user", "assistant"] as const;
const ACTIVITY_PAIRS = new Set([
  "assistant_work:working",
  "browser:updated",
  "code:updated",
  "subagent:updated",
  "status:failed",
  "status:updated",
  "status:warning",
  "tool:updated",
]);

export class ContextSchemaError extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
    this.name = "ContextSchemaError";
  }
}

export interface ContextSummary {
  contextId: string;
  label: string;
  kind: (typeof CONTEXT_KINDS)[number];
  status: (typeof CONTEXT_STATUSES)[number];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ContextMessageEvent {
  contextId: string;
  sequence: number;
  event: "message";
  data: { role: (typeof MESSAGE_ROLES)[number]; text: string };
  timestampMs?: number;
  correlationId?: string;
}

export interface ContextActivityEvent {
  contextId: string;
  sequence: number;
  event: "activity";
  data: { activity: string; status: string };
  timestampMs?: number;
  correlationId?: string;
}

export type ContextEvent = ContextMessageEvent | ContextActivityEvent;
export type ContextEventNotification = ContextEvent & { lastSequence: number };

export interface ContextSnapshotNotification {
  contextId: string;
  events: ContextEvent[];
  lastSequence: number;
  complete: boolean;
  historyBefore?: number;
  hasMoreHistory?: boolean;
}

export interface ContextCompleteNotification {
  contextId: string;
  status: (typeof COMPLETION_STATUSES)[number];
}

export interface ContextSubscribeInput {
  contextId: string;
  from?: number;
  history?: "tail";
  historyBefore?: number;
}

export interface ContextSubscribeResult {
  contextId: string;
  subscribed: true;
  lastSequence: number;
  historyBefore?: number;
  hasMoreHistory?: boolean;
}

export interface ContextSendMessageResult {
  contextId: string;
  status: "accepted";
  clientMessageId: string;
}

export interface ContextQueueItem { id: string; text: string }
export interface ContextQueueProjection { contextId: string; messageQueue: ContextQueueItem[] }
export interface ContextQueueResult extends ContextQueueProjection { itemId: string; status: "queued" | "removed" | "sent" }
export interface LocalApprovalPresentation {
  contextId: string; challengeId: string; kind: "site" | "action"; origin: string;
  summary: string; expiresAtMs: number; options: LocalApprovalInput["decision"][];
}
export type LocalApprovalInput = { challengeId: string; kind: "site" | "action"; decision: "deny" | "allow_once" | "allow_turn" | "decline" | "approve_once" };

export function buildContextQueueAddParams(input: { contextId: string; clientMessageId: string; text: string }): Record<string, unknown> {
  const { artifact_ids: _artifacts, tab_candidates: _candidates, ...params } = buildContextSendMessageParams(input);
  return params;
}

export function buildContextQueueItemParams(contextId: string, itemId: string): Record<string, unknown> {
  return { contract_version: 1, context_id: requireIdentifier(contextId, "CONTEXT_QUEUE_INVALID"), item_id: requireIdentifier(itemId, "CONTEXT_QUEUE_INVALID") };
}

export function parseContextQueueProjection(value: unknown): ContextQueueProjection {
  const code = "CONTEXT_QUEUE_INVALID";
  const root = requireExactRecord(value, ["contract_version", "context_id", "message_queue"], [], code);
  requireContract(root, code);
  if (!Array.isArray(root.message_queue) || root.message_queue.length > 32) throw new ContextSchemaError(code);
  const items = root.message_queue.map((value) => {
    const item = requireExactRecord(value, ["id", "text", "attachments", "attachment_count"], [], code);
    if (!Array.isArray(item.attachments) || item.attachments.length !== 0 || item.attachment_count !== 0
      || typeof item.text !== "string" || !validUnicode(item.text) || [...item.text].length > 100) throw new ContextSchemaError(code);
    return { id: requireIdentifier(item.id, code), text: item.text };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new ContextSchemaError(code);
  return { contextId: requireIdentifier(root.context_id, code), messageQueue: items };
}

export function parseContextQueueResult(value: unknown): ContextQueueResult {
  const code = "CONTEXT_QUEUE_INVALID";
  const root = requireExactRecord(value, ["contract_version", "context_id", "message_queue", "item_id", "status"], [], code);
  const { item_id: itemId, status, ...projection } = root;
  return { ...parseContextQueueProjection(projection), itemId: requireIdentifier(itemId, code), status: requireEnum(status, ["queued", "removed", "sent"] as const, code) };
}

export function buildLocalApprovalParams(input: LocalApprovalInput): Record<string, unknown> {
  const code = "LOCAL_APPROVAL_INVALID";
  const allowed = input.kind === "site" ? ["deny", "allow_once", "allow_turn"] : input.kind === "action" ? ["decline", "approve_once"] : [];
  if (!allowed.includes(input.decision)) throw new ContextSchemaError(code);
  return { contract_version: 1, challenge_id: requireIdentifier(input.challengeId, code), kind: input.kind, decision: input.decision };
}

export function parseLocalApprovalResult(value: unknown, input: LocalApprovalInput): Record<string, unknown> {
  const code = "LOCAL_APPROVAL_INVALID";
  const root = requireExactRecord(value, ["contract_version", "challenge_id", "decision", "control_id", "status", ...(input.kind === "site" ? ["expires_at_ms"] : [])], [], code);
  requireContract(root, code);
  const expected = input.decision === "approve_once" ? "approved" : input.decision === "decline" ? "declined" : input.decision;
  if (root.challenge_id !== input.challengeId || root.decision !== expected || root.status !== "accepted") throw new ContextSchemaError(code);
  requireIdentifier(root.control_id, code);
  if (input.kind === "site") requireCursor(root.expires_at_ms, code);
  return { ...root };
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function utf8ByteLength(value: string): number {
  if (!validUnicode(value)) return Number.POSITIVE_INFINITY;
  return textEncoder.encode(value).byteLength;
}

function requireText(value: unknown, code: string, maxBytes: number, allowWhitespace = true): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || (!allowWhitespace && value.trim().length === 0)
    || utf8ByteLength(value) > maxBytes
  ) {
    throw new ContextSchemaError(code);
  }
  return value;
}

function requireIdentifier(value: unknown, code: string): string {
  if (!validOpaqueId(value)) throw new ContextSchemaError(code);
  return value;
}

function requireCursor(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ContextSchemaError(code);
  return Number(value);
}

function requireExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, required, optional)) throw new ContextSchemaError(code);
  return value;
}

function requireContract(root: Record<string, unknown>, code: string): void {
  if (root.contract_version !== BRIDGE_CONTRACT_VERSION) throw new ContextSchemaError(code);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ContextSchemaError(code);
  return value as T;
}

function parseSummary(value: unknown): ContextSummary {
  const code = "CONTEXT_LIST_INVALID";
  const root = requireExactRecord(
    value,
    ["context_id", "label", "kind", "status", "created_at_ms", "updated_at_ms"],
    [],
    code,
  );
  const createdAtMs = requireCursor(root.created_at_ms, code);
  const updatedAtMs = requireCursor(root.updated_at_ms, code);
  if (updatedAtMs < createdAtMs) throw new ContextSchemaError(code);
  return {
    contextId: requireIdentifier(root.context_id, code),
    label: requireText(root.label, code, 256),
    kind: requireEnum(root.kind, CONTEXT_KINDS, code),
    status: requireEnum(root.status, CONTEXT_STATUSES, code),
    createdAtMs,
    updatedAtMs,
  };
}

function parseEvent(value: unknown, expectedContextId?: string): ContextEvent {
  const code = "CONTEXT_EVENT_INVALID";
  const root = requireExactRecord(
    value,
    ["context_id", "sequence", "event", "data"],
    ["timestamp_ms", "correlation_id"],
    code,
  );
  const contextId = requireIdentifier(root.context_id, code);
  if (expectedContextId && contextId !== expectedContextId) throw new ContextSchemaError(code);
  const sequence = requireCursor(root.sequence, code);
  if (sequence < 1) throw new ContextSchemaError(code);
  const timestampMs = root.timestamp_ms === undefined ? undefined : requireCursor(root.timestamp_ms, code);
  const correlationId = root.correlation_id === undefined
    ? undefined
    : requireIdentifier(root.correlation_id, code);
  if (root.event === "message") {
    const data = requireExactRecord(root.data, ["role", "text"], [], code);
    return {
      contextId,
      sequence,
      event: "message",
      data: {
        role: requireEnum(data.role, MESSAGE_ROLES, code),
        text: requireText(data.text, code, MAX_CONTEXT_EVENT_TEXT_BYTES),
      },
      ...(timestampMs === undefined ? {} : { timestampMs }),
      ...(correlationId === undefined ? {} : { correlationId }),
    };
  }
  if (root.event === "activity") {
    const data = requireExactRecord(root.data, ["activity", "status"], [], code);
    const activity = requireText(data.activity, code, 64);
    const status = requireText(data.status, code, 64);
    if (!ACTIVITY_PAIRS.has(`${activity}:${status}`)) throw new ContextSchemaError(code);
    return {
      contextId,
      sequence,
      event: "activity",
      data: { activity, status },
      ...(timestampMs === undefined ? {} : { timestampMs }),
      ...(correlationId === undefined ? {} : { correlationId }),
    };
  }
  throw new ContextSchemaError(code);
}

function pagination(
  root: Record<string, unknown>,
  code: string,
): { historyBefore?: number; hasMoreHistory?: boolean } {
  const hasBefore = root.history_before !== undefined;
  const hasMore = root.has_more_history !== undefined;
  if (hasBefore !== hasMore || (hasMore && typeof root.has_more_history !== "boolean")) {
    throw new ContextSchemaError(code);
  }
  return hasBefore
    ? {
        historyBefore: requireCursor(root.history_before, code),
        hasMoreHistory: root.has_more_history as boolean,
      }
    : {};
}

export function buildContextListParams(limit = MAX_CONTEXT_LIST_ITEMS): Record<string, unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONTEXT_LIST_ITEMS) {
    throw new ContextSchemaError("CONTEXT_LIST_INVALID");
  }
  return { contract_version: BRIDGE_CONTRACT_VERSION, limit };
}

export function parseContextListResult(value: unknown): { contractVersion: 1; contexts: ContextSummary[] } {
  const code = "CONTEXT_LIST_INVALID";
  const root = requireExactRecord(value, ["contract_version", "contexts"], [], code);
  requireContract(root, code);
  if (!Array.isArray(root.contexts) || root.contexts.length > MAX_CONTEXT_LIST_ITEMS) {
    throw new ContextSchemaError(code);
  }
  const contexts = root.contexts.map(parseSummary);
  if (new Set(contexts.map((context) => context.contextId)).size !== contexts.length) {
    throw new ContextSchemaError(code);
  }
  return { contractVersion: BRIDGE_CONTRACT_VERSION, contexts };
}

export function buildContextSubscribeParams(input: ContextSubscribeInput): Record<string, unknown> {
  const contextId = requireIdentifier(input.contextId, "CONTEXT_SUBSCRIBE_INVALID");
  const selectors = [input.from !== undefined, input.history !== undefined, input.historyBefore !== undefined]
    .filter(Boolean).length;
  if (selectors > 1) throw new ContextSchemaError("CONTEXT_SUBSCRIBE_INVALID");
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    context_id: contextId,
    ...(input.from === undefined ? {} : { from: requireCursor(input.from, "CONTEXT_SUBSCRIBE_INVALID") }),
    ...(input.history === undefined
      ? {}
      : { history: requireEnum(input.history, ["tail"] as const, "CONTEXT_SUBSCRIBE_INVALID") }),
    ...(input.historyBefore === undefined
      ? {}
      : { history_before: requireCursor(input.historyBefore, "CONTEXT_SUBSCRIBE_INVALID") }),
  };
}

export function parseContextSubscribeResult(value: unknown): ContextSubscribeResult {
  const code = "CONTEXT_SUBSCRIBE_INVALID";
  const root = requireExactRecord(
    value,
    ["contract_version", "context_id", "subscribed", "last_sequence"],
    ["history_before", "has_more_history"],
    code,
  );
  requireContract(root, code);
  if (root.subscribed !== true) throw new ContextSchemaError(code);
  const lastSequence = requireCursor(root.last_sequence, code);
  const page = pagination(root, code);
  if (page.historyBefore !== undefined && page.historyBefore > lastSequence) {
    throw new ContextSchemaError(code);
  }
  return {
    contextId: requireIdentifier(root.context_id, code),
    subscribed: true,
    lastSequence,
    ...page,
  };
}

export function buildContextUnsubscribeParams(contextId: string): Record<string, unknown> {
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    context_id: requireIdentifier(contextId, "CONTEXT_UNSUBSCRIBE_INVALID"),
  };
}

export function parseContextUnsubscribeResult(value: unknown): { contextId: string; unsubscribed: true } {
  const code = "CONTEXT_UNSUBSCRIBE_INVALID";
  const root = requireExactRecord(value, ["contract_version", "context_id", "unsubscribed"], [], code);
  requireContract(root, code);
  if (root.unsubscribed !== true) throw new ContextSchemaError(code);
  return { contextId: requireIdentifier(root.context_id, code), unsubscribed: true };
}

export function buildContextSendMessageParams(input: {
  contextId: string;
  clientMessageId: string;
  text: string;
  artifactIds?: readonly unknown[];
  tabCandidates?: readonly unknown[];
}): Record<string, unknown> {
  if ((input.artifactIds?.length ?? 0) !== 0 || (input.tabCandidates?.length ?? 0) !== 0) {
    throw new ContextSchemaError("CONTEXT_MESSAGE_INVALID");
  }
  return {
    contract_version: BRIDGE_CONTRACT_VERSION,
    context_id: requireIdentifier(input.contextId, "CONTEXT_MESSAGE_INVALID"),
    client_message_id: requireIdentifier(input.clientMessageId, "CONTEXT_MESSAGE_INVALID"),
    text: requireText(input.text, "CONTEXT_MESSAGE_INVALID", MAX_CONTEXT_MESSAGE_TEXT_BYTES, false),
    artifact_ids: [],
    tab_candidates: [],
  };
}

export function parseContextSendMessageResult(value: unknown): ContextSendMessageResult {
  const code = "CONTEXT_MESSAGE_INVALID";
  const root = requireExactRecord(
    value,
    ["contract_version", "context_id", "status", "client_message_id"],
    [],
    code,
  );
  requireContract(root, code);
  if (root.status !== "accepted") throw new ContextSchemaError(code);
  return {
    contextId: requireIdentifier(root.context_id, code),
    status: "accepted",
    clientMessageId: requireIdentifier(root.client_message_id, code),
  };
}

export function parseContextSnapshotNotification(value: unknown): ContextSnapshotNotification {
  const code = "CONTEXT_SNAPSHOT_INVALID";
  const root = requireExactRecord(
    value,
    ["contract_version", "context_id", "events", "last_sequence", "complete"],
    ["history_before", "has_more_history"],
    code,
  );
  requireContract(root, code);
  const contextId = requireIdentifier(root.context_id, code);
  if (!Array.isArray(root.events) || root.events.length > MAX_CONTEXT_PAGE_EVENTS || typeof root.complete !== "boolean") {
    throw new ContextSchemaError(code);
  }
  const events = root.events.map((event) => parseEvent(event, contextId));
  const lastSequence = requireCursor(root.last_sequence, code);
  if (
    events.some((event) => event.sequence > lastSequence)
    || events.some((event, index) => index > 0 && event.sequence <= events[index - 1].sequence)
  ) {
    throw new ContextSchemaError(code);
  }
  const page = pagination(root, code);
  if (page.historyBefore !== undefined && page.historyBefore > lastSequence) {
    throw new ContextSchemaError(code);
  }
  return { contextId, events, lastSequence, complete: root.complete, ...page };
}

export function parseContextEventNotification(value: unknown): ContextEventNotification {
  const root = requireExactRecord(
    value,
    ["contract_version", "context_id", "sequence", "event", "data", "last_sequence"],
    ["timestamp_ms", "correlation_id"],
    "CONTEXT_EVENT_INVALID",
  );
  requireContract(root, "CONTEXT_EVENT_INVALID");
  const { contract_version: _contract, last_sequence: lastSequenceValue, ...event } = root;
  const parsed = parseEvent(event);
  const lastSequence = requireCursor(lastSequenceValue, "CONTEXT_EVENT_INVALID");
  if (lastSequence < parsed.sequence) throw new ContextSchemaError("CONTEXT_EVENT_INVALID");
  return { ...parsed, lastSequence };
}

export function parseContextCompleteNotification(value: unknown): ContextCompleteNotification {
  const code = "CONTEXT_COMPLETE_INVALID";
  const root = requireExactRecord(value, ["contract_version", "context_id", "status"], [], code);
  requireContract(root, code);
  return {
    contextId: requireIdentifier(root.context_id, code),
    status: requireEnum(root.status, COMPLETION_STATUSES, code),
  };
}
