import { describe, expect, it, vi } from "vitest";

import { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_CHUNK_BYTES } from "../protocol/native";
import { MAX_NATIVE_MESSAGE_BYTES } from "../protocol/rpc";
import type { OutputArtifactBinding } from "../protocol/artifacts";
import {
  NativeConnectionError,
  NativePortController,
  NativeRequestCancelledError,
  NativeRequestTimeoutError,
  type NativeConnectionSnapshot,
  type NativeHelloContext,
} from "./native-port";

type Listener<T> = (value: T) => void;

const EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAIRING_CODE = "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const portFixture = () => {
  const messageListeners: Listener<unknown>[] = [];
  const disconnectListeners: Listener<void>[] = [];
  const postMessage = vi.fn();
  const disconnect = vi.fn(() => disconnectListeners.forEach((listener) => listener()));
  const port = {
    name: "io.agentzero.browser_bridge",
    sender: undefined,
    onMessage: { addListener: (listener: Listener<unknown>) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: Listener<void>) => disconnectListeners.push(listener) },
    postMessage,
    disconnect,
  } as unknown as chrome.runtime.Port;
  return { port, messageListeners, disconnectListeners, postMessage, disconnect };
};

const timerFixture = () => {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    callbacks,
    setTimer: (callback: () => void) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      callbacks.delete(timer as unknown as number);
    },
    fireOnly: () => {
      expect(callbacks.size).toBe(1);
      const [[id, callback]] = [...callbacks.entries()];
      callbacks.delete(id);
      callback();
    },
  };
};

const helloContext = (overrides: Partial<NativeHelloContext> = {}): NativeHelloContext => ({
  installInstanceId: "install-one",
  loadGenerationId: "generation-one",
  workerBootId: "worker-one",
  leaseDigest: `sha256:${"0".repeat(64)}`,
  inflightOpIds: [],
  lastAckedEventSequence: 0,
  browserFamily: "chrome",
  browserVersion: "146.0.0.0",
  actions: ["open"],
  features: ["tab_leases_v1", "tab_groups_v1"],
  activationEvidence: {
    extensionIdentityApproved: true,
    storageMigrationState: "v1_ready",
    chromePermissionsReady: true,
    legacyControlPlaneInactive: true,
    operationalMethodSurfaceReady: true,
  },
  ...overrides,
});

const helloResult = (overrides: Record<string, unknown> = {}) => ({
  protocol: "a0.browser-bridge.v1",
  contract_version: 1,
  connection_id: "connection-one",
  companion: {
    instance_id: "companion-one",
    version: "0.1.0",
    platform: "darwin",
    arch: "arm64",
  },
  server: {
    state: "paired",
    instance_id: "server-one",
    label: "Agent Zero",
  },
  limits: {
    max_json_frame_bytes: MAX_NATIVE_MESSAGE_BYTES,
    artifact_chunk_bytes: MAX_ARTIFACT_CHUNK_BYTES,
    max_artifact_bytes: MAX_ARTIFACT_BYTES,
  },
  negotiated: {
    actions: ["open"],
    features: ["tab_leases_v1", "tab_groups_v1"],
  },
  activation: {
    principal: "browser_bridge",
    bridge_id: "bridge-one",
    key_generation: 1,
    extension_id: EXTENSION_ID,
    install_instance_id: "install-one",
    server_features: [
      "browser_extension_bridge_v1",
      "connector_browser_control",
      "connector_browser_event",
    ],
    rollout: "available",
    selected_bridge: true,
    heartbeat_fresh: true,
    subject_profile_bound: true,
    legacy_control_plane_inactive: true,
  },
  ...overrides,
});

const emitHello = (fixture: ReturnType<typeof portFixture>, result = helloResult()): void => {
  fixture.messageListeners[0]({
    jsonrpc: "2.0",
    id: "hello:worker-one",
    result,
  });
};

const controllerFixture = (
  onRequest: ConstructorParameters<typeof NativePortController>[1] = async () => ({}),
  dependencies: ConstructorParameters<typeof NativePortController>[2] = {},
) => {
  const port = portFixture();
  const timers = timerFixture();
  let now = 1_000;
  let requestSequence = 0;
  const states: NativeConnectionSnapshot[] = [];
  const controller = new NativePortController(
    (snapshot) => states.push(snapshot),
    onRequest,
    {
      connectNative: () => port.port,
      extensionId: EXTENSION_ID,
      extensionVersion: "0.1.0",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      createRequestId: () => `rpc-${++requestSequence}`,
      now: () => now,
      ...dependencies,
    },
  );
  return { controller, port, timers, states, setNow: (value: number) => { now = value; } };
};

describe("NativePortController", () => {
  it("replaces an inactive production port only once and never replays pending requests", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port, helloResult({ activation: undefined }));
    expect(fixture.controller.retryProductionAdmission("stale")).toBe(false);
    const pending = fixture.controller.pairingStatus();
    const rejected = expect(pending).rejects.toBeInstanceOf(NativeConnectionError);
    expect(fixture.controller.retryProductionAdmission("connection-one")).toBe(false);
    fixture.controller.disconnect("pairing_disconnected");
    await rejected;
    expect(fixture.controller.retryProductionAdmission("connection-one")).toBe(false);
    fixture.controller.connect(helloContext());
    fixture.port.messageListeners.at(-1)!({ jsonrpc: "2.0", id: "hello:worker-one",
      result: helloResult({ connection_id: "connection-two", activation: undefined }) });
    const posted = fixture.port.postMessage.mock.calls.length;
    expect(fixture.controller.retryProductionAdmission("connection-two")).toBe(true);
    expect(fixture.controller.state.reasonCode).toBe("production_admission_retry");
    expect(fixture.controller.retryProductionAdmission("connection-two")).toBe(false);
    expect(fixture.port.postMessage.mock.calls).toHaveLength(posted);
    emitHello(fixture.port); // The detached old port cannot promote authority.
    expect(fixture.controller.state.state).toBe("disconnected");
  });

  it.each(["posted", "invalid", "send-failed", "replacement", "hook-throws"])("runs reconcile replay hook only after a valid original-port response: %s", async (mode) => {
    let release!: (value: Record<string, unknown>) => void;
    const result = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
    const order: string[] = [];
    const hook = vi.fn((method, connection) => {
      expect(method).toBe("browser.reconcile");
      expect(connection.connectionId).toBe("connection-one");
      order.push("replay");
      if (mode === "hook-throws") throw new Error("local hook failed");
    });
    const fixture = controllerFixture(async () => await result, { onResponsePosted: hook });
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    fixture.port.postMessage.mockImplementation((message) => {
      if (message.id === "reconcile-order" && message.result) {
        if (mode === "send-failed") throw new Error("port gone");
        order.push("response");
      }
    });
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0", id: "reconcile-order", method: "browser.reconcile",
      params: { contract_version: 1, control_id: "control-one", expected_contexts: [], event_cursors: [], known_control_ids: [] },
    });
    if (mode === "replacement") {
      fixture.controller.disconnect("replacement");
      fixture.controller.connect(helloContext());
      fixture.port.messageListeners.at(-1)!({
        jsonrpc: "2.0", id: "hello:worker-one", result: helloResult({ connection_id: "connection-two" }),
      });
      expect(fixture.controller.state.connectionId).toBe("connection-two");
    }
    release(mode === "invalid" ? {} : {
      contract_version: 1, control_id: "control-one", install_instance_id: "install-one",
      load_generation_id: "generation-one", leases: [], inflight_operations: [],
      terminal_action_receipts: [], pending_critical_events: [], prior_generation_orphans: [],
    });
    await result;
    // Drain the known onRequest -> handleRequest promise continuations, no clock.
    await Promise.resolve();
    await Promise.resolve();
    const posted = mode === "posted" || mode === "hook-throws";
    expect(order).toEqual(posted ? ["response", "replay"] : []);
    expect(hook).toHaveBeenCalledTimes(posted ? 1 : 0);
    if (mode === "hook-throws") {
      expect(fixture.controller.state).toEqual({ state: "blocked", reasonCode: "native_response_hook_failed" });
      const replies = fixture.port.postMessage.mock.calls.filter(([message]) => message.id === "reconcile-order");
      expect(replies).toHaveLength(1);
      expect(replies[0][0]).toHaveProperty("result");
    }
  });

  it("does not let stale request cleanup erase the replacement port's duplicate-ID fence", async () => {
    let releaseOld!: (value: Record<string, unknown>) => void;
    const oldResult = new Promise<Record<string, unknown>>((resolve) => { releaseOld = resolve; });
    const onRequest = vi.fn()
      .mockImplementationOnce(async () => await oldResult)
      .mockImplementationOnce(async () => await new Promise(() => undefined));
    const fixture = controllerFixture(onRequest);
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    const request = {
      jsonrpc: "2.0", id: "core-1", method: "browser.reconcile",
      params: { contract_version: 1, control_id: "control-one", expected_contexts: [], event_cursors: [], known_control_ids: [] },
    };
    fixture.port.messageListeners[0](request);
    fixture.controller.disconnect("replacement");
    fixture.controller.connect(helloContext());
    const currentListener = fixture.port.messageListeners.at(-1)!;
    currentListener({ jsonrpc: "2.0", id: "hello:worker-one", result: helloResult({ connection_id: "connection-two" }) });
    currentListener(request);
    expect(onRequest).toHaveBeenCalledTimes(2);
    releaseOld({}); // Old response is never decoded or posted on the new port.
    await oldResult;
    await Promise.resolve();
    await Promise.resolve();
    currentListener(request);
    expect(fixture.controller.state).toEqual({ state: "blocked", reasonCode: "native_duplicate_correlation_id" });
    expect(onRequest).toHaveBeenCalledTimes(2);
  });

  it("negotiates exact identity/capabilities before becoming activation-ready", () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());

    expect(fixture.states.map((state) => state.state)).toEqual(["connecting", "negotiating"]);
    expect(fixture.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      jsonrpc: "2.0",
      method: "bridge.hello",
      params: expect.objectContaining({
        resume: expect.objectContaining({ lease_digest: `sha256:${"0".repeat(64)}` }),
        capabilities: {
          actions: ["open"],
          features: ["tab_leases_v1", "tab_groups_v1"],
          cdp_domains: [],
        },
      }),
    }));

    emitHello(fixture.port);
    expect(fixture.controller.state).toEqual({
      state: "ready",
      reasonCode: "native_ready",
      connectionId: "connection-one",
      companionVersion: "0.1.0",
      serverState: "paired",
      reportedServerState: "paired",
      activationReady: true,
      activationBlockers: [],
      negotiatedActions: ["open"],
      negotiatedFeatures: ["tab_leases_v1", "tab_groups_v1"],
    });
    expect(fixture.timers.callbacks.size).toBe(0);
  });

  it("fails before opening a native port when local hello evidence is malformed", () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext({ leaseDigest: "not-a-digest" }));
    expect(fixture.controller.state).toEqual({ state: "blocked", reasonCode: "native_hello_context_invalid" });
    expect(fixture.port.postMessage).not.toHaveBeenCalled();
  });

  it("blocks malformed messages and ignores stale disconnect callbacks", () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    fixture.port.messageListeners[0]([{ jsonrpc: "2.0" }]);
    expect(fixture.controller.state).toEqual({ state: "blocked", reasonCode: "native_message_invalid" });
    expect(fixture.port.disconnect).toHaveBeenCalledOnce();
    fixture.port.disconnectListeners[0]();
    expect(fixture.controller.state.state).toBe("blocked");
  });

  it("rejects a hello response that arrives at or after its wall-clock deadline", () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    fixture.setNow(11_000);
    emitHello(fixture.port);
    expect(fixture.controller.state).toEqual({ state: "blocked", reasonCode: "native_hello_timeout" });
  });

  it("keeps a paired connection inactive when any activation attestation is absent", async () => {
    const onRequest = vi.fn(async () => ({ ok: true }));
    const fixture = controllerFixture(onRequest);
    fixture.controller.connect(helloContext());
    emitHello(fixture.port, helloResult({ activation: undefined }));

    expect(fixture.controller.state).toEqual(expect.objectContaining({
      state: "ready",
      reasonCode: "native_pairing_only",
      serverState: "paired_inactive",
      reportedServerState: "paired",
      activationReady: false,
      activationBlockers: expect.arrayContaining(["server_activation_unattested"]),
    }));

    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "perform-one",
      method: "browser.perform",
      params: {},
    });
    await Promise.resolve();
    expect(onRequest).not.toHaveBeenCalled();
    expect(fixture.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "perform-one",
      error: expect.objectContaining({ data: expect.objectContaining({ a0_code: "UNSUPPORTED_CAPABILITY" }) }),
    }));
  });

  it("returns a typed invalid-state response for work before negotiation", async () => {
    const fixture = controllerFixture(async () => ({ ok: true }));
    fixture.controller.connect(helloContext());
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "request-one",
      method: "browser.perform",
      params: {},
    });
    await Promise.resolve();
    expect(fixture.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "request-one",
      error: expect.objectContaining({ data: expect.objectContaining({ a0_code: "INVALID_STATE" }) }),
    }));
  });

  it("correlates simultaneous client requests and safely projects results", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);

    const pairing = fixture.controller.pairingStatus();
    const agent = fixture.controller.agentStatus();
    expect(fixture.port.postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: "rpc-1",
      method: "pairing.status",
    }));
    expect(fixture.port.postMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      id: "rpc-2",
      method: "agent.status",
    }));

    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-2",
      result: {
        contract_version: 1,
        server: { state: "reachable", version: "0.9.0", instance_id: "server-one", label: "Agent Zero" },
        active_contexts: { count: 2 },
        selected_browser_backend: { id: "extension:bridge-one", ready: true },
        policy: { mode: "ask_per_site", ready: true },
        diagnostics: [],
      },
    });
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        contract_version: 1,
        state: "paired",
        server: { label: "Agent Zero", base_origin: "http://localhost:50080" },
        companion: { version: "0.1.0" },
        diagnostics: [],
      },
    });

    await expect(agent).resolves.toEqual(expect.objectContaining({ activeContextCount: 2 }));
    await expect(pairing).resolves.toEqual(expect.objectContaining({ state: "paired" }));
    expect(fixture.timers.callbacks.size).toBe(0);
  });

  it("routes bounded context calls only across an activated native generation", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);

    const listed = fixture.controller.contextList();
    expect(fixture.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "rpc-1",
      method: "context.list",
      params: { contract_version: 1, limit: 64 },
    }));
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        contract_version: 1,
        contexts: [{
          context_id: "context-one",
          label: "Research plans",
          kind: "task",
          status: "running",
          created_at_ms: 1,
          updated_at_ms: 2,
        }],
      },
    });
    await expect(listed).resolves.toMatchObject({
      contexts: [{ contextId: "context-one", label: "Research plans" }],
    });

    const inactive = controllerFixture();
    inactive.controller.connect(helloContext());
    emitHello(inactive.port, helloResult({ activation: undefined }));
    await expect(inactive.controller.contextList()).rejects.toMatchObject({
      name: "NativeConnectionError",
      reasonCode: "native_activation_not_ready",
    });
  });

  it("correlates an activated artifact phase without adding native routing credentials", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    const binding: OutputArtifactBinding = {
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      actionId: "action-one",
      opId: "op-one",
      artifactId: "a0art1.00000000-0000-4000-8000-000000000000",
      direction: "output",
      purpose: "screenshot",
    };

    const begin = fixture.controller.artifactBegin(binding, {
      mimeType: "image/png",
      byteCount: 4,
      sha256: `sha256:${"a".repeat(64)}`,
    });
    expect(fixture.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      method: "artifact.begin",
      params: expect.not.objectContaining({ bridge_id: expect.anything(), load_generation_id: expect.anything() }),
    }));
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        contract_version: 1,
        context_id: binding.contextId,
        browser_session_id: binding.browserSessionId,
        turn_id: binding.turnId,
        action_id: binding.actionId,
        op_id: binding.opId,
        artifact_id: binding.artifactId,
        direction: "output",
        purpose: "screenshot",
        phase: "begin",
        status: "accepted",
        next_chunk_index: 0,
        received_bytes: 0,
      },
    });
    await expect(begin).resolves.toMatchObject({ phase: "begin", status: "accepted" });
  });

  it("emits critical browser events as activated notifications without an RPC acknowledgement", () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);

    fixture.controller.browserEvent({
      eventId: "event-one",
      loadGenerationId: "generation-one",
      sequence: 1,
      delivery: "critical",
      eventType: "lease.changed",
      observedAt: 10,
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      opId: null,
      actionId: null,
      data: {
        leaseIdDigest: "a".repeat(64),
        browserIdDigest: "b".repeat(64),
        state: "closed",
        ownership: "created",
        disposition: "ephemeral",
        change: "tab_closed",
        reasonCode: "TAB_CLOSED",
      },
    });

    expect(fixture.port.postMessage).toHaveBeenLastCalledWith({
      jsonrpc: "2.0",
      method: "browser.event",
      params: expect.objectContaining({
        contract_version: 1,
        event_id: "event-one",
        load_generation_id: "generation-one",
        event_sequence: 1,
        event_type: "lease.changed",
      }),
    });
  });

  it("validates and normalizes activated context notifications before dispatch", async () => {
    const onRequest = vi.fn(async () => ({ accepted: true }));
    const fixture = controllerFixture(onRequest);
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      method: "context.event",
      params: {
        contract_version: 1,
        context_id: "context-one",
        sequence: 1,
        last_sequence: 2,
        event: "message",
        data: { role: "assistant", text: "Working on it." },
      },
    });
    await vi.waitFor(() => {
      expect(onRequest).toHaveBeenCalledWith("context.event", {
        contextId: "context-one",
        sequence: 1,
        lastSequence: 2,
        event: "message",
        data: { role: "assistant", text: "Working on it." },
      });
    });

    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      method: "context.event",
      params: {
        contract_version: 1,
        context_id: "context-one",
        sequence: 2,
        last_sequence: 2,
        event: "message",
        data: { role: "assistant", text: "Unsafe additive frame." },
        api_key: "forbidden",
      },
    });
    await Promise.resolve();
    expect(onRequest).toHaveBeenCalledTimes(1);

    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "not-a-notification",
      method: "context.complete",
      params: { contract_version: 1, context_id: "context-one", status: "completed" },
    });
    await Promise.resolve();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(fixture.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "not-a-notification",
      error: expect.objectContaining({ code: -32600 }),
    }));
  });

  it("supports pairing exchange without exposing the companion credential", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    const request = fixture.controller.pairingExchange({
      pairingCode: PAIRING_CODE,
      serverBaseOrigin: "http://127.2.3.4:50080/",
    });
    expect(fixture.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      method: "pairing.exchange",
      params: {
        contract_version: 1,
        pairing_code: PAIRING_CODE,
        server_base_origin: "http://127.2.3.4:50080",
      },
    }));
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        contract_version: 1,
        state: "paired",
        bridge_id: "bridge-one",
        server: { instance_id: "server-one", label: "Agent Zero", base_origin: "http://localhost:50080" },
        scopes: [
          "bridge.connect",
          "context.list",
          "context.read",
          "context.message",
          "browser.operate",
          "browser.control",
          "browser.artifact",
          "browser.approval",
        ],
        policy: { mode: "ask_per_site", ready: true },
      },
    });
    await expect(request).resolves.toEqual(expect.objectContaining({ bridgeId: "bridge-one" }));
  });

  it("keeps full-duplex reconciliation responsive while a client request is pending", async () => {
    const fixture = controllerFixture(async (method) => {
      expect(method).toBe("browser.reconcile");
      return {
        contract_version: 1,
        control_id: "control-one",
        install_instance_id: "install-one",
        load_generation_id: "generation-one",
        leases: [],
        inflight_operations: [],
        terminal_action_receipts: [],
        pending_critical_events: [],
        prior_generation_orphans: [],
      };
    });
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    const pendingStatus = fixture.controller.pairingStatus();

    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "reconcile-one",
      method: "browser.reconcile",
      params: {
        contract_version: 1,
        control_id: "control-one",
        expected_contexts: [],
        event_cursors: [],
        known_control_ids: [],
      },
    });
    await vi.waitFor(() => {
      expect(fixture.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        id: "reconcile-one",
        result: expect.objectContaining({ terminal_action_receipts: [] }),
      }));
    });

    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        contract_version: 1,
        state: "paired",
        server: { label: "Agent Zero", base_origin: "http://localhost:50080" },
        companion: { version: "0.1.0" },
        diagnostics: [],
      },
    });
    await expect(pendingStatus).resolves.toEqual(expect.objectContaining({ state: "paired" }));
  });

  it("cancels and times out correlated calls while ignoring one bounded late response", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);

    const timedOut = fixture.controller.pairingStatus({ timeoutMs: 25 });
    fixture.timers.fireOnly();
    await expect(timedOut).rejects.toBeInstanceOf(NativeRequestTimeoutError);
    fixture.port.messageListeners[0]({ jsonrpc: "2.0", id: "rpc-1", result: { ignored: true } });
    expect(fixture.controller.state.state).toBe("ready");

    const abort = new AbortController();
    const cancelled = fixture.controller.agentStatus({ signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toBeInstanceOf(NativeRequestCancelledError);
    fixture.port.messageListeners[0]({ jsonrpc: "2.0", id: "rpc-2", result: { ignored: true } });
    expect(fixture.controller.state.state).toBe("ready");
  });

  it("uses the response-time clock check even if the timer callback was delayed", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    const status = fixture.controller.pairingStatus({ timeoutMs: 25 });
    fixture.setNow(1_025);
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-1",
      result: {
        contract_version: 1,
        state: "paired",
        server: { label: "Agent Zero", base_origin: "http://localhost:50080" },
        companion: { version: "0.1.0" },
        diagnostics: [],
      },
    });
    await expect(status).rejects.toBeInstanceOf(NativeRequestTimeoutError);
    expect(fixture.controller.state.state).toBe("ready");
  });

  it("projects remote RPC failures without forwarding raw messages or details", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    const status = fixture.controller.pairingStatus();
    fixture.port.messageListeners[0]({
      jsonrpc: "2.0",
      id: "rpc-1",
      error: {
        code: -32010,
        message: "sensitive remote message",
        data: {
          a0_code: "PAIRING_EXPIRED",
          outcome: "not_applied",
          retryable: true,
          details: { api_key: "must-not-cross" },
        },
      },
    });
    await expect(status).rejects.toMatchObject({
      name: "NativeRpcError",
      a0Code: "PAIRING_EXPIRED",
      outcome: "not_applied",
      retryable: true,
    });
  });

  it("blocks uncorrelated and schema-invalid responses", async () => {
    const uncorrelated = controllerFixture();
    uncorrelated.controller.connect(helloContext());
    emitHello(uncorrelated.port);
    uncorrelated.port.messageListeners[0]({ jsonrpc: "2.0", id: "unknown", result: {} });
    expect(uncorrelated.controller.state).toEqual({ state: "blocked", reasonCode: "native_response_uncorrelated" });

    const malformed = controllerFixture();
    malformed.controller.connect(helloContext());
    emitHello(malformed.port);
    const status = malformed.controller.pairingStatus();
    malformed.port.messageListeners[0]({ jsonrpc: "2.0", id: "rpc-1", result: { state: "paired" } });
    await expect(status).rejects.toBeInstanceOf(NativeConnectionError);
    expect(malformed.controller.state).toEqual({ state: "blocked", reasonCode: "native_response_schema_invalid" });
  });

  it("blocks duplicate live inbound IDs and invalid local reconciliation projection", async () => {
    let release: (() => void) | undefined;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const duplicate = controllerFixture(async () => {
      await deferred;
      return {
        contract_version: 1,
        control_id: "control-one",
        install_instance_id: "install-one",
        load_generation_id: "generation-one",
        leases: [],
        inflight_operations: [],
        terminal_action_receipts: [],
        pending_critical_events: [],
        prior_generation_orphans: [],
      };
    });
    duplicate.controller.connect(helloContext());
    emitHello(duplicate.port);
    const reconcile = {
      jsonrpc: "2.0",
      id: "reconcile-one",
      method: "browser.reconcile" as const,
      params: {
        contract_version: 1,
        control_id: "control-one",
        expected_contexts: [],
        event_cursors: [],
        known_control_ids: [],
      },
    };
    duplicate.port.messageListeners[0](reconcile);
    duplicate.port.messageListeners[0](reconcile);
    expect(duplicate.controller.state).toEqual({ state: "blocked", reasonCode: "native_duplicate_correlation_id" });
    release?.();

    const invalid = controllerFixture(async () => ({
      contract_version: 1,
      control_id: "control-one",
      install_instance_id: "install-one",
      load_generation_id: "generation-one",
      leases: [],
      inflight_operations: [],
      pending_critical_events: [],
      prior_generation_orphans: [],
    }));
    invalid.controller.connect(helloContext());
    emitHello(invalid.port);
    invalid.port.messageListeners[0]({ ...reconcile, id: "reconcile-two" });
    await vi.waitFor(() => {
      expect(invalid.controller.state).toEqual({ state: "blocked", reasonCode: "native_local_schema_invalid" });
    });
  });

  it("rejects pending client calls when the native port disconnects", async () => {
    const fixture = controllerFixture();
    fixture.controller.connect(helloContext());
    emitHello(fixture.port);
    const pending = fixture.controller.pairingStatus();
    fixture.port.disconnectListeners[0]();
    await expect(pending).rejects.toMatchObject({
      name: "NativeConnectionError",
      reasonCode: "native_port_disconnected",
    });
    expect(fixture.controller.state).toEqual({ state: "disconnected", reasonCode: "native_port_disconnected" });
  });
});
