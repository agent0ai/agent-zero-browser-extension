import { BRIDGE_CONTRACT_VERSION } from "../protocol/rpc";

export const BROWSER_ACTIONS = [
  "open",
  "list",
  "state",
  "set_active",
  "navigate",
  "back",
  "forward",
  "reload",
  "content",
  "detail",
  "evaluate",
  "click",
  "type",
  "submit",
  "type_submit",
  "scroll",
  "hover",
  "double_click",
  "right_click",
  "drag",
  "wheel",
  "mouse",
  "keyboard",
  "key_chord",
  "clipboard",
  "set_viewport",
  "select_option",
  "set_checked",
  "upload_file",
  "screenshot",
  "close",
  "close_all",
  "multi",
  "ensure",
  "status",
  "claim",
] as const;

export const IMPLEMENTED_BASELINE_ACTIONS = [
  "open",
  "list",
  "state",
  "set_active",
  "navigate",
  "back",
  "forward",
  "reload",
  "close",
  "close_all",
  "ensure",
  "status",
] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
export type ImplementedBaselineAction = (typeof IMPLEMENTED_BASELINE_ACTIONS)[number];

interface BrowserPerformRequestBase {
  contractVersion: typeof BRIDGE_CONTRACT_VERSION;
  target: { tabHandle: string } | null;
  args: Record<string, unknown>;
  timeoutMs: number;
  requiredCapabilities: string[];
  policy: {
    originGrantId: string | null;
    actionGrantId: string | null;
  };
  display: {
    cursor: boolean;
    foreground: boolean;
  };
  receivedAtMs: number;
  deadlineAtMs: number;
}

export type ConnectionBrowserAction = "status" | "ensure";
export type ScopedBrowserAction = Exclude<BrowserAction, ConnectionBrowserAction>;

export type ConnectionBrowserPerformRequest = BrowserPerformRequestBase & {
  action: ConnectionBrowserAction;
  opId: string | null;
  actionId: string | null;
  contextId: string | null;
  browserSessionId: string | null;
  turnId: string | null;
};

export type ScopedBrowserPerformRequest = BrowserPerformRequestBase & {
  action: ScopedBrowserAction;
  opId: string;
  actionId: string;
  contextId: string;
  browserSessionId: string;
  turnId: string;
};

export type BrowserPerformRequest = ConnectionBrowserPerformRequest | ScopedBrowserPerformRequest;

export interface BrowserFinalizeRequest {
  contractVersion: typeof BRIDGE_CONTRACT_VERSION;
  controlId: string;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  dispositions: Record<string, "ephemeral" | "deliverable" | "handoff">;
  reason: string;
}

export interface BrowserCancelRequest {
  contractVersion: typeof BRIDGE_CONTRACT_VERSION;
  controlId: string;
  opId: string;
  actionId: string;
  contextId: string;
  browserSessionId: string;
  turnId: string;
  reason: string;
}

export class OperationValidationError extends Error {
  constructor(public readonly field: string, message = `Invalid ${field}.`) {
    super(message);
  }
}

const actions = new Set<string>(BROWSER_ACTIONS);
const dispositions = new Set(["ephemeral", "deliverable", "handoff"]);

const CANCEL_REQUEST_KEYS = new Set([
  "contract_version",
  "control_id",
  "op_id",
  "action_id",
  "context_id",
  "browser_session_id",
  "turn_id",
  "reason",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedId = (value: unknown, field: string): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OperationValidationError(field);
  }
  return value;
};

const optionalBoundedId = (value: unknown, field: string): string | null =>
  value === null || value === undefined ? null : boundedId(value, field);

const booleanOr = (value: unknown, fallback: boolean, field: string): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new OperationValidationError(field);
  return value;
};

const contractVersion = (value: unknown): typeof BRIDGE_CONTRACT_VERSION => {
  if (value !== BRIDGE_CONTRACT_VERSION) {
    throw new OperationValidationError("contract_version", "Unsupported browser bridge contract.");
  }
  return BRIDGE_CONTRACT_VERSION;
};

export function parseBrowserPerformRequest(
  value: unknown,
  receivedAtMs = Date.now(),
): BrowserPerformRequest {
  if (!isRecord(value)) throw new OperationValidationError("params");
  const action = value.action;
  if (typeof action !== "string" || !actions.has(action)) {
    throw new OperationValidationError("action", "Unknown browser action.");
  }
  if (!isRecord(value.args)) throw new OperationValidationError("args");

  const targetValue = value.target;
  let target: BrowserPerformRequest["target"] = null;
  if (targetValue !== undefined && targetValue !== null) {
    if (!isRecord(targetValue)) throw new OperationValidationError("target");
    target = { tabHandle: boundedId(targetValue.tab_handle, "target.tab_handle") };
  }

  if (!Number.isInteger(value.timeout_ms) || Number(value.timeout_ms) < 1 || Number(value.timeout_ms) > 120_000) {
    throw new OperationValidationError("timeout_ms");
  }
  if (
    !Array.isArray(value.required_capabilities)
    || value.required_capabilities.length > 64
    || value.required_capabilities.some((item) => typeof item !== "string" || !item || item.length > 128)
  ) {
    throw new OperationValidationError("required_capabilities");
  }

  const policyValue = value.policy === undefined ? {} : value.policy;
  const displayValue = value.display === undefined ? {} : value.display;
  if (!isRecord(policyValue)) throw new OperationValidationError("policy");
  if (!isRecord(displayValue)) throw new OperationValidationError("display");

  const timeoutMs = Number(value.timeout_ms);
  const common: BrowserPerformRequestBase = {
    contractVersion: contractVersion(value.contract_version),
    target,
    args: value.args,
    timeoutMs,
    requiredCapabilities: [...value.required_capabilities] as string[],
    policy: {
      originGrantId: optionalBoundedId(policyValue.origin_grant_id, "policy.origin_grant_id"),
      actionGrantId: optionalBoundedId(policyValue.action_grant_id, "policy.action_grant_id"),
    },
    display: {
      cursor: booleanOr(displayValue.cursor, false, "display.cursor"),
      foreground: booleanOr(displayValue.foreground, false, "display.foreground"),
    },
    receivedAtMs,
    deadlineAtMs: receivedAtMs + timeoutMs,
  };
  if (action === "status" || action === "ensure") {
    return {
      ...common,
      action,
      opId: optionalBoundedId(value.op_id, "op_id"),
      actionId: optionalBoundedId(value.action_id, "action_id"),
      contextId: optionalBoundedId(value.context_id, "context_id"),
      browserSessionId: optionalBoundedId(value.browser_session_id, "browser_session_id"),
      turnId: optionalBoundedId(value.turn_id, "turn_id"),
    };
  }
  return {
    ...common,
    action: action as ScopedBrowserAction,
    opId: boundedId(value.op_id, "op_id"),
    actionId: boundedId(value.action_id, "action_id"),
    contextId: boundedId(value.context_id, "context_id"),
    browserSessionId: boundedId(value.browser_session_id, "browser_session_id"),
    turnId: boundedId(value.turn_id, "turn_id"),
  };
}

export function parseBrowserFinalizeRequest(value: unknown): BrowserFinalizeRequest {
  if (!isRecord(value)) throw new OperationValidationError("params");
  if (!isRecord(value.dispositions)) throw new OperationValidationError("dispositions");
  const normalizedDispositions: BrowserFinalizeRequest["dispositions"] = {};
  if (Object.keys(value.dispositions).length > 256) {
    throw new OperationValidationError("dispositions");
  }
  for (const [leaseId, disposition] of Object.entries(value.dispositions)) {
    boundedId(leaseId, "dispositions.lease_id");
    if (typeof disposition !== "string" || !dispositions.has(disposition)) {
      throw new OperationValidationError("dispositions.value");
    }
    normalizedDispositions[leaseId] = disposition as BrowserFinalizeRequest["dispositions"][string];
  }
  return {
    contractVersion: contractVersion(value.contract_version),
    controlId: boundedId(value.control_id, "control_id"),
    contextId: boundedId(value.context_id, "context_id"),
    browserSessionId: boundedId(value.browser_session_id, "browser_session_id"),
    turnId: boundedId(value.turn_id, "turn_id"),
    dispositions: normalizedDispositions,
    reason: boundedId(value.reason, "reason"),
  };
}

export function parseBrowserCancelRequest(value: unknown): BrowserCancelRequest {
  if (!isRecord(value)) throw new OperationValidationError("params");
  if (Object.keys(value).some((key) => !CANCEL_REQUEST_KEYS.has(key))) {
    throw new OperationValidationError("params", "Unknown browser cancellation field.");
  }
  return {
    contractVersion: contractVersion(value.contract_version),
    controlId: boundedId(value.control_id, "control_id"),
    opId: boundedId(value.op_id, "op_id"),
    actionId: boundedId(value.action_id, "action_id"),
    contextId: boundedId(value.context_id, "context_id"),
    browserSessionId: boundedId(value.browser_session_id, "browser_session_id"),
    turnId: boundedId(value.turn_id, "turn_id"),
    reason: boundedId(value.reason, "reason"),
  };
}

export function assertBeforeDeadline(request: Pick<BrowserPerformRequest, "deadlineAtMs">, nowMs = Date.now()): void {
  if (nowMs >= request.deadlineAtMs) {
    throw new OperationValidationError("timeout_ms", "The browser operation deadline expired.");
  }
}
