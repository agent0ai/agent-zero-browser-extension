import { BUILD_CHANNEL } from "../build-channel";
import {
  buildHelloParams,
  buildPairingExchangeParams,
  buildPairingStatusParams,
  evaluateActivation,
  evaluateDevelopmentAdmission,
  isPrivilegedBrowserMethod,
  parseAgentStatusResult,
  parseHelloResult,
  parseInboundParams,
  parseOutboundResult,
  parsePairingExchangeResult,
  parsePairingStatusResult,
  type AgentStatusResult,
  type HelloBuildInput,
  type LocalActivationEvidence,
  type PairingExchangeResult,
  type PairingStatusResult,
} from "../protocol/native";
import {
  developmentAdmissionIdentity, exactCapabilities, LIMITED_BROWSER_ACTIONS, LIMITED_BROWSER_FEATURES,
  LIMITED_BROWSER_METHODS, type DevelopmentAdmission,
} from "../protocol/development-admission";
import {
  buildContextListParams,
  buildContextSendMessageParams,
  buildContextSubscribeParams,
  buildContextUnsubscribeParams,
  parseContextListResult,
  parseContextSendMessageResult,
  parseContextSubscribeResult,
  parseContextUnsubscribeResult,
  type ContextSendMessageResult,
  type ContextSubscribeInput,
  type ContextSubscribeResult,
  type ContextSummary,
} from "../protocol/context";
import { buildBrowserEventParams, type CriticalBrowserEventRecord } from "../protocol/browser-events";
import {
  buildArtifactAbortParams,
  buildArtifactBeginParams,
  buildArtifactChunkParams,
  buildArtifactEndParams,
  parseArtifactAck,
  type ArtifactAbortReason,
  type ArtifactAck,
  type OutputArtifactBinding,
} from "../protocol/artifacts";
import {
  MAX_NATIVE_MESSAGE_BYTES,
  RpcValidationError,
  type NativeMethod,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  encodedSize,
  hasExactKeys,
  isRecord,
  parseRpcMessage,
  rpcError,
  rpcNotification,
  rpcRequest,
  rpcResult,
  validOpaqueId,
} from "../protocol/rpc";

export const NATIVE_HOST_NAME = BUILD_CHANNEL.nativeHostName;
export const HELLO_TIMEOUT_MS = 10_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_SETTLED_TOMBSTONES = 256;

export type NativeConnectionState = "disconnected" | "connecting" | "negotiating" | "ready" | "blocked";

export interface NativeConnectionSnapshot {
  state: NativeConnectionState;
  reasonCode: string;
  connectionId?: string;
  companionVersion?: string;
  serverState?: string;
  reportedServerState?: string;
  activationReady?: boolean;
  activationBlockers?: string[];
  negotiatedActions?: string[];
  negotiatedFeatures?: string[];
  limitedTransportReady?: boolean;
  developmentAdmission?: DevelopmentAdmission;
}

export function browserConnectionAuthorityKey(
  connection: NativeConnectionSnapshot,
  expected?: { installInstanceId: string; loadGenerationId: string },
): string | null {
  if (connection.state !== "ready" || !connection.connectionId) return null;
  if (!BUILD_CHANNEL.development) return connection.activationReady === true
    && !connection.developmentAdmission && connection.limitedTransportReady !== true ? "production" : null;
  if (connection.activationReady !== false || connection.limitedTransportReady !== true
    || connection.reportedServerState !== "paired"
    || !exactCapabilities(connection.negotiatedActions, LIMITED_BROWSER_ACTIONS)
    || !exactCapabilities(connection.negotiatedFeatures, LIMITED_BROWSER_FEATURES)) return null;
  return developmentAdmissionIdentity(connection.developmentAdmission, expected);
}

export function canReconnectDevelopmentBrowser(connection: NativeConnectionSnapshot): boolean {
  return BUILD_CHANNEL.development && connection.state === "ready" && !!connection.connectionId
    && connection.reportedServerState === "paired" && connection.activationReady === false
    && connection.limitedTransportReady !== true;
}

export interface NativeHelloContext {
  installInstanceId: string;
  loadGenerationId: string;
  workerBootId: string;
  leaseDigest: string;
  inflightOpIds: string[];
  lastAckedEventSequence: number;
  eventCursors?: { loadGenerationId: string; lastAckedEventSequence: number }[];
  browserFamily: HelloBuildInput["browserFamily"];
  browserVersion: string;
  actions: string[];
  features: string[];
  activationEvidence?: LocalActivationEvidence;
}

export type NativeRequestHandler = (
  method: RpcRequest["method"],
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface NativeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class NativeRequestError extends Error {
  constructor(
    message: string,
    public readonly a0Code: string,
    public readonly outcome: "not_applied" | "applied" | "unknown" = "not_applied",
    public readonly retryable = false,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "NativeRequestError";
  }
}

export class NativeRpcError extends Error {
  constructor(
    public readonly method: NativeMethod,
    public readonly a0Code: string,
    public readonly outcome: "not_applied" | "applied" | "unknown",
    public readonly retryable: boolean,
  ) {
    super(`Native request ${method} failed.`);
    this.name = "NativeRpcError";
  }
}

export class NativeRequestTimeoutError extends Error {
  constructor(public readonly method: NativeMethod) {
    super(`Native request ${method} exceeded its deadline.`);
    this.name = "NativeRequestTimeoutError";
  }
}

export class NativeRequestCancelledError extends Error {
  constructor(public readonly method: NativeMethod) {
    super(`Native request ${method} was cancelled.`);
    this.name = "NativeRequestCancelledError";
  }
}

export class NativeConnectionError extends Error {
  constructor(public readonly reasonCode: string) {
    super("The native browser companion connection is unavailable.");
    this.name = "NativeConnectionError";
  }
}

interface NativePortDependencies {
  connectNative: (hostName: string) => chrome.runtime.Port;
  extensionId: string;
  extensionVersion: string;
  onState: (snapshot: NativeConnectionSnapshot) => void;
  onRequest: NativeRequestHandler;
  // Synchronous worker hook; only after a validated correlated result has been
  // posted on the original, still-current port. It must not yield or grant UI authority.
  onResponsePosted: (method: NativeMethod, connection: NativeConnectionSnapshot) => void;
  setTimer: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  createRequestId: () => string;
  now: () => number;
}

type PendingRequest = {
  id: string;
  method: NativeMethod;
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  parseResult: (value: unknown) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

const INBOUND_METHODS = new Set<NativeMethod>([
  "bridge.ping",
  "context.snapshot",
  "context.event",
  "context.complete",
  "browser.perform",
  "browser.cancel",
  "browser.finalize_turn",
  "browser.resolve_challenge",
  "browser.reconcile",
  "browser.ack_events",
  "artifact.abort",
]);

const CLIENT_METHODS = new Set<NativeMethod>([
  "pairing.status",
  "pairing.exchange",
  "pairing.disconnect",
  "agent.status",
  "context.list",
  "context.subscribe",
  "context.unsubscribe",
  "context.send_message",
  "artifact.begin",
  "artifact.chunk",
  "artifact.end",
  "artifact.abort",
]);

const CONTEXT_CLIENT_METHODS = new Set<NativeMethod>([
  "context.list",
  "context.subscribe",
  "context.unsubscribe",
  "context.send_message",
]);

const ACTIVATED_CLIENT_METHODS = new Set<NativeMethod>([
  ...CONTEXT_CLIENT_METHODS,
  "artifact.begin",
  "artifact.chunk",
  "artifact.end",
  "artifact.abort",
]);

const CONTEXT_NOTIFICATION_METHODS = new Set<NativeMethod>([
  "context.snapshot",
  "context.event",
  "context.complete",
]);

const safeErrorDetails = (value: Record<string, unknown>): Record<string, unknown> => {
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (!/^(?:missing|method|reason_code|state)$/u.test(key)) continue;
    if (typeof item === "boolean" || (typeof item === "number" && Number.isSafeInteger(item))) {
      safe[key] = item;
    } else if (typeof item === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(item)) {
      safe[key] = item;
    } else if (
      Array.isArray(item) &&
      item.length <= 32 &&
      item.every((entry) => typeof entry === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(entry))
    ) {
      safe[key] = [...item];
    }
  }
  return safe;
};

const errorProjection = (error: RpcResponse["error"]): {
  a0Code: string;
  outcome: "not_applied" | "applied" | "unknown";
  retryable: boolean;
} => {
  const data = isRecord(error?.data) ? error.data : {};
  const a0Code = typeof data.a0_code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(data.a0_code)
    ? data.a0_code
    : "INTERNAL_ERROR";
  const outcome = data.outcome === "applied" || data.outcome === "unknown" ? data.outcome : "not_applied";
  return { a0Code, outcome, retryable: data.retryable === true };
};

export class NativePortController {
  private port: chrome.runtime.Port | null = null;
  private serial = 0;
  private helloId = "";
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloDeadlineAt = 0;
  private helloContext: NativeHelloContext | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inboundLiveIds = new Set<string>();
  private readonly settledTombstones = new Set<string>();
  private readonly settledOrder: string[] = [];
  private snapshot: NativeConnectionSnapshot = {
    state: "disconnected",
    reasonCode: "native_not_connected",
  };

  private readonly dependencies: NativePortDependencies;

  constructor(
    onState: NativePortDependencies["onState"],
    onRequest: NativeRequestHandler,
    dependencies?: Partial<NativePortDependencies>,
  ) {
    this.dependencies = {
      connectNative: dependencies?.connectNative ?? ((hostName) => chrome.runtime.connectNative(hostName)),
      extensionId: dependencies?.extensionId ?? chrome.runtime.id,
      extensionVersion: dependencies?.extensionVersion ?? chrome.runtime.getManifest().version,
      onState,
      onRequest,
      onResponsePosted: dependencies?.onResponsePosted ?? (() => undefined),
      setTimer: dependencies?.setTimer ?? ((callback, timeoutMs) => setTimeout(callback, timeoutMs)),
      clearTimer: dependencies?.clearTimer ?? ((timer) => clearTimeout(timer)),
      createRequestId: dependencies?.createRequestId ?? (() => `rpc:${crypto.randomUUID()}`),
      now: dependencies?.now ?? (() => Date.now()),
    };
  }

  get state(): NativeConnectionSnapshot {
    return {
      ...this.snapshot,
      ...(this.snapshot.activationBlockers ? { activationBlockers: [...this.snapshot.activationBlockers] } : {}),
      ...(this.snapshot.negotiatedActions ? { negotiatedActions: [...this.snapshot.negotiatedActions] } : {}),
      ...(this.snapshot.negotiatedFeatures ? { negotiatedFeatures: [...this.snapshot.negotiatedFeatures] } : {}),
      ...(this.snapshot.developmentAdmission ? {
        developmentAdmission: { ...this.snapshot.developmentAdmission, transports: [...this.snapshot.developmentAdmission.transports] },
      } : {}),
    };
  }

  connect(context: NativeHelloContext): void {
    if (this.port || this.snapshot.state === "connecting" || this.snapshot.state === "negotiating") return;

    let params: Record<string, unknown>;
    try {
      params = buildHelloParams({
        extensionId: this.dependencies.extensionId,
        extensionVersion: this.dependencies.extensionVersion,
        installInstanceId: context.installInstanceId,
        loadGenerationId: context.loadGenerationId,
        browserFamily: context.browserFamily,
        browserVersion: context.browserVersion,
        actions: context.actions,
        features: context.features,
        eventCursors: context.eventCursors ?? [
          {
            loadGenerationId: context.loadGenerationId,
            lastAckedEventSequence: context.lastAckedEventSequence,
          },
        ],
        inflightOpIds: context.inflightOpIds,
        leaseDigest: context.leaseDigest,
      }) as unknown as Record<string, unknown>;
    } catch {
      this.transition("blocked", "native_hello_context_invalid");
      return;
    }

    this.transition("connecting", "native_connecting");
    const serial = ++this.serial;
    let port: chrome.runtime.Port;
    try {
      port = this.dependencies.connectNative(NATIVE_HOST_NAME);
    } catch {
      this.transition("disconnected", "native_host_unavailable");
      return;
    }
    this.port = port;
    this.helloContext = { ...context };
    this.helloId = `hello:${context.workerBootId}`;
    if (!validOpaqueId(this.helloId)) {
      this.block(serial, "native_hello_context_invalid");
      return;
    }

    port.onMessage.addListener((value: unknown) => void this.receive(serial, value));
    port.onDisconnect.addListener(() => this.handleDisconnect(serial));
    this.transition("negotiating", "native_hello_pending");
    this.helloDeadlineAt = this.dependencies.now() + HELLO_TIMEOUT_MS;
    this.helloTimer = this.dependencies.setTimer(() => this.block(serial, "native_hello_timeout"), HELLO_TIMEOUT_MS);
    this.post(serial, rpcRequest(this.helloId, "bridge.hello", params));
  }

  disconnect(reasonCode = "native_disconnect_requested"): void {
    const port = this.port;
    this.port = null;
    this.serial += 1;
    this.clearHelloTimer();
    this.rejectAllPending(reasonCode);
    this.inboundLiveIds.clear();
    this.helloContext = null;
    try {
      port?.disconnect();
    } catch {
      // The native port may already be closed.
    }
    this.transition("disconnected", reasonCode);
  }

  pairingStatus(options: NativeRequestOptions = {}): Promise<PairingStatusResult> {
    return this.request("pairing.status", buildPairingStatusParams(), parsePairingStatusResult, options);
  }

  pairingExchange(
    input: { pairingCode: string; serverBaseOrigin: string },
    options: NativeRequestOptions = {},
  ): Promise<PairingExchangeResult> {
    const params = buildPairingExchangeParams(input);
    return this.request("pairing.exchange", params, parsePairingExchangeResult, options);
  }

  pairingDisconnect(options: NativeRequestOptions = {}): Promise<PairingStatusResult> {
    return this.request("pairing.disconnect", buildPairingStatusParams(), parsePairingStatusResult, options);
  }

  agentStatus(options: NativeRequestOptions = {}): Promise<AgentStatusResult> {
    return this.request(
      "agent.status",
      { contract_version: 1 },
      parseAgentStatusResult,
      options,
    );
  }

  contextList(
    limit = 64,
    options: NativeRequestOptions = {},
  ): Promise<{ contractVersion: 1; contexts: ContextSummary[] }> {
    return this.request("context.list", buildContextListParams(limit), parseContextListResult, options);
  }

  contextSubscribe(
    input: ContextSubscribeInput,
    options: NativeRequestOptions = {},
  ): Promise<ContextSubscribeResult> {
    return this.request(
      "context.subscribe",
      buildContextSubscribeParams(input),
      parseContextSubscribeResult,
      options,
    );
  }

  contextUnsubscribe(
    contextId: string,
    options: NativeRequestOptions = {},
  ): Promise<{ contextId: string; unsubscribed: true }> {
    return this.request(
      "context.unsubscribe",
      buildContextUnsubscribeParams(contextId),
      parseContextUnsubscribeResult,
      options,
    );
  }

  contextSendMessage(
    input: { contextId: string; clientMessageId: string; text: string },
    options: NativeRequestOptions = {},
  ): Promise<ContextSendMessageResult> {
    return this.request(
      "context.send_message",
      buildContextSendMessageParams(input),
      parseContextSendMessageResult,
      options,
    );
  }

  artifactBegin(
    binding: OutputArtifactBinding,
    metadata: { mimeType: string; byteCount: number; sha256: string },
    options: NativeRequestOptions = {},
  ): Promise<ArtifactAck> {
    return this.request(
      "artifact.begin",
      buildArtifactBeginParams(binding, metadata),
      (value) => parseArtifactAck(value, binding, "begin"),
      options,
    );
  }

  artifactChunk(
    binding: OutputArtifactBinding,
    chunkIndex: number,
    data: string,
    options: NativeRequestOptions = {},
  ): Promise<ArtifactAck> {
    return this.request(
      "artifact.chunk",
      buildArtifactChunkParams(binding, chunkIndex, data),
      (value) => parseArtifactAck(value, binding, "chunk"),
      options,
    );
  }

  artifactEnd(
    binding: OutputArtifactBinding,
    options: NativeRequestOptions = {},
  ): Promise<ArtifactAck> {
    return this.request(
      "artifact.end",
      buildArtifactEndParams(binding),
      (value) => parseArtifactAck(value, binding, "end"),
      options,
    );
  }

  artifactAbort(
    binding: OutputArtifactBinding,
    reasonCode: ArtifactAbortReason,
    options: NativeRequestOptions = {},
  ): Promise<ArtifactAck> {
    return this.request(
      "artifact.abort",
      buildArtifactAbortParams(binding, reasonCode),
      (value) => parseArtifactAck(value, binding, "abort"),
      options,
    );
  }

  browserEvent(event: CriticalBrowserEventRecord): void {
    if (!this.port || this.snapshot.state !== "ready") {
      throw new NativeConnectionError("native_not_ready");
    }
    if (!browserConnectionAuthorityKey(this.snapshot)) {
      throw new NativeConnectionError("native_activation_not_ready");
    }
    if (this.snapshot.limitedTransportReady === true && event.eventType === "challenge.required" && event.data.kind !== "site") {
      throw new NativeConnectionError("native_development_action_unavailable");
    }
    this.post(this.serial, rpcNotification("browser.event", buildBrowserEventParams(event)));
  }

  private request<T>(
    method: NativeMethod,
    params: Record<string, unknown>,
    parseResult: (value: unknown) => T,
    options: NativeRequestOptions,
  ): Promise<T> {
    if (!CLIENT_METHODS.has(method) || !this.port || this.snapshot.state !== "ready") {
      return Promise.reject(new NativeConnectionError("native_not_ready"));
    }
    if (ACTIVATED_CLIENT_METHODS.has(method) && this.snapshot.activationReady !== true) {
      return Promise.reject(new NativeConnectionError("native_activation_not_ready"));
    }
    if (options.signal?.aborted) return Promise.reject(new NativeRequestCancelledError(method));
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      return Promise.reject(new NativeRequestTimeoutError(method));
    }
    const id = this.dependencies.createRequestId();
    if (
      !validOpaqueId(id) ||
      id === this.helloId ||
      this.pending.has(id) ||
      this.inboundLiveIds.has(id) ||
      this.settledTombstones.has(id)
    ) {
      this.block(this.serial, "native_correlation_id_invalid");
      return Promise.reject(new NativeConnectionError("native_correlation_id_invalid"));
    }

    const serial = this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = this.dependencies.setTimer(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.clearPending(pending);
        this.markSettled(id);
        reject(new NativeRequestTimeoutError(method));
      }, timeoutMs);
      const pending: PendingRequest = {
        id,
        method,
        deadlineAt: this.dependencies.now() + timeoutMs,
        timer,
        signal: options.signal,
        parseResult,
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (options.signal) {
        pending.onAbort = () => {
          if (!this.pending.has(id)) return;
          this.clearPending(pending);
          this.markSettled(id);
          reject(new NativeRequestCancelledError(method));
        };
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      this.post(serial, rpcRequest(id, method, params));
    });
  }

  private async receive(serial: number, value: unknown): Promise<void> {
    if (!this.isCurrent(serial)) return;
    let message: RpcMessage;
    try {
      message = parseRpcMessage(value);
    } catch (error) {
      if (
        error instanceof RpcValidationError &&
        error.reasonCode === "UNKNOWN_METHOD" &&
        isRecord(value) &&
        value.jsonrpc === "2.0" &&
        validOpaqueId(value.id) &&
        hasExactKeys(value, ["jsonrpc", "id", "method", "params"]) &&
        isRecord(value.params)
      ) {
        this.post(serial, rpcError(value.id, -32601, "Method not found."));
        return;
      }
      this.block(serial, "native_message_invalid");
      return;
    }

    if ("method" in message) {
      await this.handleRequest(serial, message);
      return;
    }
    this.handleResponse(serial, message);
  }

  private handleResponse(serial: number, response: RpcResponse): void {
    if (!this.isCurrent(serial)) return;
    if (this.snapshot.state === "negotiating") {
      if (response.id !== this.helloId) {
        this.block(serial, "native_response_uncorrelated");
        return;
      }
      if (response.error) {
        const projected = errorProjection(response.error);
        this.block(serial, projected.a0Code === "VERSION_MISMATCH" ? "native_version_mismatch" : "native_hello_rejected");
        return;
      }
      if (this.dependencies.now() >= this.helloDeadlineAt) {
        this.block(serial, "native_hello_timeout");
        return;
      }

      let hello;
      try {
        hello = parseHelloResult(response.result);
      } catch (error) {
        const versionMismatch = error instanceof Error && error.message === "VERSION_MISMATCH";
        this.block(serial, versionMismatch ? "native_version_mismatch" : "native_hello_invalid");
        return;
      }
      const context = this.helloContext;
      if (!context) {
        this.block(serial, "native_hello_invalid");
        return;
      }
      const activation = evaluateActivation(hello, context.activationEvidence, {
        extensionId: this.dependencies.extensionId,
        installInstanceId: context.installInstanceId,
        actions: context.actions,
        features: context.features,
      });
      const limitedTransportReady = evaluateDevelopmentAdmission(hello, context.activationEvidence, {
        extensionId: this.dependencies.extensionId, installInstanceId: context.installInstanceId,
        loadGenerationId: context.loadGenerationId, browserVersion: context.browserVersion,
        actions: context.actions, features: context.features,
      });
      this.clearHelloTimer();
      const effectiveServerState = hello.server.state === "paired" && !activation.ready
        ? "paired_inactive"
        : hello.server.state;
      this.transition("ready", hello.development ? "development_pairing_only"
        : hello.developmentAdmission ? limitedTransportReady ? "development_reconciliation_pending" : "development_admission_unavailable"
        : activation.ready ? "native_ready" : "native_pairing_only", hello.connectionId, {
        companionVersion: hello.companion.version,
        serverState: effectiveServerState,
        reportedServerState: hello.server.state,
        activationReady: activation.ready,
        activationBlockers: activation.blockers,
        negotiatedActions: hello.negotiated.actions,
        negotiatedFeatures: hello.negotiated.features,
        ...(hello.developmentAdmission ? { limitedTransportReady, developmentAdmission: hello.developmentAdmission } : {}),
      });
      return;
    }

    if (this.settledTombstones.has(response.id)) return;
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.block(serial, "native_response_uncorrelated");
      return;
    }
    if (this.dependencies.now() >= pending.deadlineAt) {
      this.clearPending(pending);
      this.markSettled(response.id);
      pending.reject(new NativeRequestTimeoutError(pending.method));
      return;
    }
    this.clearPending(pending);
    if (response.error) {
      const projected = errorProjection(response.error);
      pending.reject(new NativeRpcError(pending.method, projected.a0Code, projected.outcome, projected.retryable));
      return;
    }
    try {
      pending.resolve(pending.parseResult(response.result));
    } catch {
      pending.reject(new NativeConnectionError("native_response_schema_invalid"));
      this.block(serial, "native_response_schema_invalid");
    }
  }

  private async handleRequest(serial: number, request: RpcRequest): Promise<void> {
    if (!this.isCurrent(serial)) return;
    if (!INBOUND_METHODS.has(request.method)) {
      if (request.id) this.post(serial, rpcError(request.id, -32601, "Method not available in this direction."));
      return;
    }
    if (CONTEXT_NOTIFICATION_METHODS.has(request.method) && request.id) {
      this.post(serial, rpcError(request.id, -32600, "Context relay frames must be notifications."));
      return;
    }
    if (request.id && this.inboundLiveIds.has(request.id)) {
      this.block(serial, "native_duplicate_correlation_id");
      return;
    }
    if (this.snapshot.state !== "ready" && request.method !== "bridge.ping") {
      if (request.id) {
        this.post(serial, rpcError(request.id, -32010, "The browser runtime is not negotiated.", {
          a0_code: "INVALID_STATE",
          outcome: "not_applied",
          retryable: false,
        }));
      }
      return;
    }
    if (
      (isPrivilegedBrowserMethod(request.method) || CONTEXT_NOTIFICATION_METHODS.has(request.method))
      && !(this.snapshot.activationReady === true
        || (LIMITED_BROWSER_METHODS.has(request.method) && browserConnectionAuthorityKey(this.snapshot)))
    ) {
      if (request.id) {
        this.post(serial, rpcError(request.id, -32010, "The browser bridge is paired but not activated.", {
          a0_code: "UNSUPPORTED_CAPABILITY",
          outcome: "not_applied",
          retryable: false,
        }));
      }
      return;
    }

    let params: Record<string, unknown>;
    try {
      params = parseInboundParams(request.method, request.params);
    } catch {
      if (request.id) this.post(serial, rpcError(request.id, -32602, "Invalid method parameters."));
      return;
    }

    if (request.id) this.inboundLiveIds.add(request.id);
    const connection = this.state;
    try {
      const rawResult = await this.dependencies.onRequest(request.method, params);
      if (!this.isCurrent(serial)) return;
      const result = parseOutboundResult(request.method, rawResult);
      if (request.id && this.post(serial, rpcResult(request.id, result)) && this.isCurrent(serial)
        && this.snapshot.connectionId === connection.connectionId) {
        try {
          this.dependencies.onResponsePosted(request.method, connection);
        } catch {
          // Success is already on the wire: never emit a second correlated reply.
          this.block(serial, "native_response_hook_failed");
        }
      }
    } catch (error) {
      if (!this.isCurrent(serial)) return;
      if (error instanceof NativeRequestError) {
        if (request.id) {
          this.post(serial, rpcError(request.id, -32010, error.message.slice(0, 512), {
            a0_code: /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.a0Code) ? error.a0Code : "INTERNAL_ERROR",
            outcome: error.outcome,
            retryable: error.retryable,
            details: safeErrorDetails(error.details),
          }));
        }
      } else if (error instanceof Error && error.name === "NativeSchemaError") {
        this.block(serial, "native_local_schema_invalid");
      } else if (request.id) {
        this.post(serial, rpcError(request.id, -32010, "The browser request could not be completed.", {
          a0_code: "INTERNAL_ERROR",
          outcome: "not_applied",
          retryable: false,
          details: {},
        }));
      }
    } finally {
      if (request.id && this.isCurrent(serial)) this.inboundLiveIds.delete(request.id);
    }
  }

  private post(serial: number, message: RpcMessage): boolean {
    if (!this.isCurrent(serial)) return false;
    try {
      if (encodedSize(message) > MAX_NATIVE_MESSAGE_BYTES) throw new Error("oversized response");
      this.port?.postMessage(message);
      return true;
    } catch {
      this.block(serial, "native_response_send_failed");
      return false;
    }
  }

  private handleDisconnect(serial: number): void {
    if (!this.isCurrent(serial)) return;
    this.port = null;
    this.clearHelloTimer();
    this.rejectAllPending("native_port_disconnected");
    this.inboundLiveIds.clear();
    this.helloContext = null;
    if (this.snapshot.state !== "blocked") this.transition("disconnected", "native_port_disconnected");
  }

  private block(serial: number, reasonCode: string): void {
    if (!this.isCurrent(serial)) return;
    this.clearHelloTimer();
    const port = this.port;
    this.port = null;
    this.rejectAllPending(reasonCode);
    this.inboundLiveIds.clear();
    this.helloContext = null;
    this.transition("blocked", reasonCode);
    try {
      port?.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  private clearPending(pending: PendingRequest): void {
    this.pending.delete(pending.id);
    this.dependencies.clearTimer(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  private rejectAllPending(reasonCode: string): void {
    for (const pending of [...this.pending.values()]) {
      this.clearPending(pending);
      pending.reject(new NativeConnectionError(reasonCode));
    }
  }

  private markSettled(id: string): void {
    this.settledTombstones.add(id);
    this.settledOrder.push(id);
    if (this.settledOrder.length > MAX_SETTLED_TOMBSTONES) {
      const oldest = this.settledOrder.shift();
      if (oldest) this.settledTombstones.delete(oldest);
    }
  }

  private isCurrent(serial: number): boolean {
    return serial === this.serial && this.port !== null;
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      this.dependencies.clearTimer(this.helloTimer);
      this.helloTimer = null;
    }
    this.helloDeadlineAt = 0;
  }

  private transition(
    state: NativeConnectionState,
    reasonCode: string,
    connectionId?: string,
    metadata: Omit<NativeConnectionSnapshot, "connectionId" | "reasonCode" | "state"> = {},
  ): void {
    this.snapshot = {
      state,
      reasonCode,
      ...(connectionId ? { connectionId } : {}),
      ...metadata,
    };
    this.dependencies.onState(this.state);
  }
}
