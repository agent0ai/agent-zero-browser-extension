export const CONTENT_CONTRACT = "a0.browser-bridge.content.v1" as const;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_DEADLINE_SKEW_MS = 10 * 60 * 1000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type ContentBinding = {
  load_generation_id: string;
  lease_id: string;
  tab_handle: string;
  document_id: string;
  document_epoch: string;
};

export type ContentBindEnvelope = {
  contract: typeof CONTENT_CONTRACT;
  kind: "content.bind";
  binding: ContentBinding;
  deadline_ms: number;
};

export type ContentCommand =
  | { name: "semantics.inspect"; max_nodes?: number; max_text_chars?: number }
  | { name: "page.scroll_to_ref"; element_ref: string; show_cursor?: boolean }
  | { name: "target.prepare_hover"; element_ref: string }
  | { name: "target.prepare_click"; element_ref: string }
  | { name: "target.prepare_upload"; element_ref: string }
  | { name: "target.revalidate_upload"; element_ref: string; target_fingerprint: string }
  | { name: "target.revalidate_click"; element_ref: string; target_fingerprint: string }
  | { name: "target.prepare_type"; element_ref: string; has_line_feed: boolean }
  | { name: "target.revalidate_type"; element_ref: string; target_fingerprint: string; has_line_feed: boolean }
  | { name: "target.confirm_type_focus"; element_ref: string; target_fingerprint: string; has_line_feed: boolean }
  | {
      name: "target.verify_type_value";
      element_ref: string;
      target_fingerprint: string;
      text_sha256: string;
      has_line_feed: boolean;
    }
  | { name: "cursor.move_to_point"; x: number; y: number; show_label?: boolean }
  | { name: "cursor.move_to_ref"; element_ref: string; show_label?: boolean }
  | { name: "cursor.activate" }
  | { name: "cursor.freeze" }
  | {
      name: "cursor.cancel";
      reason: "approval" | "cancel" | "disconnect" | "pause" | "takeover";
    }
  | {
      name: "runtime.release";
      reason: "complete" | "detach" | "finalize" | "lease_lost" | "navigation" | "takeover";
    };

export type ContentCommandEnvelope = ContentBinding & {
  contract: typeof CONTENT_CONTRACT;
  kind: "content.command";
  command_id: string;
  operation_id: string;
  action_id: string;
  deadline_ms: number;
  command: ContentCommand;
};

export type ContentEnvelope = ContentBindEnvelope | ContentCommandEnvelope;

export type ContentErrorCode =
  | "CONTENT_RUNTIME_ERROR"
  | "CURSOR_INTERRUPTED"
  | "DEADLINE_EXCEEDED"
  | "INVALID_ENVELOPE"
  | "RELEASED"
  | "STALE_BINDING"
  | "STALE_ELEMENT_REFERENCE"
  | "TARGET_NOT_VISIBLE"
  | "TARGET_UNSUPPORTED"
  | "TARGET_CHANGED"
  | "UNBOUND"
  | "UNTRUSTED_SENDER";

export type ContentResponse = ContentBinding & {
  contract: typeof CONTENT_CONTRACT;
  kind: "content.response";
  command_id: string;
  operation_id: string;
  action_id: string;
  ok: boolean;
  result?:
    | {
        state: "activated" | "arrived" | "cancelled" | "frozen" | "hover_ready" | "released" | "scrolled";
        x?: number;
        y?: number;
      }
    | {
        state: "click_ready";
        x: number;
        y: number;
        action_class: "reversible_input" | "sensitive_input" | "external_side_effect" | "unknown";
        target_fingerprint: string;
      }
    | {
        state: "type_ready";
        x: number;
        y: number;
        action_class: "sensitive_input";
        target_fingerprint: string;
      }
    | { state: "type_focus_ready" | "type_verified" }
    | {
        state: "inspected";
        snapshot: {
          title: string;
          text: string;
          nodes: Array<{ ref: string; role: string; name: string }>;
          truncated: boolean;
        };
      };
  error?: {
    code: ContentErrorCode;
    message: string;
    outcome: "not_applied";
  };
};

export type ContentBindResponse = {
  contract: typeof CONTENT_CONTRACT;
  kind: "content.bound";
  ok: boolean;
  binding?: ContentBinding;
  error?: {
    code: ContentErrorCode;
    message: string;
    outcome: "not_applied";
  };
};

export type ContentRejectedResponse = {
  contract: typeof CONTENT_CONTRACT;
  kind: "content.rejected";
  ok: false;
  error: {
    code: ContentErrorCode;
    message: string;
    outcome: "not_applied";
  };
};

export type CursorArrivedEvent = ContentBinding & {
  contract: typeof CONTENT_CONTRACT;
  kind: "cursor.arrived";
  command_id: string;
  operation_id: string;
  action_id: string;
  x: number;
  y: number;
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_IDENTIFIER_LENGTH &&
  IDENTIFIER_PATTERN.test(value);

const isDeadline = (value: unknown, nowMs: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= nowMs + MAX_DEADLINE_SKEW_MS;

const isCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000;

const isBoundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;

const BINDING_KEYS = [
  "load_generation_id",
  "lease_id",
  "tab_handle",
  "document_id",
  "document_epoch",
] as const;

export const isContentBinding = (value: unknown): value is ContentBinding => {
  if (!isRecord(value) || !hasExactKeys(value, BINDING_KEYS)) return false;
  return BINDING_KEYS.every((key) => isIdentifier(value[key]));
};

const isContentCommand = (value: unknown): value is ContentCommand => {
  if (!isRecord(value) || typeof value.name !== "string") return false;

  switch (value.name) {
    case "semantics.inspect":
      return (
        hasExactKeys(value, ["name"], ["max_nodes", "max_text_chars"])
        && (value.max_nodes === undefined || isBoundedInteger(value.max_nodes, 128))
        && (value.max_text_chars === undefined || isBoundedInteger(value.max_text_chars, 24_000))
      );
    case "page.scroll_to_ref":
      return (
        hasExactKeys(value, ["name", "element_ref"], ["show_cursor"])
        && isIdentifier(value.element_ref)
        && (value.show_cursor === undefined || typeof value.show_cursor === "boolean")
      );
    case "target.prepare_hover":
      return hasExactKeys(value, ["name", "element_ref"]) && isIdentifier(value.element_ref);
    case "target.prepare_click":
    case "target.prepare_upload":
      return hasExactKeys(value, ["name", "element_ref"]) && isIdentifier(value.element_ref);
    case "target.revalidate_click":
    case "target.revalidate_upload":
      return (
        hasExactKeys(value, ["name", "element_ref", "target_fingerprint"])
        && isIdentifier(value.element_ref)
        && typeof value.target_fingerprint === "string"
        && /^[0-9a-f]{64}$/u.test(value.target_fingerprint)
      );
    case "target.prepare_type":
      return (
        hasExactKeys(value, ["name", "element_ref", "has_line_feed"])
        && isIdentifier(value.element_ref)
        && typeof value.has_line_feed === "boolean"
      );
    case "target.revalidate_type":
    case "target.confirm_type_focus":
      return (
        hasExactKeys(value, ["name", "element_ref", "target_fingerprint", "has_line_feed"])
        && isIdentifier(value.element_ref)
        && typeof value.target_fingerprint === "string"
        && /^[0-9a-f]{64}$/u.test(value.target_fingerprint)
        && typeof value.has_line_feed === "boolean"
      );
    case "target.verify_type_value":
      return (
        hasExactKeys(value, ["name", "element_ref", "target_fingerprint", "text_sha256", "has_line_feed"])
        && isIdentifier(value.element_ref)
        && typeof value.target_fingerprint === "string"
        && /^[0-9a-f]{64}$/u.test(value.target_fingerprint)
        && typeof value.text_sha256 === "string"
        && /^[0-9a-f]{64}$/u.test(value.text_sha256)
        && typeof value.has_line_feed === "boolean"
      );
    case "cursor.move_to_point":
      return (
        hasExactKeys(value, ["name", "x", "y"], ["show_label"]) &&
        isCoordinate(value.x) &&
        isCoordinate(value.y) &&
        (value.show_label === undefined || typeof value.show_label === "boolean")
      );
    case "cursor.move_to_ref":
      return (
        hasExactKeys(value, ["name", "element_ref"], ["show_label"]) &&
        isIdentifier(value.element_ref) &&
        (value.show_label === undefined || typeof value.show_label === "boolean")
      );
    case "cursor.activate":
    case "cursor.freeze":
      return hasExactKeys(value, ["name"]);
    case "cursor.cancel":
      return (
        hasExactKeys(value, ["name", "reason"]) &&
        ["approval", "cancel", "disconnect", "pause", "takeover"].includes(String(value.reason))
      );
    case "runtime.release":
      return (
        hasExactKeys(value, ["name", "reason"]) &&
        ["complete", "detach", "finalize", "lease_lost", "navigation", "takeover"].includes(
          String(value.reason),
        )
      );
    default:
      return false;
  }
};

export const parseContentEnvelope = (
  value: unknown,
  nowMs: number,
):
  | { ok: true; envelope: ContentEnvelope }
  | { ok: false; code: "INVALID_ENVELOPE" | "DEADLINE_EXCEEDED"; envelope?: ContentEnvelope } => {
  if (!isRecord(value) || value.contract !== CONTENT_CONTRACT) return { ok: false, code: "INVALID_ENVELOPE" };

  if (value.kind === "content.bind") {
    if (!hasExactKeys(value, ["contract", "kind", "binding", "deadline_ms"])) {
      return { ok: false, code: "INVALID_ENVELOPE" };
    }
    if (!isContentBinding(value.binding) || !isDeadline(value.deadline_ms, nowMs)) {
      return { ok: false, code: "INVALID_ENVELOPE" };
    }
    if (value.deadline_ms < nowMs) {
      return { ok: false, code: "DEADLINE_EXCEEDED", envelope: value as ContentBindEnvelope };
    }
    return { ok: true, envelope: value as ContentBindEnvelope };
  }

  if (value.kind !== "content.command") return { ok: false, code: "INVALID_ENVELOPE" };

  const commandKeys = [
    "contract",
    "kind",
    ...BINDING_KEYS,
    "command_id",
    "operation_id",
    "action_id",
    "deadline_ms",
    "command",
  ] as const;
  if (!hasExactKeys(value, commandKeys)) return { ok: false, code: "INVALID_ENVELOPE" };

  const binding = Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]]));
  if (
    !isContentBinding(binding) ||
    !isIdentifier(value.command_id) ||
    !isIdentifier(value.operation_id) ||
    !isIdentifier(value.action_id) ||
    !isDeadline(value.deadline_ms, nowMs) ||
    !isContentCommand(value.command)
  ) {
    return { ok: false, code: "INVALID_ENVELOPE" };
  }
  if (value.deadline_ms < nowMs) {
    return { ok: false, code: "DEADLINE_EXCEEDED", envelope: value as ContentCommandEnvelope };
  }
  return { ok: true, envelope: value as ContentCommandEnvelope };
};

export const bindingsEqual = (left: ContentBinding, right: ContentBinding): boolean =>
  BINDING_KEYS.every((key) => left[key] === right[key]);

export const isTrustedWorkerSender = (
  sender: Pick<chrome.runtime.MessageSender, "documentId" | "frameId" | "id" | "origin" | "tab" | "url">,
  extensionId: string,
  extensionOrigin: string,
): boolean => {
  if (
    !extensionId ||
    sender.id !== extensionId ||
    sender.tab !== undefined ||
    sender.documentId !== undefined ||
    sender.frameId !== undefined
  ) {
    return false;
  }
  if (sender.origin !== undefined && sender.origin !== extensionOrigin) return false;
  if (sender.url !== undefined) {
    try {
      const actual = new URL(sender.url);
      const expected = new URL(`${extensionOrigin}/`);
      return actual.protocol === expected.protocol && actual.host === expected.host;
    } catch {
      return false;
    }
  }
  return true;
};

export const bindingFromCommand = (envelope: ContentCommandEnvelope): ContentBinding => ({
  load_generation_id: envelope.load_generation_id,
  lease_id: envelope.lease_id,
  tab_handle: envelope.tab_handle,
  document_id: envelope.document_id,
  document_epoch: envelope.document_epoch,
});
