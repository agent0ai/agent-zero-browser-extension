import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("../build-channel", async (original) => {
  const module = await original<typeof import("../build-channel")>();
  return { ...module, BUILD_CHANNEL: module.buildChannelForMode("local-development") };
});
import { DEVELOPMENT_EXTENSION_ID } from "../build-channel";
import { LIMITED_BROWSER_ACTIONS, LIMITED_BROWSER_FEATURES, parseDevelopmentAdmission } from "./development-admission";
import { evaluateActivation, evaluateDevelopmentAdmission, parseHelloResult } from "./native";
import { browserConnectionAuthorityKey, canReconnectDevelopmentBrowser, NativePortController, type NativeConnectionSnapshot } from "../background/native-port";
import { BrowserRuntime } from "../background/browser-runtime";
import type { RuntimeStore } from "../background/runtime-store";
import { parseRuntimePresentation, runtimeStateLabel } from "../lib/runtime-presentation";

const admission = () => ({
  contract: "a0.browser-bridge.development-runtime.v1", channel: "local-development", mode: "limited_runtime",
  transports: ["control", "critical_event", "operation"], selection_scope: "explicit_context_bridge",
  server_instance_id: "server-one", bridge_id: "bridge-one", key_generation: 1,
  extension_id: DEVELOPMENT_EXTENSION_ID, install_instance_id: "install-one", load_generation_id: "generation-one",
});
const hello = () => ({
  protocol: "a0.browser-bridge.v1", contract_version: 1, connection_id: "connection-one",
  companion: { instance_id: "companion-one", version: "2.12.0", platform: "darwin", arch: "arm64" },
  server: { state: "paired", instance_id: "server-one", label: "Agent Zero" },
  limits: { max_json_frame_bytes: 786432, artifact_chunk_bytes: 196608, max_artifact_bytes: 26214400 },
  negotiated: { actions: [...LIMITED_BROWSER_ACTIONS], features: [...LIMITED_BROWSER_FEATURES] },
  development_admission: admission(),
});
const local = {
  extensionIdentityApproved: false, storageMigrationState: "v1_ready" as const, chromePermissionsReady: true,
  legacyControlPlaneInactive: false, operationalMethodSurfaceReady: false,
};
const expected = {
  extensionId: DEVELOPMENT_EXTENSION_ID, installInstanceId: "install-one", loadGenerationId: "generation-one",
  actions: [...LIMITED_BROWSER_ACTIONS], features: [...LIMITED_BROWSER_FEATURES], browserVersion: "146.0.0.0",
};
const connection = (): NativeConnectionSnapshot => ({
  state: "ready", connectionId: "connection-one", reasonCode: "development_reconciliation_pending",
  reportedServerState: "paired", activationReady: false, limitedTransportReady: true,
  developmentAdmission: parseDevelopmentAdmission(admission()),
  negotiatedActions: [...LIMITED_BROWSER_ACTIONS], negotiatedFeatures: [...LIMITED_BROWSER_FEATURES],
});

describe("limited development admission", () => {
  it("consumes the exact shared Core admission without enabling production", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/limited-development-runtime-v1.json", import.meta.url), "utf8"));
    const host = fixture.ack.host_browser;
    const wire = {
      ...hello(), companion: host.companion,
      server: { state: "paired", instance_id: fixture.ack.connector_binding.server_instance_id, label: "Agent Zero" },
      negotiated: { actions: host.capabilities.actions, features: host.capabilities.features },
      development_admission: fixture.ack.development_admission,
    };
    const parsed = parseHelloResult(wire);
    const identity = { ...expected, installInstanceId: host.extension.install_instance_id,
      loadGenerationId: host.extension.load_generation_id };
    expect(parsed.developmentAdmission).toEqual(fixture.ack.development_admission);
    expect(evaluateDevelopmentAdmission(parsed, local, identity)).toBe(true);
    expect(evaluateActivation(parsed, local, identity).ready).toBe(false);
    expect(parsed.developmentAdmission).not.toHaveProperty("connector_sid");
  });

  it("validates exactly eleven fields and fixed transports without production activation", () => {
    const parsed = parseHelloResult(hello());
    expect(Object.keys(parsed.developmentAdmission!)).toHaveLength(11);
    expect(evaluateDevelopmentAdmission(parsed, local, expected)).toBe(true);
    expect(evaluateActivation(parsed, local, expected).ready).toBe(false);
    for (const invalid of [
      { ...admission(), extra: false }, { ...admission(), connector_session_ready: true },
      { ...admission(), transports: ["operation", "control", "critical_event"] },
      { ...admission(), transports: ["control", "critical_event", "operation", "artifact"] },
      { ...admission(), key_generation: 0 }, { ...admission(), key_generation: true },
      { ...admission(), extension_id: "a".repeat(32) }, { ...admission(), mode: "complete_runtime" },
    ]) expect(() => parseHelloResult({ ...hello(), development_admission: invalid })).toThrow();
    expect(() => parseHelloResult({ ...hello(), activation: null })).toThrow();
    expect(() => parseHelloResult({ ...hello(), development: {} })).toThrow();
    expect(() => parseHelloResult({ ...hello(), server: { ...hello().server, instance_id: "other" } })).toThrow();
    expect(() => parseHelloResult({ ...hello(), negotiated: { ...hello().negotiated, actions: [...LIMITED_BROWSER_ACTIONS, "click"] } })).toThrow();
  });

  it("requires signed installation/load, local permissions/storage, Chrome and companion floor", () => {
    const parsed = parseHelloResult(hello());
    for (const fields of [{ installInstanceId: "other" }, { loadGenerationId: "other" }, { extensionId: "a".repeat(32) }, { browserVersion: "119.0.0.0" }]) {
      expect(evaluateDevelopmentAdmission(parsed, local, { ...expected, ...fields })).toBe(false);
    }
    expect(evaluateDevelopmentAdmission(parsed, { ...local, chromePermissionsReady: false }, expected)).toBe(false);
    expect(evaluateDevelopmentAdmission(parsed, { ...local, storageMigrationState: "blocked" }, expected)).toBe(false);
    expect(evaluateDevelopmentAdmission(parseHelloResult({ ...hello(), companion: { ...hello().companion, version: "2.11.9" } }), local, expected)).toBe(false);
  });

  it("retains limited native transport, permits reconcile, and denies context/artifacts", async () => {
    let receive!: (value: unknown) => void;
    const postMessage = vi.fn();
    const onRequest = vi.fn(async () => ({
      contract_version: 1, control_id: "control-one", install_instance_id: "install-one", load_generation_id: "generation-one",
      leases: [], inflight_operations: [], terminal_action_receipts: [], pending_critical_events: [], prior_generation_orphans: [],
    }));
    const controller = new NativePortController(() => undefined, onRequest, {
      connectNative: () => ({ postMessage, disconnect: vi.fn(), onMessage: { addListener: (listener: typeof receive) => { receive = listener; } }, onDisconnect: { addListener: vi.fn() } }) as unknown as chrome.runtime.Port,
      extensionId: DEVELOPMENT_EXTENSION_ID, extensionVersion: "0.1.0", setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>, clearTimer: vi.fn(),
    });
    controller.connect({ ...expected, workerBootId: "worker-one", leaseDigest: `sha256:${"0".repeat(64)}`, inflightOpIds: [], lastAckedEventSequence: 0, browserFamily: "chrome", activationEvidence: local });
    receive({ jsonrpc: "2.0", id: "hello:worker-one", result: hello() });
    expect(controller.state.activationReady).toBe(false);
    expect(controller.state.limitedTransportReady).toBe(true);
    const cloned = controller.state;
    cloned.developmentAdmission!.transports[0] = "operation" as "control";
    expect(controller.state.developmentAdmission!.transports[0]).toBe("control");
    receive({ jsonrpc: "2.0", id: "reconcile-one", method: "browser.reconcile", params: { contract_version: 1, control_id: "control-one", expected_contexts: [], event_cursors: [], known_control_ids: [] } });
    await Promise.resolve();
    await Promise.resolve();
    expect(onRequest).toHaveBeenCalledOnce();
    receive({ jsonrpc: "2.0", method: "context.event", params: {} });
    receive({ jsonrpc: "2.0", id: "artifact-one", method: "artifact.begin", params: {} });
    expect(onRequest).toHaveBeenCalledOnce();
    await expect(controller.contextList()).rejects.toThrow("unavailable");
    controller.disconnect("test-end");
    expect(browserConnectionAuthorityKey(controller.state)).toBeNull();
  });

  it("requires both current and persisted limited authority and never advertises excluded actions", async () => {
    let live = connection();
    const snapshot = {
      lifecycle: { phase: "READY", installInstanceId: "install-one", loadGenerationId: "generation-one", workerBootId: "worker-one" },
      session: { connection: connection(), browserInstanceId: "browser-one", leasesByHandle: {} },
    };
    const store = { snapshot } as unknown as RuntimeStore;
    const runtime = new BrowserRuntime(store, undefined, undefined, undefined, undefined, undefined, () => live);
    const params = { contract_version: 1, op_id: "op-one", action_id: null, context_id: null, browser_session_id: null, turn_id: null,
      action: "status", args: {}, timeout_ms: 1000, required_capabilities: [], policy: { origin_grant_id: null, action_grant_id: null }, display: { cursor: false, foreground: false } };
    const result = await runtime.perform(params);
    expect((result.result as Record<string, unknown>).actions).toEqual([...LIMITED_BROWSER_ACTIONS]);
    expect((result.result as Record<string, unknown>).capabilities).toEqual([...LIMITED_BROWSER_FEATURES]);
    snapshot.lifecycle.phase = "RECONCILING";
    await expect(runtime.perform(params)).rejects.toMatchObject({ a0Code: "CONNECTION_LOST" });
    snapshot.lifecycle.phase = "READY";
    live = { ...connection(), connectionId: "replacement" };
    await expect(runtime.perform(params)).rejects.toMatchObject({ a0Code: "CONNECTION_LOST" });
    live = { ...connection(), limitedTransportReady: false };
    await expect(runtime.perform(params)).rejects.toMatchObject({ a0Code: "CONNECTION_LOST" });
    live = connection();
    snapshot.session.connection.developmentAdmission!.bridge_id = "other";
    await expect(runtime.perform(params)).rejects.toMatchObject({ a0Code: "CONNECTION_LOST" });
    expect(browserConnectionAuthorityKey({ ...connection(), activationReady: true })).toBeNull();
  });

  it("presents limited readiness only after reconcile and offers reconnect only while paired inactive", () => {
    const inactive = { ...connection(), limitedTransportReady: false };
    expect(canReconnectDevelopmentBrowser(inactive)).toBe(true);
    expect(canReconnectDevelopmentBrowser(connection())).toBe(false);
    expect(canReconnectDevelopmentBrowser({ ...inactive, reportedServerState: "unpaired" })).toBe(false);
    const state = { ready: false, limitedBrowserReady: true, bridge: { phase: "READY", connection: connection() } };
    const parsed = parseRuntimePresentation(state);
    expect(parsed.ready).toBe(false);
    expect(runtimeStateLabel(parsed)).toBe("Development limited browser control");
    expect(parseRuntimePresentation({ ...state, bridge: { ...state.bridge, phase: "RECONCILING" } }).limitedBrowserReady).toBe(false);
  });
});
