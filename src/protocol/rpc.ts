export const BRIDGE_PROTOCOL = "a0.browser-bridge.v1" as const;
export const BRIDGE_CONTRACT_VERSION = 1 as const;
export const MAX_NATIVE_MESSAGE_BYTES = 768 * 1024;
export const MAX_NON_ARTIFACT_BYTES = 512 * 1024;
export const MAX_DIAGNOSTIC_LENGTH = 2_048;

export const NATIVE_METHODS = [
  "bridge.hello",
  "bridge.ping",
  "pairing.status",
  "pairing.exchange",
  "pairing.disconnect",
  "credential.rotate",
  "credential.status",
  "credential.revoke",
  "credential.changed",
  "agent.status",
  "context.list",
  "context.subscribe",
  "context.unsubscribe",
  "context.send_message",
  "context.queue_add",
  "context.queue_remove",
  "context.queue_send",
  "context.queue_updated",
  "browser.approval_decision",
  "context.snapshot",
  "context.event",
  "context.complete",
  "browser.perform",
  "browser.cancel",
  "browser.finalize_turn",
  "browser.resolve_challenge",
  "browser.reconcile",
  "browser.event",
  "browser.ack_events",
  "artifact.begin",
  "artifact.chunk",
  "artifact.end",
  "artifact.abort",
  "artifact.input_path",
] as const;

export type NativeMethod = (typeof NATIVE_METHODS)[number];

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string;
  method: NativeMethod;
  params: Record<string, unknown>;
}

export interface RpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: Record<string, unknown>;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcResponse;

export type RpcValidationReason =
  | "MESSAGE_NOT_OBJECT"
  | "MESSAGE_TOO_LARGE"
  | "MESSAGE_NOT_SERIALIZABLE"
  | "INVALID_JSONRPC"
  | "INVALID_ID"
  | "UNKNOWN_METHOD"
  | "INVALID_PARAMS"
  | "INVALID_RESPONSE";

export class RpcValidationError extends Error {
  constructor(public readonly reasonCode: RpcValidationReason) {
    super(reasonCode);
    this.name = "RpcValidationError";
  }
}

const methods = new Set<string>(NATIVE_METHODS);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
};

export const encodedSize = (value: unknown): number => {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new RpcValidationError("MESSAGE_NOT_SERIALIZABLE");
  }
  if (typeof encoded !== "string") throw new RpcValidationError("MESSAGE_NOT_SERIALIZABLE");
  return new TextEncoder().encode(encoded).byteLength;
};

export const validOpaqueId = (value: unknown, maxLength = 256): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);

export function parseRpcMessage(value: unknown): RpcMessage {
  if (!isRecord(value)) throw new RpcValidationError("MESSAGE_NOT_OBJECT");
  if (encodedSize(value) > MAX_NATIVE_MESSAGE_BYTES) throw new RpcValidationError("MESSAGE_TOO_LARGE");
  if (value.jsonrpc !== "2.0") throw new RpcValidationError("INVALID_JSONRPC");

  if ("method" in value) {
    if (
      !Object.hasOwn(value, "params")
      || Object.hasOwn(value, "result")
      || Object.hasOwn(value, "error")
    ) throw new RpcValidationError("INVALID_PARAMS");
    if (typeof value.method !== "string" || !methods.has(value.method)) {
      throw new RpcValidationError("UNKNOWN_METHOD");
    }
    if ("id" in value && !validOpaqueId(value.id)) throw new RpcValidationError("INVALID_ID");
    if (!isRecord(value.params) || encodedSize(value.params) > MAX_NON_ARTIFACT_BYTES) {
      throw new RpcValidationError("INVALID_PARAMS");
    }
    return {
      jsonrpc: "2.0",
      ...(validOpaqueId(value.id) ? { id: value.id } : {}),
      method: value.method as NativeMethod,
      params: value.params,
    };
  }

  if (
    !Object.hasOwn(value, "id")
    || Object.hasOwn(value, "params")
  ) throw new RpcValidationError("INVALID_RESPONSE");
  if (!validOpaqueId(value.id)) throw new RpcValidationError("INVALID_ID");
  const hasResult = isRecord(value.result);
  const hasError = isRecord(value.error);
  if (hasResult === hasError) throw new RpcValidationError("INVALID_RESPONSE");
  if (encodedSize(value) > MAX_NON_ARTIFACT_BYTES) throw new RpcValidationError("INVALID_RESPONSE");
  if (hasResult) return { jsonrpc: "2.0", id: value.id, result: value.result as Record<string, unknown> };

  const error = value.error as Record<string, unknown>;
  if (
    !Object.hasOwn(error, "code") ||
    !Object.hasOwn(error, "message") ||
    !Number.isInteger(error.code) ||
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    error.message.length > MAX_DIAGNOSTIC_LENGTH ||
    ("data" in error && !isRecord(error.data))
  ) {
    throw new RpcValidationError("INVALID_RESPONSE");
  }
  return {
    jsonrpc: "2.0",
    id: value.id,
    error: {
      code: error.code as number,
      message: error.message,
      ...(isRecord(error.data) ? { data: error.data } : {}),
    },
  };
}

export function rpcRequest(id: string, method: NativeMethod, params: Record<string, unknown>): RpcRequest {
  if (!validOpaqueId(id) || !methods.has(method) || !isRecord(params) || encodedSize(params) > MAX_NON_ARTIFACT_BYTES) {
    throw new RpcValidationError("INVALID_PARAMS");
  }
  const request: RpcRequest = { jsonrpc: "2.0", id, method, params };
  if (encodedSize(request) > MAX_NATIVE_MESSAGE_BYTES) throw new RpcValidationError("MESSAGE_TOO_LARGE");
  return request;
}

export function rpcNotification(method: NativeMethod, params: Record<string, unknown>): RpcRequest {
  if (!methods.has(method) || !isRecord(params) || encodedSize(params) > MAX_NON_ARTIFACT_BYTES) {
    throw new RpcValidationError("INVALID_PARAMS");
  }
  const notification: RpcRequest = { jsonrpc: "2.0", method, params };
  if (encodedSize(notification) > MAX_NATIVE_MESSAGE_BYTES) throw new RpcValidationError("MESSAGE_TOO_LARGE");
  return notification;
}

export function rpcResult(id: string, result: Record<string, unknown>): RpcResponse {
  if (!validOpaqueId(id) || !isRecord(result)) throw new RpcValidationError("INVALID_RESPONSE");
  const response: RpcResponse = { jsonrpc: "2.0", id, result };
  if (encodedSize(response) > MAX_NON_ARTIFACT_BYTES) throw new RpcValidationError("MESSAGE_TOO_LARGE");
  if (encodedSize(response) > MAX_NATIVE_MESSAGE_BYTES) throw new RpcValidationError("MESSAGE_TOO_LARGE");
  return response;
}

export function rpcError(
  id: string,
  code: number,
  message: string,
  data: Record<string, unknown> = {},
): RpcResponse {
  if (
    !validOpaqueId(id) ||
    !Number.isInteger(code) ||
    !message ||
    message.length > 512 ||
    !isRecord(data)
  ) {
    throw new RpcValidationError("INVALID_RESPONSE");
  }
  const response: RpcResponse = { jsonrpc: "2.0", id, error: { code, message, data } };
  if (encodedSize(response) > MAX_NON_ARTIFACT_BYTES) throw new RpcValidationError("MESSAGE_TOO_LARGE");
  if (encodedSize(response) > MAX_NATIVE_MESSAGE_BYTES) throw new RpcValidationError("MESSAGE_TOO_LARGE");
  return response;
}
