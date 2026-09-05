import {
  BROWSER_RUNTIME_ACTIONS,
  BROWSER_RUNTIME_CAPABILITIES,
  BrowserRuntime,
  SITE_CHALLENGE_EXPIRY_ALARM,
} from "./browser-runtime";
import { ContentRuntimeHost } from "./content-host";
import {
  NativePortController,
  NativeRequestError,
  browserConnectionAuthorityKey,
  canReconnectDevelopmentBrowser,
  type NativeConnectionSnapshot,
  type NativeHelloContext,
  type NativeRequestHandler,
} from "./native-port";
import { extensionIdentityApproved } from "./release-trust";
import { buildBrowserReconcileResult, parseBrowserReconcileRequest } from "../protocol/native";
import { RuntimeStore, type StagedTabCandidate } from "./runtime-store";
import { createUiRouter } from "./ui-router";
import { ContextRelay, ContextRelayError } from "./context-relay";
import { CriticalEventRelay } from "./critical-events";
import { ChromeScreenshotDebuggerHost } from "./debugger-host";
import type {
  ContextCompleteNotification,
  ContextEventNotification,
  ContextSnapshotNotification,
} from "../protocol/context";
import type { BrowserAckEventsRequest } from "../protocol/browser-events";
import { hasExactKeys, isRecord, validOpaqueId } from "../protocol/rpc";
import { NativeLifecycleQueue, type NativeStateGuard } from "./native-lifecycle";
import { BUILD_CHANNEL } from "../build-channel";

const NATIVE_RECONNECT_ALARM = "a0.browser-bridge.native-reconnect.v1";
const SIDE_PANEL_PORT = "a0.browser-bridge.side-panel.v1";
const CONTEXT_MENU_PAGE = "a0-browser-page";
const CONTEXT_MENU_SELECTION = "a0-browser-selection";
const CONTEXT_MENU_IMAGE = "a0-browser-image";
const REQUIRED_RUNTIME_PERMISSIONS: chrome.runtime.ManifestPermissions[] = [
  "nativeMessaging",
  "storage",
  "alarms",
  "tabs",
  "tabGroups",
  "scripting",
  "sidePanel",
  "debugger",
  "contextMenus",
];
const REQUIRED_OPERATIONAL_INBOUND_METHODS = [
  "credential.changed",
  "bridge.ping",
  "context.snapshot",
  "context.event",
  "context.complete",
  "context.queue_updated",
  "browser.perform",
  "browser.cancel",
  "browser.finalize_turn",
  "browser.resolve_challenge",
  "browser.reconcile",
  "browser.ack_events",
  "artifact.begin",
  "artifact.chunk",
  "artifact.end",
  "artifact.abort",
] as const;
const IMPLEMENTED_OPERATIONAL_INBOUND_METHODS = new Set([
  "credential.changed",
  "bridge.ping",
  "context.snapshot",
  "context.event",
  "context.complete",
  "context.queue_updated",
  "browser.perform",
  "browser.cancel",
  "browser.finalize_turn",
  "browser.resolve_challenge",
  "browser.reconcile",
  "browser.ack_events",
]);

const runtimeStore = new RuntimeStore();
const contentHost = new ContentRuntimeHost();
const debuggerHost = new ChromeScreenshotDebuggerHost();
const criticalEventRelay = new CriticalEventRelay(runtimeStore, {
  browserEvent: (event) => nativePort.browserEvent(event),
});
const browserRuntime = new BrowserRuntime(runtimeStore, async (lease) => {
  await contentHost.release(lease, "finalize");
}, contentHost, criticalEventRelay, debuggerHost, {
  inputArtifact: async (binding, options) => await nativePort.inputArtifact(binding, options),
  artifactBegin: async (binding, metadata, options) => await nativePort.artifactBegin(binding, metadata, options),
  artifactChunk: async (binding, chunkIndex, data, options) =>
    await nativePort.artifactChunk(binding, chunkIndex, data, options),
  artifactEnd: async (binding, options) => await nativePort.artifactEnd(binding, options),
  artifactAbort: async (binding, reasonCode, options) => await nativePort.artifactAbort(binding, reasonCode, options),
}, () => nativePort.state);
type PanelPortRecord = {
  panelId: string;
  anchorKey: string;
  anchorOrigin: string | null;
};

const panelPorts = new Map<chrome.runtime.Port, PanelPortRecord>();

let bootPromise: Promise<void> | null = null;
const nativeLifecycle = new NativeLifecycleQueue(() => nativePort.state);

function safePanelState(anchorOrigin: string | null = null): Record<string, unknown> {
  const snapshot = runtimeStore.snapshot;
  const connection = snapshot.session.connection;
  const ready = snapshot.lifecycle.phase === "READY"
    && connection.state === "ready"
    && connection.activationReady === true && nativePort.state.activationReady === true
    && connection.connectionId === nativePort.state.connectionId;
  const limitedBrowserReady = BUILD_CHANNEL.development && browserRuntimeReady();
  const { developmentAdmission: _privateAdmission, ...presentationConnection } = connection;
  return {
    ready,
    limitedBrowserReady,
    canReconnectDevelopmentBrowser: canReconnectDevelopmentBrowser(nativePort.state),
    connectionError: ready ? "" : connection.reasonCode,
    lastStatus: ready ? "Browser companion ready" : "Browser companion setup required",
    bridge: {
      contract: "a0.browser-bridge.mv3-runtime.v1",
      loadGenerationId: snapshot.lifecycle.loadGenerationId,
      phase: snapshot.lifecycle.phase,
      connection: presentationConnection,
      capabilities: connection.negotiatedFeatures ? [...connection.negotiatedFeatures] : [],
      actions: connection.negotiatedActions ? [...connection.negotiatedActions] : [],
      activeLeaseCount: Object.values(snapshot.session.leasesByHandle).filter((lease) => lease.state === "active").length,
      candidateReady: Boolean(
        snapshot.session.stagedCandidate
        && snapshot.session.stagedCandidate.expiresAtMs > Date.now(),
      ),
    },
    panel: { anchorOrigin },
  };
}

function broadcastPanelState(): void {
  let state: Record<string, unknown>;
  try {
    state = safePanelState();
    refreshApprovalProjection();
  } catch {
    return;
  }
  for (const [port, panel] of panelPorts) {
    try {
      port.postMessage({
        type: "state",
        state: panel.anchorOrigin ? safePanelState(panel.anchorOrigin) : state,
      });
    } catch {
      panelPorts.delete(port);
    }
  }
}

function validExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const extensionRoot = chrome.runtime.getURL("");
  return Boolean(
    (sender.url && sender.url.startsWith(extensionRoot))
    || (sender.origin && `${sender.origin}/` === extensionRoot),
  );
}

function safeHttpOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

async function routePanelPortRequest(
  port: chrome.runtime.Port,
  panel: PanelPortRecord,
  value: unknown,
): Promise<void> {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["type", "request_id", "request"])
    || value.type !== "ui_request"
    || !validOpaqueId(value.request_id)
    || !isRecord(value.request)
  ) {
    return;
  }
  try {
    const response = await routeUiRequest(value.request, { panelId: panel.panelId });
    if (panelPorts.get(port)?.panelId !== panel.panelId) return;
    port.postMessage({ type: "ui_response", request_id: value.request_id, response });
  } catch (error) {
    if (panelPorts.get(port)?.panelId !== panel.panelId) return;
    const code = error instanceof ContextRelayError
      ? error.reasonCode
      : error instanceof Error && error.name === "UiRequestError"
        ? error.message
        : "CONTEXT_REQUEST_FAILED";
    try {
      port.postMessage({
        type: "ui_response",
        request_id: value.request_id,
        response: { ok: false, error: code },
      });
    } catch {
      // The side panel may have closed while the native request was pending.
    }
  }
}

function browserVersion(): string {
  return /(?:Chrome|Chromium)\/([0-9.]+)/u.exec(navigator.userAgent)?.[1] || "120";
}

async function digestLeaseProjection(): Promise<string> {
  const handles = Object.values(runtimeStore.snapshot.session.leasesByHandle)
    .map((lease) => `${lease.leaseId}:${lease.tabHandle}`).sort().join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(handles));
  const encoded = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${encoded}`;
}

async function chromePermissionsReady(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      permissions: REQUIRED_RUNTIME_PERMISSIONS,
      origins: ["http://*/*", "https://*/*"],
    });
  } catch {
    return false;
  }
}

async function helloContext(): Promise<NativeHelloContext> {
  const snapshot = runtimeStore.snapshot;
  return {
    installInstanceId: snapshot.lifecycle.installInstanceId,
    loadGenerationId: snapshot.lifecycle.loadGenerationId,
    workerBootId: snapshot.lifecycle.workerBootId,
    leaseDigest: await digestLeaseProjection(),
    // The current WAL is action-keyed and does not durably retain transport
    // op_ids. Never mislabel action IDs as operation IDs during recovery.
    inflightOpIds: [],
    lastAckedEventSequence: snapshot.session.lastAckedEventSequence,
    eventCursors: [{
      loadGenerationId: snapshot.lifecycle.loadGenerationId,
      lastAckedEventSequence: snapshot.ledger.eventAckCursors[snapshot.lifecycle.loadGenerationId] ?? 0,
    }],
    browserFamily: "chrome",
    browserVersion: browserVersion(),
    actions: [...BROWSER_RUNTIME_ACTIONS],
    features: [...BROWSER_RUNTIME_CAPABILITIES],
    activationEvidence: {
      extensionIdentityApproved: extensionIdentityApproved(chrome.runtime.id),
      storageMigrationState: snapshot.activationEvidence.storageMigrationState,
      chromePermissionsReady: await chromePermissionsReady(),
      legacyControlPlaneInactive: snapshot.activationEvidence.legacyControlPlaneInactive,
      operationalMethodSurfaceReady: REQUIRED_OPERATIONAL_INBOUND_METHODS.every(
        (method) => IMPLEMENTED_OPERATIONAL_INBOUND_METHODS.has(method),
      ),
    },
  };
}

async function reconcile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const request = parseBrowserReconcileRequest(params);
  return await nativeLifecycle.reconcile(async (guard, connection) => {
    if (!browserConnectionAuthorityKey(connection, runtimeStore.snapshot.lifecycle)) {
      throw new NativeRequestError("Browser transport admission is unavailable.", "UNSUPPORTED_CAPABILITY");
    }
    if (runtimeStore.snapshot.session.connection.connectionId !== connection.connectionId) {
      throw new NativeRequestError("The native connection is not initialized.", "INVALID_STATE");
    }
    if (runtimeStore.snapshot.lifecycle.phase === "RECONCILING") {
      await runtimeStore.transitionPhase("READY");
      guard();
    }
    if (runtimeStore.snapshot.lifecycle.phase !== "READY") {
      throw new NativeRequestError("The browser runtime is not ready to reconcile.", "INVALID_STATE");
    }
    broadcastPanelState();
    const snapshot = runtimeStore.snapshot;
    const terminalStages = new Set(["succeeded", "failed", "canceled", "outcome_unknown"]);
    return { ...buildBrowserReconcileResult({
      controlId: request.control_id,
      installInstanceId: snapshot.lifecycle.installInstanceId,
      loadGenerationId: snapshot.lifecycle.loadGenerationId,
      leases: Object.values(snapshot.session.leasesByHandle),
      inflightOperations: snapshot.ledger.operations.filter((operation) => !terminalStages.has(operation.stage)),
      terminalActionReceipts: snapshot.ledger.operations.filter((operation) => terminalStages.has(operation.stage)),
      pendingCriticalEvents: snapshot.ledger.criticalEvents,
      priorGenerationOrphans: snapshot.ledger.leases.filter(
        (lease) => lease.loadGenerationId !== snapshot.lifecycle.loadGenerationId && lease.state === "orphan",
      ),
    }) };
  });
}

const handleNativeRequest: NativeRequestHandler = async (method, params) => {
  if (["browser.perform", "browser.cancel", "browser.finalize_turn", "browser.resolve_challenge", "browser.ack_events"].includes(method)
    && !browserRuntimeReady()) {
    throw new NativeRequestError("Browser reconciliation or current admission is unavailable.", "INVALID_STATE");
  }
  if (nativePort.state.limitedTransportReady === true && method === "browser.resolve_challenge" && params.action_class !== "navigate") {
    throw new NativeRequestError("Development trusted input is unavailable.", "UNSUPPORTED_CAPABILITY");
  }
  switch (method) {
    case "bridge.ping":
      return { contract_version: 1, observed_at_ms: Date.now(), phase: runtimeStore.snapshot.lifecycle.phase };
    case "agent.status":
      return safePanelState().bridge as Record<string, unknown>;
    case "context.snapshot":
      contextRelay.acceptSnapshot(params as unknown as ContextSnapshotNotification);
      return { accepted: true };
    case "context.event":
      contextRelay.acceptEvent(params as unknown as ContextEventNotification);
      return { accepted: true };
    case "context.complete":
      contextRelay.acceptComplete(params as unknown as ContextCompleteNotification);
      return { accepted: true };
    case "context.queue_updated":
      contextRelay.acceptQueue(params as unknown as import("../protocol/context").ContextQueueProjection);
      return { accepted: true };
    case "credential.changed":
      nativePort.disconnect("credential_revoked");
      return { accepted: true };
    case "browser.reconcile":
      return await reconcile(params);
    case "browser.ack_events":
      return await criticalEventRelay.acknowledge(params as unknown as BrowserAckEventsRequest);
    case "browser.perform":
      if (runtimeStore.snapshot.lifecycle.phase !== "READY") {
        throw new NativeRequestError("Browser reconciliation has not completed.", "INVALID_STATE");
      }
      if (!browserRuntimeReady()) {
        throw new NativeRequestError("The browser companion is not activated for browser control.", "UNSUPPORTED_CAPABILITY");
      }
      return await browserRuntime.perform(params);
    case "browser.cancel":
      if (runtimeStore.snapshot.lifecycle.phase !== "READY") {
        throw new NativeRequestError("Browser reconciliation has not completed.", "INVALID_STATE");
      }
      if (!browserRuntimeReady()) {
        throw new NativeRequestError("The browser companion is not activated for browser control.", "UNSUPPORTED_CAPABILITY");
      }
      return await browserRuntime.cancel(params);
    case "browser.finalize_turn":
      if (runtimeStore.snapshot.lifecycle.phase !== "READY") {
        throw new NativeRequestError("Browser reconciliation has not completed.", "INVALID_STATE");
      }
      if (!browserRuntimeReady()) {
        throw new NativeRequestError("The browser companion is not activated for browser control.", "UNSUPPORTED_CAPABILITY");
      }
      return await browserRuntime.finalize(params);
    case "browser.resolve_challenge":
      if (runtimeStore.snapshot.lifecycle.phase !== "READY") {
        throw new NativeRequestError("Browser reconciliation has not completed.", "INVALID_STATE");
      }
      if (!browserRuntimeReady()) {
        throw new NativeRequestError("The browser companion is not activated for browser control.", "UNSUPPORTED_CAPABILITY");
      }
      return await browserRuntime.resolveChallenge(params);
    default:
      throw new NativeRequestError("This native method is not implemented by the current extension slice.", "UNSUPPORTED_CAPABILITY");
  }
};

const nativePort = new NativePortController(
  (snapshot) => {
    // Revoke stream delivery synchronously, before any queued storage work.
    if (snapshot.state !== "ready" || snapshot.activationReady !== true) {
      contextRelay.deactivate();
    }
    if (!browserConnectionAuthorityKey(snapshot)) {
      criticalEventRelay.deactivate();
    }
    nativeLifecycle.observe(snapshot, (guard) => handleNativeState(snapshot, guard),
      () => nativePort.disconnect("lifecycle_transition_blocked"));
  },
  handleNativeRequest,
  {
    onResponsePosted: (method, connection) => {
      if (method !== "browser.reconcile" || !browserConnectionAuthorityKey(connection, runtimeStore.snapshot.lifecycle) || !connection.connectionId
        || runtimeStore.snapshot.lifecycle.phase !== "READY"
        || runtimeStore.snapshot.session.connection.connectionId !== connection.connectionId) return;
      if (connection.activationReady === true) contextRelay.activate(connection.connectionId);
      criticalEventRelay.activate(connection.connectionId);
    },
  },
);

const contextRelay = new ContextRelay(nativePort);

function refreshApprovalProjection(): void {
  const snapshot = runtimeStore.snapshot;
  if (!browserRuntimeReady() || nativePort.state.activationReady !== true) {
    contextRelay.replaceApprovals([]);
    return;
  }
  contextRelay.replaceApprovals(snapshot.session.pendingChallenges
    .filter((challenge) => challenge.loadGenerationId === snapshot.lifecycle.loadGenerationId && challenge.expiresAtMs > Date.now())
    .map((challenge) => {
      const action = "actionClass" in challenge;
      return {
        contextId: challenge.contextId, challengeId: challenge.challengeId,
        kind: action ? "action" as const : "site" as const,
        origin: action ? challenge.sourceOrigin : challenge.destinationOrigin,
        summary: action ? "Allow this browser action once?" : "Allow Agent Zero to work on this site?",
        expiresAtMs: challenge.expiresAtMs,
        options: action ? ["decline" as const, "approve_once" as const] : ["deny" as const, "allow_once" as const, "allow_turn" as const],
      };
    }));
}

function browserRuntimeReady(): boolean {
  const snapshot = runtimeStore.snapshot;
  const stored = snapshot.session.connection;
  const live = nativePort.state;
  const key = browserConnectionAuthorityKey(live, snapshot.lifecycle);
  return snapshot.lifecycle.phase === "READY" && key !== null
    && key === browserConnectionAuthorityKey(stored, snapshot.lifecycle)
    && live.connectionId === stored.connectionId;
}

function requireContextUiReady(): void {
  const connection = nativePort.state;
  if (
    runtimeStore.snapshot.lifecycle.phase !== "READY"
    || connection.state !== "ready"
    || connection.activationReady !== true
    || !connection.connectionId
  ) {
    throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
  }
  contextRelay.activate(connection.connectionId);
}

const routeUiRequest = createUiRouter({
  getState: safePanelState,
  refresh: async () => {
    if (nativePort.state.state === "ready") {
      try {
        await nativePort.pairingStatus({ timeoutMs: 5_000 });
      } catch {
        // The layered connection snapshot already carries a safe diagnostic.
      }
    }
    return safePanelState();
  },
  reconnectDevelopmentBrowser: async () => {
    if (!canReconnectDevelopmentBrowser(nativePort.state)) {
      throw new NativeRequestError("Only a paired inactive development connection can reconnect after selection.", "INVALID_STATE");
    }
    nativePort.disconnect("development_reconnect_requested");
    return safePanelState();
  },
  pair: async (submission) => {
    await nativePort.pairingExchange({
      pairingCode: submission.pairing_code,
      serverBaseOrigin: submission.server_base_url,
    }, { timeoutMs: 60_000 });
    nativePort.disconnect("pairing_completed");
    return safePanelState();
  },
  disconnect: async () => {
    await nativePort.pairingDisconnect({ timeoutMs: 30_000 });
    nativePort.disconnect("pairing_disconnected");
    return safePanelState();
  },
  credentialControl: async (action) => {
    requireContextUiReady();
    let result;
    try { result = await nativePort.credentialControl(action); }
    catch (error) {
      if (action === "status" && error instanceof NativeRequestError && error.a0Code === "NO_PENDING_KEY_UPDATE") return { status: "no_pending" };
      throw error;
    }
    if (result.status === "pending" && action === "rotate") nativePort.disconnect("credential_rotation_pending");
    if (result.status === "revoked") nativePort.disconnect("credential_revoked");
    return result;
  },
  contextList: async (panelId) => {
    requireContextUiReady();
    return await contextRelay.list(panelId);
  },
  contextSubscribe: async (panelId, input) => {
    requireContextUiReady();
    await contextRelay.subscribe(panelId, input);
    refreshApprovalProjection();
    return contextRelay.currentView(panelId);
  },
  contextUnsubscribe: async (panelId, contextId) => {
    requireContextUiReady();
    return await contextRelay.unsubscribe(panelId, contextId);
  },
  contextSendMessage: async (panelId, input) => {
    requireContextUiReady();
    return await contextRelay.sendMessage(panelId, input);
  },
  contextQueueAdd: async (panelId, input) => {
    requireContextUiReady();
    return await contextRelay.queueAdd(panelId, input);
  },
  contextQueueItem: async (panelId, action, input) => {
    requireContextUiReady();
    return await contextRelay.queueItem(panelId, action, input);
  },
  localApproval: async (panelId, contextId, input) => {
    requireContextUiReady();
    const connection = contextRelay.requireSelected(panelId, contextId);
    const snapshot = runtimeStore.snapshot;
    const pending = snapshot.session.pendingChallenges.find((challenge) => challenge.challengeId === input.challengeId);
    if (!pending || pending.contextId !== contextId || pending.loadGenerationId !== snapshot.lifecycle.loadGenerationId
      || Date.now() >= pending.expiresAtMs || ("actionClass" in pending ? "action" : "site") !== input.kind) {
      throw new NativeRequestError("This approval is no longer available for the selected chat.", "APPROVAL_DENIED");
    }
    const result = await nativePort.localApproval(input);
    if (connection !== contextRelay.requireSelected(panelId, contextId)) throw new ContextRelayError("CONTEXT_RELAY_INACTIVE");
    return result;
  },
});

async function setPhaseIfAllowed(phase: Parameters<RuntimeStore["transitionPhase"]>[0], guard?: NativeStateGuard): Promise<void> {
  guard?.();
  try {
    await runtimeStore.transitionPhase(phase);
  } catch {
    guard?.();
    nativePort.disconnect("lifecycle_transition_blocked");
  }
  guard?.();
}

function reconnectDelayMs(attempt: number): number {
  if (attempt <= 1) return 30_000;
  if (attempt === 2) return 60_000;
  if (attempt === 3) return 120_000;
  const jitter = crypto.getRandomValues(new Uint16Array(1))[0] % 30_000;
  return 270_000 + jitter;
}

async function scheduleReconnect(guard?: NativeStateGuard): Promise<void> {
  guard?.();
  const currentAttempt = runtimeStore.snapshot.session.reconnectAttempt;
  const nextAttempt = Math.min(currentAttempt + 1, 32);
  const nextReconnectAtMs = Date.now() + reconnectDelayMs(nextAttempt);
  await runtimeStore.updateSession((session) => ({
    ...session,
    reconnectAttempt: nextAttempt,
    nextReconnectAtMs,
  }));
  guard?.();
  await setPhaseIfAllowed("RETRY_WAIT", guard);
  guard?.();
  chrome.alarms.create(NATIVE_RECONNECT_ALARM, { when: nextReconnectAtMs });
  broadcastPanelState();
}

async function connectNative(allowBlocked = false, guard?: NativeStateGuard): Promise<void> {
  guard?.();
  const phase = runtimeStore.snapshot.lifecycle.phase;
  if (phase === "DISCONNECTED" || phase === "RETRY_WAIT" || phase === "BLOCKED") {
    if (phase === "BLOCKED" && !allowBlocked) return;
    await setPhaseIfAllowed("CONNECTING", guard);
    guard?.();
  }
  const context = await helloContext();
  guard?.();
  nativePort.connect(context);
}

async function handleNativeState(connection: NativeConnectionSnapshot, guard: NativeStateGuard): Promise<void> {
  guard();
  const previous = runtimeStore.snapshot.session.connection;
  await runtimeStore.setConnection(connection);
  guard();
  if (previous.state === "ready" && connection.state !== "ready") {
    await browserRuntime.disconnectPendingChallenges();
    guard();
    await browserRuntime.disconnectPendingArtifacts();
    guard();
  }
  switch (connection.state) {
    case "connecting":
      // A replaced handler may have persisted its old phase before revocation.
      if (["NEGOTIATING", "RECONCILING", "READY"].includes(runtimeStore.snapshot.lifecycle.phase)) {
        await setPhaseIfAllowed("DISCONNECTED", guard);
        guard();
      }
      await setPhaseIfAllowed("CONNECTING", guard);
      guard();
      break;
    case "negotiating":
      await setPhaseIfAllowed("NEGOTIATING", guard);
      guard();
      break;
    case "ready":
      await runtimeStore.updateSession((session) => ({
        ...session,
        reconnectAttempt: 0,
        nextReconnectAtMs: null,
      }));
      guard();
      await chrome.alarms.clear(NATIVE_RECONNECT_ALARM);
      guard();
      if (runtimeStore.snapshot.lifecycle.phase !== "READY") {
        await setPhaseIfAllowed("RECONCILING", guard);
        guard();
      }
      break;
    case "blocked":
      await chrome.alarms.clear(NATIVE_RECONNECT_ALARM);
      guard();
      await setPhaseIfAllowed("BLOCKED", guard);
      guard();
      break;
    case "disconnected":
      await setPhaseIfAllowed("DISCONNECTED", guard);
      guard();
      if (connection.reasonCode === "development_reconnect_requested"
        || (previous.state === "ready" && runtimeStore.snapshot.session.reconnectAttempt === 0)) {
        await runtimeStore.updateSession((session) => ({ ...session, reconnectAttempt: 1 }));
        guard();
        await connectNative(false, guard);
      } else {
        await scheduleReconnect(guard);
      }
      guard();
      break;
  }
  if (
    connection.state !== "ready"
    || connection.activationReady !== true
    || runtimeStore.snapshot.lifecycle.phase !== "READY"
  ) {
    contextRelay.deactivate();
  }
  if (!browserRuntimeReady()) {
    criticalEventRelay.deactivate();
  }
  broadcastPanelState();
}

async function ensureReconnectAlarm(): Promise<void> {
  const snapshot = runtimeStore.snapshot;
  if (snapshot.session.connection.state === "ready" || snapshot.session.connection.state === "blocked") return;
  const existing = await chrome.alarms.get(NATIVE_RECONNECT_ALARM);
  if (!existing) await scheduleReconnect();
}

async function ensureContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: CONTEXT_MENU_SELECTION, title: "Ask Agent Zero about this selection", contexts: ["selection"] });
  chrome.contextMenus.create({ id: CONTEXT_MENU_PAGE, title: "Attach this page to Agent Zero", contexts: ["page"] });
  chrome.contextMenus.create({ id: CONTEXT_MENU_IMAGE, title: "Attach this image to Agent Zero", contexts: ["image"] });
}

async function openPanelForTab(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") return;
  await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
  await chrome.sidePanel.open({ tabId: tab.id });
}

async function stageCandidate(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number" || !tab.url) return;
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || tab.incognito) return;
  const snapshot = runtimeStore.snapshot;
  const candidate: StagedTabCandidate = {
    candidateHandle: `a0c1.${crypto.randomUUID()}`,
    loadGenerationId: snapshot.lifecycle.loadGenerationId,
    browserInstanceId: snapshot.session.browserInstanceId,
    providerTabId: tab.id,
    providerWindowId: tab.windowId,
    url: tab.url,
    title: (tab.title || "").slice(0, 512),
    selectionText: (info.selectionText || info.srcUrl || "").slice(0, 8_192),
    expiresAtMs: Date.now() + 5 * 60_000,
  };
  await runtimeStore.updateSession((session) => ({ ...session, stagedCandidate: candidate }));
  await openPanelForTab(tab);
  broadcastPanelState();
}

function ensureBooted(): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      await runtimeStore.hydrate();
      await browserRuntime.recoverPendingChallenges();
      await setPhaseIfAllowed("CONNECTING");
      await ensureReconnectAlarm();
      await connectNative();
    })().catch((error) => {
      bootPromise = null;
      throw error;
    });
  }
  return bootPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureBooted().then(async () => {
    await ensureContextMenus();
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
});

chrome.runtime.onStartup.addListener(() => {
  void ensureBooted().then(ensureContextMenus);
});

chrome.action.onClicked.addListener((tab) => {
  void ensureBooted().then(async () => {
    if (runtimeStore.snapshot.lifecycle.phase === "BLOCKED") await connectNative(true);
    await openPanelForTab(tab);
  });
});

chrome.commands.onCommand.addListener((_command, tab) => {
  if (tab) void ensureBooted().then(() => openPanelForTab(tab));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void ensureBooted().then(() => stageCandidate(info, tab));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NATIVE_RECONNECT_ALARM) {
    void ensureBooted().then(() => connectNative());
    return;
  }
  if (alarm.name === SITE_CHALLENGE_EXPIRY_ALARM) {
    void ensureBooted().then(() => browserRuntime.expireChallenges());
  }
});

chrome.runtime.onConnect.addListener((port) => {
  void ensureBooted().then(() => {
    if (port.name !== SIDE_PANEL_PORT && port.name !== "agent-zero-sidepanel") return;
    if (port.sender?.id !== chrome.runtime.id) return;
    const panelId = `panel:${crypto.randomUUID()}`;
    const anchorOrigin = safeHttpOrigin(port.sender?.tab?.url);
    const panel: PanelPortRecord = {
      panelId,
      anchorKey: typeof port.sender?.tab?.id === "number"
        ? `tab:${port.sender.tab.id}`
        : `document:${port.sender?.documentId ?? panelId}`,
      anchorOrigin,
    };
    panelPorts.set(port, panel);
    contextRelay.registerPanel(panelId, panel.anchorKey, (view) => {
      port.postMessage({ type: "context", context: view });
    });
    port.postMessage({ type: "state", state: safePanelState(anchorOrigin) });
    port.onMessage.addListener((value: unknown) => {
      void routePanelPortRequest(port, panel, value);
    });
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
      void contextRelay.unregisterPanel(panelId);
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void ensureBooted()
    .then(async () => {
      if (
        message?.contract === "a0.browser-bridge.content.v1"
        && message?.kind === "cursor.arrived"
      ) {
        const lease = sender.tab?.id === undefined
          ? null
          : Object.values(runtimeStore.snapshot.session.leasesByHandle).find(
            (candidate) =>
              candidate.identity.providerTabId === sender.tab?.id
              && candidate.identity.documentId === sender.documentId
              && candidate.tabHandle === message.tab_handle
              && candidate.loadGenerationId === message.load_generation_id,
          );
        return { ok: Boolean(lease) };
      }
      if (!validExtensionPageSender(sender)) {
        throw new NativeRequestError("The extension-page sender is not trusted.", "INVALID_STATE");
      }
      if (message?.type === "save_config") {
          throw new NativeRequestError(
            "Direct API-token setup was retired. Install and pair the native browser companion.",
            "INVALID_STATE",
          );
      }
      return await routeUiRequest(message);
    })
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Extension request failed." }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ensureBooted().then(() => browserRuntime.observeTabRemoved(tabId));
});

chrome.debugger.onDetach.addListener((source) => {
  void ensureBooted().then(() => browserRuntime.observeDebuggerDetached(source));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void ensureBooted().then(() => browserRuntime.observeTabReplaced(addedTabId, removedTabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void ensureBooted().then(() => browserRuntime.observeTabUpdated(tabId, changeInfo, tab));
});

chrome.tabs.onMoved.addListener((tabId) => {
  void ensureBooted().then(() => browserRuntime.observeTabMoved(tabId));
});

chrome.tabs.onAttached.addListener((tabId) => {
  void ensureBooted().then(() => browserRuntime.observeWindowChange(tabId));
});

chrome.tabs.onDetached.addListener((tabId) => {
  void ensureBooted().then(() => browserRuntime.observeWindowChange(tabId));
});

chrome.runtime.onUpdateAvailable.addListener(() => {
  void ensureBooted().then(async () => {
    if (runtimeStore.snapshot.lifecycle.phase !== "READY") return;
    await runtimeStore.transitionPhase("UPDATE_PENDING");
    const hasActiveWork = Object.values(runtimeStore.snapshot.session.leasesByHandle).some(
      (lease) => lease.state === "active" || lease.state === "finalizing",
    );
    if (hasActiveWork) return;
    await runtimeStore.transitionPhase("DRAINING");
    nativePort.disconnect("extension_update_ready");
    chrome.runtime.reload();
  });
});

void ensureBooted();
