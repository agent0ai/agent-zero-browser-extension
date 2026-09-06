import {
  MAX_CONTEXT_EVENT_TEXT_BYTES,
  MAX_CONTEXT_MESSAGE_TEXT_BYTES,
  MAX_CONTEXT_LIST_ITEMS,
  utf8ByteLength,
  type ContextEvent,
  type ContextSummary,
} from "../protocol/context";
import type { ContextProjection } from "../background/context-relay";

const MAX_PROJECTED_EVENTS = 512;

export interface ContextPresentation {
  contexts: ContextSummary[];
  selectedContextId: string | null;
  suggestedContextId: string | null;
  selected: ContextProjection | null;
  draft?: string;
}

export const EMPTY_CONTEXT_PRESENTATION: ContextPresentation = {
  contexts: [],
  selectedContextId: null,
  suggestedContextId: null,
  selected: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);

const isCursor = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function parseSummary(value: unknown): ContextSummary | null {
  if (!isRecord(value)) return null;
  if (
    !isIdentifier(value.contextId)
    || typeof value.label !== "string"
    || value.label.length === 0
    || utf8ByteLength(value.label) > 256
    || (value.kind !== "chat" && value.kind !== "task")
    || !["idle", "running", "paused"].includes(String(value.status))
    || !isCursor(value.createdAtMs)
    || !isCursor(value.updatedAtMs)
    || value.updatedAtMs < value.createdAtMs
  ) return null;
  return {
    contextId: value.contextId,
    label: value.label,
    kind: value.kind,
    status: value.status as ContextSummary["status"],
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.updatedAtMs,
  };
}

function parseEvent(value: unknown, contextId: string): ContextEvent | null {
  if (
    !isRecord(value)
    || value.contextId !== contextId
    || !isCursor(value.sequence)
    || value.sequence < 1
    || !isRecord(value.data)
  ) return null;
  const optional = {
    ...(isCursor(value.timestampMs) ? { timestampMs: value.timestampMs } : {}),
    ...(isIdentifier(value.correlationId) ? { correlationId: value.correlationId } : {}),
  };
  if (
    value.event === "message"
    && (value.data.role === "user" || value.data.role === "assistant")
    && typeof value.data.text === "string"
    && value.data.text.length > 0
    && utf8ByteLength(value.data.text) <= MAX_CONTEXT_EVENT_TEXT_BYTES
  ) {
    return {
      contextId,
      sequence: value.sequence,
      event: "message",
      data: { role: value.data.role, text: value.data.text },
      ...optional,
    };
  }
  if (
    value.event === "activity"
    && typeof value.data.activity === "string"
    && typeof value.data.status === "string"
    && value.data.activity.length <= 64
    && value.data.status.length <= 64
  ) {
    return {
      contextId,
      sequence: value.sequence,
      event: "activity",
      data: { activity: value.data.activity, status: value.data.status },
      ...optional,
    };
  }
  return null;
}

export function parseContextPresentation(value: unknown): ContextPresentation {
  if (!isRecord(value) || !Array.isArray(value.contexts) || value.contexts.length > MAX_CONTEXT_LIST_ITEMS) {
    return EMPTY_CONTEXT_PRESENTATION;
  }
  const contexts = value.contexts.map(parseSummary);
  if (contexts.some((context) => context === null)) return EMPTY_CONTEXT_PRESENTATION;
  const summaries = contexts as ContextSummary[];
  if (new Set(summaries.map((context) => context.contextId)).size !== summaries.length) {
    return EMPTY_CONTEXT_PRESENTATION;
  }
  const selectedContextId = value.selectedContextId === null || isIdentifier(value.selectedContextId)
    ? value.selectedContextId
    : null;
  const suggestedContextId = value.suggestedContextId === null || isIdentifier(value.suggestedContextId)
    ? value.suggestedContextId
    : null;
  if (value.selected === null) {
    return { contexts: summaries, selectedContextId, suggestedContextId, selected: null };
  }
  if (!isRecord(value.selected)) return EMPTY_CONTEXT_PRESENTATION;
  const summary = parseSummary(value.selected.summary);
  if (
    !summary
    || summary.contextId !== selectedContextId
    || !Array.isArray(value.selected.events)
    || value.selected.events.length > MAX_PROJECTED_EVENTS
    || !isCursor(value.selected.lastSequence)
    || ![null, "completed", "canceled", "failed"].includes(value.selected.completionStatus as never)
    || !(value.selected.historyBefore === null || isCursor(value.selected.historyBefore))
    || typeof value.selected.hasMoreHistory !== "boolean"
  ) return EMPTY_CONTEXT_PRESENTATION;
  const events = value.selected.events.map((event) => parseEvent(event, summary.contextId));
  if (events.some((event) => event === null)) return EMPTY_CONTEXT_PRESENTATION;
  const queue = value.selected.messageQueue ?? [];
  if (!Array.isArray(queue) || queue.length > 32 || queue.some((item) => !isRecord(item) || !isIdentifier(item.id)
    || typeof item.text !== "string" || [...item.text].length > 100 || utf8ByteLength(item.text) > 400)
    || new Set(queue.map((item) => item.id)).size !== queue.length) return EMPTY_CONTEXT_PRESENTATION;
  const approvals = value.selected.approvals ?? [];
  if (!Array.isArray(approvals) || approvals.length > 32) return EMPTY_CONTEXT_PRESENTATION;
  for (const approval of approvals) {
    if (!isRecord(approval) || approval.contextId !== summary.contextId || !isIdentifier(approval.challengeId)
      || !["site", "action"].includes(String(approval.kind)) || typeof approval.summary !== "string"
      || utf8ByteLength(approval.summary) > 256 || typeof approval.origin !== "string" || approval.origin.length > 512
      || !isCursor(approval.expiresAtMs) || !Array.isArray(approval.options)) return EMPTY_CONTEXT_PRESENTATION;
    const options = approval.kind === "site" ? ["deny", "allow_once", "allow_turn"] : ["decline", "approve_once"];
    if (JSON.stringify(approval.options) !== JSON.stringify(options)) return EMPTY_CONTEXT_PRESENTATION;
    try {
      const origin = new URL(approval.origin);
      if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== approval.origin) return EMPTY_CONTEXT_PRESENTATION;
    } catch { return EMPTY_CONTEXT_PRESENTATION; }
  }
  return {
    contexts: summaries,
    selectedContextId,
    suggestedContextId,
    draft: typeof value.draft === "string" && utf8ByteLength(value.draft) <= MAX_CONTEXT_MESSAGE_TEXT_BYTES ? value.draft : "",
    selected: {
      summary,
      events: events as ContextEvent[],
      lastSequence: value.selected.lastSequence,
      completionStatus: value.selected.completionStatus as ContextProjection["completionStatus"],
      historyBefore: value.selected.historyBefore,
      hasMoreHistory: value.selected.hasMoreHistory,
      messageQueue: queue.map((item) => ({ id: item.id, text: item.text })),
      approvals: approvals.map((item) => ({ contextId: item.contextId, challengeId: item.challengeId, kind: item.kind,
        origin: item.origin, summary: item.summary, expiresAtMs: item.expiresAtMs, options: [...item.options] })),
    },
  };
}
