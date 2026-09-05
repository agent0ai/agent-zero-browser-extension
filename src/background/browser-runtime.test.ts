import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserRuntime, BROWSER_RUNTIME_ACTIONS, BROWSER_RUNTIME_CAPABILITIES, type ArtifactOutputTransport } from "./browser-runtime";
import type { OutputArtifactBinding } from "../protocol/artifacts";
import { inputArtifactParams, parseInputArtifact } from "./input-artifact";
import { ChromeScreenshotDebuggerHost } from "./debugger-host";
import { createGroupRegistry } from "./groups";
import {
  createDurableLeaseShadow,
  createDurableSafetyLedger,
  resetLedgerGeneration,
  upsertDurableLease,
  type DurableSafetyLedger,
} from "./journal";
import { createLease, type TabLease } from "./leases";
import {
  createInstallInstanceId,
  createLoadGenerationId,
  createTabHandle,
  createWorkerBootId,
  persistedLifecycleProjection,
  type LifecycleState,
} from "./lifecycle";
import { RuntimeStore, type RuntimeSessionProjection, type RuntimeStoreSnapshot } from "./runtime-store";

const entropy = (byte: number) => (length: number) => new Uint8Array(length).fill(byte);

type RuntimeDependencies = ConstructorParameters<typeof BrowserRuntime> extends [RuntimeStore, ...infer Rest] ? Rest : never;
class TestBrowserRuntime extends BrowserRuntime {
  constructor(store: RuntimeStore, ...dependencies: RuntimeDependencies) {
    super(store, dependencies[0], dependencies[1], dependencies[2], dependencies[3], dependencies[4],
      dependencies[5] ?? (() => store.snapshot.session.connection));
  }
}

class FakeRuntimeStore {
  constructor(public snapshot: RuntimeStoreSnapshot) {}

  async updateLedger(reducer: (ledger: DurableSafetyLedger) => DurableSafetyLedger) {
    this.snapshot = { ...this.snapshot, ledger: reducer(this.snapshot.ledger) };
    return this.snapshot;
  }

  async updateSession(reducer: (session: RuntimeSessionProjection) => RuntimeSessionProjection) {
    this.snapshot = { ...this.snapshot, session: reducer(this.snapshot.session) };
    return this.snapshot;
  }

  async updateBoth(reducer: (snapshot: RuntimeStoreSnapshot) => RuntimeStoreSnapshot) {
    this.snapshot = reducer(this.snapshot);
    return this.snapshot;
  }
}

const lifecycleFixture = (): LifecycleState => ({
  schemaVersion: 1,
  contract: "a0.browser-bridge.mv3-runtime.v1",
  installInstanceId: createInstallInstanceId(entropy(1)),
  loadGenerationId: createLoadGenerationId(entropy(2)),
  workerBootId: createWorkerBootId(entropy(3)),
  revision: 2,
  phase: "READY",
});

const snapshotFixture = (): RuntimeStoreSnapshot => {
  const lifecycle = lifecycleFixture();
  let ledger = createDurableSafetyLedger(lifecycle.installInstanceId);
  const reset = resetLedgerGeneration(ledger, {
    expectedRevision: ledger.revision,
    loadGenerationId: lifecycle.loadGenerationId,
    now: 1,
  });
  if (!reset.ok) throw new Error(reset.code);
  ledger = reset.ledger;
  return {
    lifecycle,
    ledger,
    activationEvidence: {
      schemaVersion: 1,
      storageMigrationState: "v1_ready",
      legacyControlPlaneInactive: true,
      legacyStorageKeyRemoved: "agent-zero-chrome-background",
    },
    session: {
      schemaVersion: 1,
      projectionRevision: 0,
      lifecycle: persistedLifecycleProjection(lifecycle),
      phase: "READY",
      browserInstanceId: "browser-one",
      leasesByHandle: {},
      groups: createGroupRegistry(),
      connection: {
        state: "ready",
        reasonCode: "native_ready",
        serverState: "paired",
        activationReady: true,
        connectionId: "connection-one",
        negotiatedActions: [...BROWSER_RUNTIME_ACTIONS],
        negotiatedFeatures: [...BROWSER_RUNTIME_CAPABILITIES],
      },
      lastAckedEventSequence: 0,
      reconnectAttempt: 0,
      nextReconnectAtMs: null,
      stagedCandidate: null,
      finalizedTurns: [],
      finalizationControls: [],
      pendingChallenges: [],
    },
  };
};

const performParams = (overrides: Record<string, unknown> = {}) => ({
  contract_version: 1,
  op_id: "op-one",
  action_id: "action-one",
  context_id: "context-one",
  browser_session_id: "session-one",
  turn_id: "turn-one",
  action: "open",
  args: { url: "https://example.com/path?private=value", task_title: "Research" },
  timeout_ms: 120_000,
  required_capabilities: ["tab_leases_v1", "tab_groups_v1"],
  policy: { origin_grant_id: "origin-grant-one", action_grant_id: null },
  display: { cursor: false, foreground: false },
  ...overrides,
});

const cancelParams = (overrides: Record<string, unknown> = {}) => ({
  contract_version: 1,
  control_id: "control-cancel",
  op_id: "op-one",
  action_id: "action-one",
  context_id: "context-one",
  browser_session_id: "session-one",
  turn_id: "turn-one",
  reason: "turn stopped",
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function addLease(
  snapshot: RuntimeStoreSnapshot,
  input: { byte: number; providerTabId: number; origin: "created" | "claimed"; contextId?: string },
): Promise<RuntimeStoreSnapshot> {
  const tabHandle = createTabHandle(snapshot.lifecycle.loadGenerationId, entropy(input.byte));
  const lease = createLease({
    tabHandle,
    loadGenerationId: snapshot.lifecycle.loadGenerationId,
    contextId: input.contextId || "context-one",
    browserSessionId: "session-one",
    turnId: "turn-one",
    origin: input.origin,
    disposition: "ephemeral",
    siteOrigin: "https://example.com",
    identity: {
      browserInstanceId: snapshot.session.browserInstanceId,
      providerTabId: input.providerTabId,
      providerWindowId: 4,
      documentId: null,
      documentEpoch: 0,
    },
  });
  const digest = async (value: string) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const shadow = createDurableLeaseShadow({
    lease,
    rawUrl: "https://example.com/path?not-stored=yes",
    leaseIdDigest: await digest(lease.leaseId),
    leaseHandleDigest: await digest(lease.tabHandle),
    exactIdentityDigest: await digest(JSON.stringify(lease.identity)),
    digestPath: () => "0".repeat(64),
    now: 2,
  });
  const durable = upsertDurableLease(snapshot.ledger, {
    expectedRevision: snapshot.ledger.revision,
    shadow,
    now: 2,
  });
  if (!durable.ok) throw new Error(durable.code);
  return {
    ...snapshot,
    ledger: durable.ledger,
    session: {
      ...snapshot.session,
      leasesByHandle: { ...snapshot.session.leasesByHandle, [lease.tabHandle]: lease },
    },
  };
}

describe("leased browser runtime", () => {
  const tabsCreate = vi.fn();
  const tabsGroup = vi.fn();
  const tabsGet = vi.fn();
  const tabsRemove = vi.fn();
  const tabsUngroup = vi.fn();
  const tabsUpdate = vi.fn();
  const tabGroupsUpdate = vi.fn();
  const alarmsClear = vi.fn();
  const alarmsCreate = vi.fn();
  const debuggerAttach = vi.fn();
  const debuggerSendCommand = vi.fn();
  const debuggerDetach = vi.fn();
  const priorChrome = globalThis.chrome;

  beforeEach(() => {
    vi.clearAllMocks();
    tabsCreate.mockResolvedValue({ id: 7, windowId: 4, url: "https://example.com/path?private=value" });
    tabsGroup.mockResolvedValue(11);
    tabsGet.mockImplementation(async (tabId: number) => ({ id: tabId, windowId: 4, groupId: 11, url: "https://example.com" }));
    tabsRemove.mockResolvedValue(undefined);
    tabsUngroup.mockResolvedValue(undefined);
    tabsUpdate.mockResolvedValue({ id: 8, windowId: 4, url: "https://example.com/next" });
    tabGroupsUpdate.mockResolvedValue({ id: 11 });
    alarmsClear.mockResolvedValue(true);
    debuggerAttach.mockResolvedValue(undefined);
    debuggerSendCommand.mockResolvedValue({ data: "AQIDBA==" });
    debuggerDetach.mockResolvedValue(undefined);
    globalThis.chrome = {
      tabs: {
        create: tabsCreate,
        group: tabsGroup,
        get: tabsGet,
        remove: tabsRemove,
        ungroup: tabsUngroup,
        update: tabsUpdate,
      },
      tabGroups: { TAB_GROUP_ID_NONE: -1, update: tabGroupsUpdate },
      alarms: { clear: alarmsClear, create: alarmsCreate },
      debugger: {
        attach: debuggerAttach,
        sendCommand: debuggerSendCommand,
        detach: debuggerDetach,
      },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    globalThis.chrome = priorChrome;
  });

  it.each(["status", "ensure"])("reports only the negotiated and feature-supported subset for %s", async (action) => {
    const store = new FakeRuntimeStore(snapshotFixture());
    store.snapshot.session.connection.negotiatedActions = [action, "list", "open", "type", "not_implemented"];
    store.snapshot.session.connection.negotiatedFeatures = ["tab_leases_v1", "not_implemented"];
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const result = await runtime.perform(performParams({ action, args: {}, required_capabilities: [] }));
    expect(result.result).toMatchObject({ actions: ["list", action], capabilities: ["tab_leases_v1"] });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["open", "tab_groups_v1"], ["list", "tab_leases_v1"], ["state", "tab_leases_v1"],
    ["navigate", "tab_leases_v1"], ["content", "semantic_dom_v1"], ["scroll", "semantic_dom_v1"],
    ["hover", "trusted_input_v1"], ["click", "cursor_v1"], ["type", "trusted_input_v1"],
    ["screenshot", "screenshots_v1"], ["screenshot", "artifacts_v1"],
  ])("requires inherent %s/%s support even when caller requirements are empty", async (action, feature) => {
    const store = new FakeRuntimeStore(snapshotFixture());
    store.snapshot.session.connection.negotiatedFeatures = BROWSER_RUNTIME_CAPABILITIES.filter((item) => item !== feature);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    await expect(runtime.perform(performParams({ action, required_capabilities: [] })))
      .rejects.toMatchObject({ a0Code: "UNSUPPORTED_CAPABILITY", outcome: "not_applied" });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(tabsGet).not.toHaveBeenCalled();
    expect(debuggerAttach).not.toHaveBeenCalled();
  });

  it.each(["action", "feature", "action_alias", "activation", "identity", "missing_negotiation"])("fails closed on unavailable entry %s", async (kind) => {
    const store = new FakeRuntimeStore(snapshotFixture());
    const connection = store.snapshot.session.connection;
    if (kind === "action") connection.negotiatedActions = ["status"];
    if (kind === "feature") connection.negotiatedFeatures = ["tab_leases_v1", "tab_groups_v1"];
    if (kind === "action_alias") connection.negotiatedActions = ["open"];
    if (kind === "activation") connection.activationReady = false;
    if (kind === "identity") delete connection.connectionId;
    if (kind === "missing_negotiation") { delete connection.negotiatedActions; delete connection.negotiatedFeatures; }
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    await expect(runtime.perform(performParams({ required_capabilities: kind === "feature" ? ["cursor_v1"] : kind === "action_alias" ? ["navigate"] : [] })))
      .rejects.toMatchObject({ a0Code: ["activation", "identity"].includes(kind) ? "CONNECTION_LOST" : "UNSUPPORTED_CAPABILITY", outcome: "not_applied" });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(store.snapshot.ledger.operations).toEqual([]);
  });

  it.each(["connection", "generation", "worker", "action", "feature", "activation"])("rechecks queued work against its original %s authority", async (kind) => {
    const snapshot = await addLease(snapshotFixture(), { byte: 15, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const read = deferred<chrome.tabs.Tab>();
    tabsGet.mockReturnValueOnce(read.promise);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const first = runtime.perform(performParams({ action: "state", target: { tab_handle: handle }, args: {}, required_capabilities: [] })).catch((error) => error);
    await vi.waitFor(() => expect(tabsGet).toHaveBeenCalledTimes(1));
    const second = runtime.perform(performParams({ action: "navigate", op_id: "op-second", action_id: "action-second", target: { tab_handle: handle }, args: { url: "https://example.com/next" }, required_capabilities: [] })).catch((error) => error);
    const connection = store.snapshot.session.connection;
    if (kind === "connection") connection.connectionId = "connection-two";
    if (kind === "generation") store.snapshot.lifecycle.loadGenerationId = createLoadGenerationId(entropy(4));
    if (kind === "worker") store.snapshot.lifecycle.workerBootId = createWorkerBootId(entropy(4));
    if (kind === "action") connection.negotiatedActions = ["status"];
    if (kind === "feature") connection.negotiatedFeatures = [];
    if (kind === "activation") connection.activationReady = false;
    read.resolve({ id: 8, windowId: 4, url: "https://example.com/" } as chrome.tabs.Tab);
    const code = ["action", "feature"].includes(kind) ? "UNSUPPORTED_CAPABILITY" : "CONNECTION_LOST";
    expect(await first).toMatchObject({ a0Code: code, outcome: "not_applied" });
    expect(await second).toMatchObject({ a0Code: code, outcome: "not_applied" });
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(tabsRemove).not.toHaveBeenCalled();
    expect(store.snapshot.ledger.operations).toEqual([]);
  });

  it("rechecks negotiation after journal persistence and before opening a tab", async () => {
    const store = new FakeRuntimeStore(snapshotFixture());
    const persisted = deferred<void>();
    const updateLedger = store.updateLedger.bind(store);
    const write = vi.spyOn(store, "updateLedger").mockImplementationOnce(async (reducer) => {
      await updateLedger(reducer);
      await persisted.promise;
      return store.snapshot;
    });
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const operation = runtime.perform(performParams()).catch((error) => error);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    store.snapshot.session.connection.negotiatedFeatures = ["tab_leases_v1"];
    persisted.resolve();
    expect(await operation).toMatchObject({ a0Code: "UNSUPPORTED_CAPABILITY", outcome: "not_applied" });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it.each(["activation", "connection", "capability"])("rejects synchronous native %s loss while the persisted snapshot still appears ready", async (change) => {
    const store = new FakeRuntimeStore(snapshotFixture());
    const current = { ...store.snapshot.session.connection };
    const persisted = deferred<void>();
    const updateLedger = store.updateLedger.bind(store);
    const write = vi.spyOn(store, "updateLedger").mockImplementationOnce(async (reducer) => {
      await updateLedger(reducer);
      await persisted.promise;
      return store.snapshot;
    });
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore, undefined, undefined, undefined, undefined, undefined, () => current);
    const operation = runtime.perform(performParams()).catch((error) => error);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    if (change === "activation") current.activationReady = false;
    if (change === "connection") current.connectionId = "replacement-connection";
    if (change === "capability") current.negotiatedFeatures = ["tab_leases_v1"];
    expect(store.snapshot.session.connection.activationReady).toBe(true);
    expect(store.snapshot.session.connection.connectionId).toBe("connection-one");
    expect(store.snapshot.session.connection.negotiatedFeatures).toContain("tab_groups_v1");
    persisted.resolve();
    expect(await operation).toMatchObject({ a0Code: change === "capability" ? "UNSUPPORTED_CAPABILITY" : "CONNECTION_LOST", outcome: "not_applied" });
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("does not group, adopt, or roll back a just-created tab after connection replacement", async () => {
    const store = new FakeRuntimeStore(snapshotFixture());
    const created = deferred<chrome.tabs.Tab>();
    tabsCreate.mockReturnValueOnce(created.promise);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const operation = runtime.perform(performParams()).catch((error) => error);
    await vi.waitFor(() => expect(tabsCreate).toHaveBeenCalledTimes(1));
    store.snapshot.session.connection.connectionId = "connection-two";
    created.resolve({ id: 7, windowId: 4 } as chrome.tabs.Tab);
    expect(await operation).toMatchObject({ a0Code: "CONNECTION_LOST", outcome: "unknown" });
    expect(tabsGroup).not.toHaveBeenCalled();
    expect(tabGroupsUpdate).not.toHaveBeenCalled();
    expect(tabsRemove).not.toHaveBeenCalled();
    expect(store.snapshot.session.leasesByHandle).toEqual({});
    expect(store.snapshot.ledger.operations[0]).toMatchObject({ stage: "outcome_unknown" });
  });

  it("journals, leases, and groups an exact agent-created tab before success", async () => {
    const store = new FakeRuntimeStore(snapshotFixture());
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);

    const result = await runtime.perform(performParams());

    expect(result.status).toBe("succeeded");
    expect(result.result).toMatchObject({
      lease_id: expect.stringMatching(/^a0l1\./u),
      browser_id: expect.stringMatching(/^a0t1\./u),
      tab_handle: expect.stringMatching(/^a0t1\./u),
    });
    expect(tabsCreate).toHaveBeenCalledWith({
      url: "https://example.com/path?private=value",
      active: false,
    });
    expect(tabsGroup).toHaveBeenCalledWith({ tabIds: 7, createProperties: { windowId: 4 } });
    expect(tabGroupsUpdate).toHaveBeenCalledWith(11, { title: "Research", color: "cyan" });
    expect(Object.values(store.snapshot.session.leasesByHandle)).toEqual([
      expect.objectContaining({ origin: "created", disposition: "ephemeral", providerGroupId: 11 }),
    ]);
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({ actionId: "action-one", stage: "succeeded" }),
    ]);
    expect(store.snapshot.ledger.leases[0].urlIdentity).toEqual({
      origin: "https://example.com",
      pathDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(store.snapshot.ledger.criticalEvents).toEqual([
      expect.objectContaining({
        sequence: 1,
        eventType: "lease.changed",
        opId: "op-one",
        actionId: "action-one",
        data: expect.objectContaining({
          state: "active",
          change: "created",
          reasonCode: null,
        }),
      }),
    ]);
    expect(JSON.stringify(store.snapshot.ledger)).not.toContain("private=value");
    expect(JSON.stringify(store.snapshot.ledger)).not.toContain(
      Object.values(store.snapshot.session.leasesByHandle)[0].leaseId,
    );
  });

  it("captures an exact leased viewport and returns only its verified artifact descriptor after cleanup", async () => {
    const snapshot = await addLease(snapshotFixture(), {
      byte: 41,
      providerTabId: 41,
      origin: "created",
    });
    const store = new FakeRuntimeStore(snapshot);
    const lease = Object.values(snapshot.session.leasesByHandle)[0];
    store.snapshot = {
      ...store.snapshot,
      session: {
        ...store.snapshot.session,
        leasesByHandle: {
          ...store.snapshot.session.leasesByHandle,
          [lease.tabHandle]: {
            ...lease,
            identity: { ...lease.identity, documentId: "document-41", documentEpoch: 1 },
            overlayAttached: true,
            revision: lease.revision + 1,
          },
        },
      },
    };
    const phases: string[] = [];
    let metadata: { mimeType: string; byteCount: number; sha256: string } | null = null;
    const debuggerHost = new ChromeScreenshotDebuggerHost();
    const artifactTransport: ArtifactOutputTransport = {
      artifactBegin: vi.fn(async (binding: OutputArtifactBinding, nextMetadata: NonNullable<typeof metadata>) => {
        phases.push("begin");
        metadata = nextMetadata;
        return {
          ...binding,
          direction: "output" as const,
          purpose: "screenshot" as const,
          phase: "begin" as const,
          status: "accepted" as const,
          nextChunkIndex: 0,
          receivedBytes: 0,
        };
      }),
      artifactChunk: vi.fn(async (binding: OutputArtifactBinding, chunkIndex: number, data: string) => {
        phases.push("chunk");
        return {
          ...binding,
          direction: "output" as const,
          purpose: "screenshot" as const,
          phase: "chunk" as const,
          status: "accepted" as const,
          nextChunkIndex: chunkIndex + 1,
          receivedBytes: atob(data).length,
        };
      }),
      artifactEnd: vi.fn(async (binding: OutputArtifactBinding) => {
        phases.push("end");
        if (!metadata) throw new Error("missing metadata");
        return {
          ...binding,
          direction: "output" as const,
          purpose: "screenshot" as const,
          phase: "end" as const,
          status: "complete" as const,
          descriptor: {
            artifact_id: binding.artifactId,
            mime_type: metadata.mimeType,
            byte_count: metadata.byteCount,
            sha256: metadata.sha256,
            purpose: "screenshot" as const,
          },
        };
      }),
      artifactAbort: vi.fn(async () => { throw new Error("abort not expected"); }),
    };
    const contentHost = {
      bind: vi.fn(),
      command: vi.fn(async () => ({ result: { state: "cancelled" } })),
      release: vi.fn(async () => undefined),
    };
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      contentHost as unknown as import("./content-host").ContentRuntimeHost,
      { publishPersisted: vi.fn() },
      debuggerHost,
      artifactTransport,
    );

    const result = await runtime.perform(performParams({
      action: "screenshot",
      target: { tab_handle: lease.tabHandle },
      args: { format: "jpeg", quality: 80 },
      required_capabilities: ["screenshots_v1", "artifacts_v1"],
    }));

    expect(debuggerAttach).toHaveBeenCalledWith({ tabId: 41 }, "1.3");
    expect(contentHost.command).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ documentId: "document-41" }),
    }), expect.objectContaining({ command: { name: "cursor.cancel", reason: "pause" } }));
    expect(debuggerSendCommand).toHaveBeenCalledWith(
      { tabId: 41 },
      "Page.captureScreenshot",
      { format: "jpeg", quality: 80, fromSurface: true, captureBeyondViewport: false },
    );
    expect(debuggerDetach).toHaveBeenCalledWith({ tabId: 41 });
    expect(phases).toEqual(["begin", "chunk", "end"]);
    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        lease_id: lease.leaseId,
        browser_id: lease.tabHandle,
        tab_handle: lease.tabHandle,
        artifact_id: expect.stringMatching(/^a0art1\./u),
      },
      artifacts: [{
        artifact_id: expect.stringMatching(/^a0art1\./u),
        mime_type: "image/jpeg",
        byte_count: 4,
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        purpose: "screenshot",
      }],
    });
    expect(store.snapshot.session.leasesByHandle[lease.tabHandle].debuggerAttached).toBe(false);
    expect(JSON.stringify(store.snapshot)).not.toContain("AQIDBA==");
    expect(artifactTransport.artifactAbort).not.toHaveBeenCalled();
  });

  it("lists only leases belonging to the requesting Agent Zero task", async () => {
    let snapshot = await addLease(snapshotFixture(), { byte: 4, providerTabId: 8, origin: "created" });
    snapshot = await addLease(snapshot, { byte: 5, providerTabId: 9, origin: "created", contextId: "other-context" });
    const store = new FakeRuntimeStore(snapshot);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);

    const result = await runtime.perform(performParams({
      action: "list",
      args: {},
      required_capabilities: ["tab_leases_v1"],
    }));

    expect((result.result as { tabs: unknown[] }).tabs).toHaveLength(1);
    expect((result.result as { tabs: Record<string, unknown>[] }).tabs[0]).toMatchObject({
      lease_id: expect.stringMatching(/^a0l1\./u),
      browser_id: expect.stringMatching(/^a0t1\./u),
    });
    expect(JSON.stringify(result.result)).not.toContain("other-context");
  });

  it("closes only the created ephemeral lease and releases the claimed tab", async () => {
    let snapshot = await addLease(snapshotFixture(), { byte: 6, providerTabId: 10, origin: "created" });
    snapshot = await addLease(snapshot, { byte: 7, providerTabId: 12, origin: "claimed" });
    const handles = Object.keys(snapshot.session.leasesByHandle);
    const leaseIds = handles.map((handle) => snapshot.session.leasesByHandle[handle].leaseId);
    const store = new FakeRuntimeStore(snapshot);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);

    const params = {
      contract_version: 1,
      control_id: "control-one",
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      dispositions: { [leaseIds[0]]: "ephemeral", [leaseIds[1]]: "ephemeral" },
      reason: "completed",
    };
    const result = await runtime.finalize(params);

    expect(tabsRemove).toHaveBeenCalledTimes(1);
    expect(tabsRemove).toHaveBeenCalledWith(10);
    expect(result.closed).toEqual([leaseIds[0]]);
    expect(result.released).toEqual([leaseIds[1]]);
    expect(store.snapshot.session.leasesByHandle[handles[0]].state).toBe("closed");
    expect(store.snapshot.session.leasesByHandle[handles[1]].state).toBe("released");
    await expect(runtime.finalize(params)).resolves.toEqual(result);
    await expect(runtime.finalize({ ...params, reason: "different reason" }))
      .rejects.toMatchObject({ a0Code: "IDEMPOTENCY_CONFLICT" });
    expect(tabsRemove).toHaveBeenCalledTimes(1);
    expect(store.snapshot.ledger.criticalEvents.filter((event) => event.eventType === "turn.finalized"))
      .toEqual([expect.objectContaining({
        data: expect.objectContaining({
          controlId: "control-one",
          status: "completed",
          closedCount: 1,
          releasedCount: 1,
          errorCount: 0,
        }),
      })]);
  });

  it("rechecks lease authority after overlay teardown before closing", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 13, providerTabId: 14, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const leaseId = snapshot.session.leasesByHandle[handle].leaseId;
    const store = new FakeRuntimeStore(snapshot);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore, async (lease) => {
      await store.updateSession((session) => ({
        ...session,
        leasesByHandle: {
          ...session.leasesByHandle,
          [handle]: {
            ...lease,
            state: "released",
            userIntervened: true,
            userTakeoverReason: "moved",
            retentionReason: "user_takeover",
            revision: lease.revision + 1,
          },
        },
      }));
    });

    const result = await runtime.finalize({
      contract_version: 1,
      control_id: "control-one",
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      dispositions: { [leaseId]: "ephemeral" },
      reason: "completed",
    });

    expect(tabsRemove).not.toHaveBeenCalled();
    expect(result.retained).toEqual([{
      lease_id: leaseId,
      tab_handle: handle,
      reason: "user_takeover",
    }]);
  });

  it("returns bounded semantic content through an exact document-bound host", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 8, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const command = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        state: "inspected",
        snapshot: {
          title: "Example",
          text: "Continue",
          nodes: [{ ref: "doc:epoch:opaque", role: "button", name: "Continue" }],
          truncated: false,
        },
      },
    });
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      {
        bind: async (lease: TabLease) => ({
          ...lease,
          identity: { ...lease.identity, documentId: "document-one", documentEpoch: 1 },
          revision: lease.revision + 1,
        }),
        command,
        release: async () => undefined,
      },
    );

    const result = await runtime.perform(performParams({
      action: "content",
      target: { tab_handle: handle },
      args: { max_nodes: 64, max_text_chars: 4_000 },
      required_capabilities: ["content", "semantic_dom_v1"],
    }));

    expect(result.result).toMatchObject({
      lease_id: snapshot.session.leasesByHandle[handle].leaseId,
      browser_id: handle,
      tab_handle: handle,
      document_id: "document-one",
      document_epoch: "1",
      title: "Example",
      text: "Continue",
      nodes: [{ ref: "doc:epoch:opaque", role: "button", name: "Continue" }],
    });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ documentId: "document-one" }) }),
      expect.objectContaining({
        command: { name: "semantics.inspect", max_nodes: 64, max_text_chars: 4_000 },
      }),
    );
  });

  it("journals same-origin navigation and does not reapply a successful action id", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 9, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const release = vi.fn().mockResolvedValue(undefined);
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      { bind: vi.fn(), command: vi.fn(), release },
    );
    const params = performParams({
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://example.com/next?private=value" },
      required_capabilities: ["navigate", "tab_leases_v1"],
    });

    await runtime.perform(params);
    await runtime.perform(params);

    expect(tabsUpdate).toHaveBeenCalledTimes(1);
    expect(tabsUpdate).toHaveBeenCalledWith(8, { url: "https://example.com/next?private=value" });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ tabHandle: handle }), "navigation");
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({ actionId: "action-one", kind: "navigate", stage: "succeeded" }),
    ]);
    expect(JSON.stringify(store.snapshot.ledger)).not.toContain("private=value");
  });

  it("cancels exact prepared work before invocation and ignores a mismatched session", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 14, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const releaseGate = deferred<void>();
    const release = vi.fn().mockReturnValue(releaseGate.promise);
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      { bind: vi.fn(), command: vi.fn(), release },
    );
    const operation = runtime.perform(performParams({
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://example.com/cancel-before-effect" },
      required_capabilities: ["navigate"],
    }));
    const canceledOperation = expect(operation).rejects.toMatchObject({ a0Code: "CANCELED", outcome: "not_applied" });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));

    expect(await runtime.cancel(cancelParams({
      control_id: "control-wrong-session",
      browser_session_id: "another-session",
    }))).toMatchObject({ status: "not_found" });
    const canceled = await runtime.cancel(cancelParams());
    expect(canceled).toMatchObject({
      status: "canceled",
      receipt: { outcome: "not_applied", code: "CANCELED" },
    });

    releaseGate.resolve();
    await canceledOperation;
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({
        opId: "op-one",
        actionId: "action-one",
        contextId: "context-one",
        browserSessionId: "session-one",
        turnId: "turn-one",
        stage: "canceled",
        safeReceipt: expect.objectContaining({ outcome: "not_applied", code: "CANCELED" }),
      }),
    ]);
  });

  it("prevents canceled queued lease work from acquiring a Chrome effect", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 15, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const firstEffect = deferred<chrome.tabs.Tab>();
    tabsUpdate.mockReturnValueOnce(firstEffect.promise);
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      { bind: vi.fn(), command: vi.fn(), release: vi.fn().mockResolvedValue(undefined) },
    );
    const first = runtime.perform(performParams({
      op_id: "op-first",
      action_id: "action-first",
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://example.com/first" },
      required_capabilities: ["navigate"],
    }));
    await vi.waitFor(() => expect(tabsUpdate).toHaveBeenCalledTimes(1));

    const second = runtime.perform(performParams({
      op_id: "op-second",
      action_id: "action-second",
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://example.com/second" },
      required_capabilities: ["navigate"],
    }));
    const canceledSecond = expect(second).rejects.toMatchObject({ a0Code: "CANCELED" });
    expect(await runtime.cancel(cancelParams({
      control_id: "control-second",
      op_id: "op-second",
      action_id: "action-second",
    }))).toMatchObject({ status: "canceled" });

    firstEffect.resolve({ id: 8, windowId: 4, url: "https://example.com/first" } as chrome.tabs.Tab);
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
    await canceledSecond;
    expect(tabsUpdate).toHaveBeenCalledTimes(1);
    expect(tabsRemove).not.toHaveBeenCalled();
    expect(store.snapshot.ledger.operations.map((record) => record.actionId)).toEqual(["action-first"]);
  });

  it("reports an invoked Chrome mutation as unknown without undoing it, then exposes terminal proof", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 16, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const effect = deferred<chrome.tabs.Tab>();
    tabsUpdate.mockReturnValueOnce(effect.promise);
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      { bind: vi.fn(), command: vi.fn(), release: vi.fn().mockResolvedValue(undefined) },
    );
    const operation = runtime.perform(performParams({
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://example.com/invoked" },
      required_capabilities: ["navigate"],
    }));
    await vi.waitFor(() => expect(tabsUpdate).toHaveBeenCalledTimes(1));

    expect(await runtime.cancel(cancelParams())).toMatchObject({
      status: "outcome_unknown",
      receipt: { outcome: "unknown", code: "OUTCOME_UNKNOWN" },
    });
    expect(store.snapshot.ledger.operations[0].stage).toBe("effect_started");
    expect(tabsRemove).not.toHaveBeenCalled();

    effect.resolve({ id: 8, windowId: 4, url: "https://example.com/invoked" } as chrome.tabs.Tab);
    await expect(operation).resolves.toMatchObject({ status: "succeeded" });
    expect(store.snapshot.ledger.operations[0]).toMatchObject({
      stage: "succeeded",
      safeReceipt: { outcome: "applied", code: null },
    });
    expect(await runtime.cancel(cancelParams())).toMatchObject({ status: "outcome_unknown" });
    expect(await runtime.cancel(cancelParams({ control_id: "control-after-complete" }))).toMatchObject({
      status: "already_completed",
      receipt: { outcome: "applied", code: null },
    });
  });

  it("barriers a finalizing turn, waits for an invoked open, and then finalizes its new lease", async () => {
    const store = new FakeRuntimeStore(snapshotFixture());
    const openEffect = deferred<chrome.tabs.Tab>();
    tabsCreate.mockReturnValueOnce(openEffect.promise);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const operation = runtime.perform(performParams());
    await vi.waitFor(() => expect(tabsCreate).toHaveBeenCalledTimes(1));

    const finalization = runtime.finalize({
      contract_version: 1,
      control_id: "control-finalize-race",
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      dispositions: {},
      reason: "stopped",
    });
    await expect(runtime.perform(performParams({
      op_id: "op-late",
      action_id: "action-late",
      args: { url: "https://example.com/late" },
    }))).rejects.toMatchObject({ a0Code: "CANCELED", outcome: "not_applied" });

    openEffect.resolve({ id: 7, windowId: 4, url: "https://example.com/path?private=value" } as chrome.tabs.Tab);
    const opened = await operation;
    const leaseId = (opened.result as { lease_id: string }).lease_id;
    await expect(finalization).resolves.toMatchObject({ closed: [leaseId] });
    expect(tabsCreate).toHaveBeenCalledTimes(1);
    expect(tabsRemove).toHaveBeenCalledWith(7);
    expect(Object.values(store.snapshot.session.leasesByHandle)).toEqual([
      expect.objectContaining({ leaseId, state: "closed" }),
    ]);
    expect(store.snapshot.session.finalizedTurns).toEqual([
      expect.objectContaining({
        contextId: "context-one",
        browserSessionId: "session-one",
        turnId: "turn-one",
        controlId: "control-finalize-race",
      }),
    ]);
  });

  it("terminalizes a worker-recovered pending finalization as unknown without reapplying tab effects", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 17, providerTabId: 8, origin: "created" });
    const store = new FakeRuntimeStore(snapshot);
    const removal = deferred<void>();
    tabsRemove.mockReturnValueOnce(removal.promise);
    const params = {
      contract_version: 1,
      control_id: "control-recovered",
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      dispositions: {},
      reason: "stopped",
    };
    const originalRuntime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const original = originalRuntime.finalize(params);
    await vi.waitFor(() => expect(tabsRemove).toHaveBeenCalledTimes(1));
    expect(store.snapshot.session.finalizationControls).toEqual([
      expect.objectContaining({ controlId: "control-recovered", status: "pending", result: null }),
    ]);

    const recoveredRuntime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const recovered = await recoveredRuntime.finalize(params);
    expect(recovered).toMatchObject({
      closed: [],
      released: [],
      errors: [expect.objectContaining({ code: "OUTCOME_UNKNOWN" })],
    });
    await expect(recoveredRuntime.finalize(params)).resolves.toEqual(recovered);
    expect(tabsRemove).toHaveBeenCalledTimes(1);

    removal.resolve();
    await expect(original).resolves.toMatchObject({ closed: [expect.stringMatching(/^a0l1\./u)] });
    expect(store.snapshot.session.finalizationControls[0]).toMatchObject({
      status: "completed",
      result: recovered,
    });
  });

  it.each(["unchanged", "action_removed", "connection_replaced"])("waits for an exact server site grant and rechecks continuation (%s)", async (authority) => {
    const snapshot = await addLease(snapshotFixture(), { byte: 10, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    let currentUrl = "https://example.com";
    tabsGet.mockImplementation(async (tabId: number) => ({ id: tabId, windowId: 4, groupId: 11, url: currentUrl }));
    tabsUpdate.mockImplementation(async (_tabId: number, update: chrome.tabs.UpdateProperties) => {
      currentUrl = String(update.url);
      return { id: 8, windowId: 4, groupId: 11, url: currentUrl };
    });
    const published = vi.fn();
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      undefined,
      { publishPersisted: published },
    );

    const operation = runtime.perform(performParams({
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://other.example/" },
      required_capabilities: ["navigate"],
    }));
    await vi.waitFor(() => expect(
      store.snapshot.ledger.operations.find((record) => record.actionId === "action-one"),
    ).toMatchObject({ stage: "waiting_approval" }));
    const event = store.snapshot.ledger.criticalEvents.find(
      (candidate) => candidate.eventType === "challenge.required",
    );
    if (!event || event.eventType !== "challenge.required") throw new Error("missing challenge event");
    expect(event.data).toMatchObject({
      origin: "https://other.example",
      documentId: null,
      documentEpoch: 0,
      options: ["deny", "allow_once", "allow_turn"],
    });
    expect(JSON.stringify(event)).not.toContain("https://other.example/");
    expect(tabsUpdate).not.toHaveBeenCalled();

    const resolution = {
      contract_version: 1,
      control_id: "challenge-control-one",
      challenge_id: event.data.challengeId,
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      op_id: "op-one",
      action_id: "action-one",
      tab_handle: handle,
      document_id: event.data.documentId,
      document_epoch: event.data.documentEpoch,
      canonical_parameter_hash: event.data.canonicalParameterHash,
      target_fingerprint: event.data.targetFingerprint,
      origin: event.data.origin,
      action_class: "navigate",
      decision: "allow_once",
      grant: {
        origin_grant_id: "site-grant-one",
        scope: "operation",
        origin: event.data.origin,
        expires_at_ms: event.data.expiresAtMs,
      },
    };
    if (authority !== "unchanged") {
      if (authority === "action_removed") store.snapshot.session.connection.negotiatedActions = ["status"];
      else store.snapshot.session.connection.connectionId = "connection-two";
      const rejected = expect(operation).rejects.toMatchObject({
        a0Code: authority === "action_removed" ? "UNSUPPORTED_CAPABILITY" : "CONNECTION_LOST",
        outcome: "not_applied",
      });
      await runtime.resolveChallenge(resolution);
      await rejected;
      expect(tabsUpdate).not.toHaveBeenCalled();
      expect(tabsRemove).not.toHaveBeenCalled();
      return;
    }
    const resolved = await runtime.resolveChallenge(resolution);
    await expect(runtime.resolveChallenge(resolution)).resolves.toEqual(resolved);
    await expect(runtime.resolveChallenge({ ...resolution, decision: "deny", grant: null }))
      .rejects.toMatchObject({ a0Code: "IDEMPOTENCY_CONFLICT" });
    await expect(runtime.resolveChallenge({ ...resolution, control_id: "challenge-control-two" }))
      .rejects.toMatchObject({ a0Code: "IDEMPOTENCY_CONFLICT" });
    await expect(operation).resolves.toMatchObject({
      status: "succeeded",
      result: { origin: "https://other.example", tab_handle: handle },
    });

    expect(tabsUpdate).toHaveBeenCalledWith(8, { url: "https://other.example/" });
    expect(store.snapshot.session.leasesByHandle[handle].siteOrigin).toBe("https://other.example");
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({ actionId: "action-one", kind: "navigate", stage: "succeeded" }),
    ]);
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ eventType: "challenge.required" }));
  });

  it("deny, expiry, and disconnect settle waiting site challenges without invoking Chrome", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 19, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const operation = runtime.perform(performParams({
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://denied.example/path" },
      required_capabilities: ["navigate"],
    }));
    await vi.waitFor(() => expect(store.snapshot.session.pendingChallenges).toHaveLength(1));
    const event = store.snapshot.ledger.criticalEvents.find(
      (candidate) => candidate.eventType === "challenge.required",
    );
    if (!event || event.eventType !== "challenge.required") throw new Error("missing challenge event");
    await runtime.resolveChallenge({
      contract_version: 1,
      control_id: "challenge-control-deny",
      challenge_id: event.data.challengeId,
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      op_id: "op-one",
      action_id: "action-one",
      tab_handle: handle,
      document_id: event.data.documentId,
      document_epoch: event.data.documentEpoch,
      canonical_parameter_hash: event.data.canonicalParameterHash,
      target_fingerprint: event.data.targetFingerprint,
      origin: event.data.origin,
      action_class: "navigate",
      decision: "deny",
      grant: null,
    });
    await expect(operation).rejects.toMatchObject({ a0Code: "APPROVAL_DENIED", outcome: "not_applied" });
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(store.snapshot.ledger.operations[0]).toMatchObject({
      stage: "canceled",
      safeReceipt: { outcome: "not_applied", code: "APPROVAL_DENIED" },
    });

    const second = runtime.perform(performParams({
      op_id: "op-two",
      action_id: "action-two",
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://disconnect.example/" },
      required_capabilities: ["navigate"],
    }));
    await vi.waitFor(() => expect(store.snapshot.session.pendingChallenges).toHaveLength(1));
    await runtime.disconnectPendingChallenges();
    await expect(second).rejects.toMatchObject({ a0Code: "CANCELED", outcome: "not_applied" });

    const third = runtime.perform(performParams({
      op_id: "op-three",
      action_id: "action-three",
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://expired.example/" },
      required_capabilities: ["navigate"],
    }));
    await vi.waitFor(() => expect(store.snapshot.session.pendingChallenges).toHaveLength(1));
    await runtime.expireChallenges(Number.MAX_SAFE_INTEGER);
    await expect(third).rejects.toMatchObject({ a0Code: "CHALLENGE_EXPIRED", outcome: "not_applied" });
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it("turn finalization wakes a waiting site challenge before cleaning up its exact lease", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 20, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const leaseId = snapshot.session.leasesByHandle[handle].leaseId;
    const store = new FakeRuntimeStore(snapshot);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);
    const operation = runtime.perform(performParams({
      action: "navigate",
      target: { tab_handle: handle },
      args: { url: "https://finalized.example/" },
      required_capabilities: ["navigate"],
    }));
    await vi.waitFor(() => expect(store.snapshot.session.pendingChallenges).toHaveLength(1));

    const finalization = runtime.finalize({
      contract_version: 1,
      control_id: "control-challenge-finalize",
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      dispositions: {},
      reason: "stopped",
    });
    await expect(operation).rejects.toMatchObject({ a0Code: "CANCELED", outcome: "not_applied" });
    await expect(finalization).resolves.toMatchObject({ closed: [leaseId] });
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(tabsRemove).toHaveBeenCalledWith(8);
  });

  it("journals ref-bound scroll and records cursor attachment only after confirmation", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 11, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const command = vi.fn().mockResolvedValue({
      ok: true,
      result: { state: "scrolled", x: 40, y: 60 },
    });
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      {
        bind: async (lease) => ({
          ...lease,
          identity: { ...lease.identity, documentId: "document-one", documentEpoch: 1 },
          revision: lease.revision + 1,
        }),
        command,
        release: async () => undefined,
      },
    );

    const result = await runtime.perform(performParams({
      action: "scroll",
      target: { tab_handle: handle },
      args: { ref: "doc:epoch:opaque" },
      required_capabilities: ["scroll", "semantic_dom_v1", "cursor_v1"],
      display: { cursor: true, foreground: false },
    }));

    expect(result.result).toMatchObject({
      lease_id: snapshot.session.leasesByHandle[handle].leaseId,
      browser_id: handle,
      tab_handle: handle,
      ref: "doc:epoch:opaque",
      x: 40,
      y: 60,
    });
    expect(command).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: { name: "page.scroll_to_ref", element_ref: "doc:epoch:opaque", show_cursor: true },
      }),
    );
    expect(store.snapshot.session.leasesByHandle[handle].overlayAttached).toBe(true);
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({ actionId: "action-one", kind: "scroll", stage: "succeeded" }),
    ]);
  });

  it("dispatches only a ref-resolved trusted hover and keeps geometry inside the worker", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 51, providerTabId: 51, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const command = vi.fn(async (_lease: TabLease, input: { command: { name: string } }) => ({
      ok: true,
      result: input.command.name === "target.prepare_hover"
        ? { state: "hover_ready", x: 70, y: 60 }
        : { state: "activated", x: 70, y: 60 },
    }));
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      {
        bind: async (lease: TabLease) => ({
          ...lease,
          identity: { ...lease.identity, documentId: "document-hover", documentEpoch: 1 },
          revision: lease.revision + 1,
        }),
        command,
        release: async () => undefined,
      } as unknown as import("./content-host").ContentRuntimeHost,
      { publishPersisted: vi.fn() },
      new ChromeScreenshotDebuggerHost(),
    );

    const result = await runtime.perform(performParams({
      action: "hover",
      target: { tab_handle: handle },
      args: { ref: "doc:epoch:opaque" },
      required_capabilities: ["hover", "semantic_dom_v1", "cursor_v1", "trusted_input_v1"],
      display: { cursor: true, foreground: false },
    }));

    expect(debuggerSendCommand).toHaveBeenCalledWith(
      { tabId: 51 },
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: 70, y: 60, button: "none", buttons: 0, pointerType: "mouse" },
    );
    expect(result.result).toEqual({
      lease_id: snapshot.session.leasesByHandle[handle].leaseId,
      browser_id: handle,
      tab_handle: handle,
      document_epoch: "1",
      ref: "doc:epoch:opaque",
    });
    expect(JSON.stringify(result)).not.toContain('"x"');
    expect(JSON.stringify(result)).not.toContain('"y"');
    expect(store.snapshot.session.leasesByHandle[handle]).toMatchObject({
      debuggerAttached: false,
      overlayAttached: true,
    });
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({ actionId: "action-one", kind: "hover", stage: "succeeded" }),
    ]);
  });

  it("waits for one exact action grant and revalidates a semantic click before both CDP phases", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 52, providerTabId: 52, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const targetFingerprint = "a".repeat(64);
    const command = vi.fn(async (_lease: TabLease, input: { command: { name: string } }) => ({
      ok: true,
      result: input.command.name === "cursor.activate"
        ? { state: "activated", x: 70, y: 60 }
        : {
            state: "click_ready",
            x: 70,
            y: 60,
            action_class: "reversible_input",
            target_fingerprint: targetFingerprint,
          },
    }));
    const published = vi.fn();
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      {
        bind: async (lease: TabLease) => ({
          ...lease,
          identity: { ...lease.identity, documentId: "document-click", documentEpoch: 1 },
          revision: lease.revision + 1,
        }),
        command,
        release: async () => undefined,
      } as unknown as import("./content-host").ContentRuntimeHost,
      { publishPersisted: published },
      new ChromeScreenshotDebuggerHost(),
    );

    const operation = runtime.perform(performParams({
      action: "click",
      target: { tab_handle: handle },
      args: { ref: "doc:epoch:opaque", expected_action_class: "unknown" },
      required_capabilities: ["click", "semantic_dom_v1", "cursor_v1", "trusted_input_v1"],
      display: { cursor: true, foreground: false },
    }));
    await vi.waitFor(() => expect(store.snapshot.session.pendingChallenges).toHaveLength(1));
    const event = store.snapshot.ledger.criticalEvents.find(
      (candidate) => candidate.eventType === "challenge.required" && candidate.data.kind === "action",
    );
    if (!event || event.eventType !== "challenge.required" || event.data.kind !== "action") {
      throw new Error("missing action challenge event");
    }
    expect(event.data).toMatchObject({
      actionClass: "unknown",
      documentId: "document-click",
      options: ["decline", "approve_once"],
      dataClassification: "none",
      targetFingerprint,
    });
    expect(debuggerSendCommand).not.toHaveBeenCalled();

    const resolution = {
      contract_version: 1,
      control_id: "action-control-one",
      challenge_id: event.data.challengeId,
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      op_id: "op-one",
      action_id: "action-one",
      tab_handle: handle,
      document_id: event.data.documentId,
      document_epoch: event.data.documentEpoch,
      canonical_parameter_hash: event.data.canonicalParameterHash,
      target_fingerprint: event.data.targetFingerprint,
      origin: event.data.origin,
      action_class: event.data.actionClass,
      data_classification: "none",
      decision: "approve_once",
      grant: {
        action_grant_id: "action-grant-one",
        scope: "operation",
        origin: event.data.origin,
        action_class: event.data.actionClass,
        canonical_parameter_hash: event.data.canonicalParameterHash,
        target_fingerprint: event.data.targetFingerprint,
        data_classification: "none",
        expires_at_ms: event.data.expiresAtMs,
      },
    };
    const controlResult = await runtime.resolveChallenge(resolution);
    await expect(runtime.resolveChallenge(resolution)).resolves.toEqual(controlResult);
    const result = await operation;

    expect(command.mock.calls.map((call) => call[1].command.name)).toEqual([
      "target.prepare_click",
      "target.revalidate_click",
      "target.revalidate_click",
      "cursor.activate",
    ]);
    expect(debuggerSendCommand).toHaveBeenNthCalledWith(1, { tabId: 52 }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 70,
      y: 60,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    expect(debuggerSendCommand).toHaveBeenNthCalledWith(2, { tabId: 52 }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 70,
      y: 60,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });
    expect(result.result).toEqual({
      lease_id: snapshot.session.leasesByHandle[handle].leaseId,
      browser_id: handle,
      tab_handle: handle,
      document_epoch: "1",
      ref: "doc:epoch:opaque",
      action_class: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain('"x"');
    expect(JSON.stringify(result)).not.toContain('"y"');
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({ actionId: "action-one", kind: "click", stage: "succeeded" }),
    ]);
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ eventType: "challenge.required" }));
  });

  it("shares a verified native attachment only after exact one-use site consent without exposing its private path", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 53, providerTabId: 53, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const privatePath = "/private/a0-fixture/input";
    const digest = `sha256:${"a".repeat(64)}`;
    const command = vi.fn(async (_lease: TabLease, input: { command: { name: string } }) => ({ ok: true,
      result: input.command.name === "cursor.activate" ? { state: "activated" }
        : { state: "click_ready", x: 70, y: 60, action_class: "external_side_effect", target_fingerprint: "b".repeat(64) },
    }));
    debuggerSendCommand.mockImplementation(async (_source: unknown, method: string) =>
      method === "DOM.getNodeForLocation" ? { backendNodeId: 91 }
        : method === "DOM.describeNode" ? { node: { nodeName: "INPUT", backendNodeId: 91, attributes: ["type", "file"] } } : {});
    const inputArtifact = vi.fn(async (binding: import("./input-artifact").InputArtifactBinding) => parseInputArtifact({
      ...inputArtifactParams(binding), ephemeral_path: privatePath,
      descriptor: { artifact_id: binding.artifactId, mime_type: "text/plain", byte_count: 3, sha256: digest, purpose: "upload_file" },
    }, binding));
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore, async () => undefined, {
      bind: async (lease: TabLease) => ({ ...lease, identity: { ...lease.identity, documentId: "document-upload", documentEpoch: 1 }, revision: lease.revision + 1 }),
      command, release: async () => undefined,
    } as unknown as import("./content-host").ContentRuntimeHost, { publishPersisted: vi.fn() }, new ChromeScreenshotDebuggerHost(), {
      inputArtifact, artifactBegin: vi.fn(), artifactChunk: vi.fn(), artifactEnd: vi.fn(), artifactAbort: vi.fn(),
    });
    const params = performParams({ action: "upload_file", target: { tab_handle: handle }, args: {
      ref: "doc:epoch:opaque", expected_action_class: "external_side_effect", artifact_id: "input-one", mime_type: "text/plain", byte_count: 3, sha256: digest,
    }, required_capabilities: ["upload_file", "artifacts_v1", "semantic_dom_v1", "cursor_v1", "trusted_input_v1"], display: { cursor: true, foreground: false } });
    const operation = runtime.perform(params);
    await vi.waitFor(() => expect(store.snapshot.session.pendingChallenges).toHaveLength(1));
    expect(inputArtifact).not.toHaveBeenCalled();
    expect(debuggerSendCommand).not.toHaveBeenCalled();
    const event = store.snapshot.ledger.criticalEvents.find((candidate) => candidate.eventType === "challenge.required" && candidate.data.kind === "action");
    if (!event || event.eventType !== "challenge.required" || event.data.kind !== "action") throw new Error("missing upload challenge");
    await runtime.resolveChallenge({ contract_version: 1, control_id: "upload-control", challenge_id: event.data.challengeId,
      context_id: "context-one", browser_session_id: "session-one", turn_id: "turn-one", op_id: "op-one", action_id: "action-one",
      tab_handle: handle, document_id: event.data.documentId, document_epoch: event.data.documentEpoch,
      canonical_parameter_hash: event.data.canonicalParameterHash, target_fingerprint: event.data.targetFingerprint,
      origin: event.data.origin, action_class: "external_side_effect", data_classification: "none", decision: "approve_once",
      grant: { action_grant_id: "upload-grant", scope: "operation", origin: event.data.origin, action_class: "external_side_effect",
        canonical_parameter_hash: event.data.canonicalParameterHash, target_fingerprint: event.data.targetFingerprint,
        data_classification: "none", expires_at_ms: event.data.expiresAtMs },
    });
    const result = await operation;
    expect(result.result).toMatchObject({ ref: "doc:epoch:opaque", action_class: "external_side_effect" });
    expect(inputArtifact).toHaveBeenCalledTimes(1);
    expect(debuggerSendCommand.mock.calls.filter((call) => call[1] === "DOM.setFileInputFiles")).toEqual([
      [{ tabId: 53 }, "DOM.setFileInputFiles", { backendNodeId: 91, files: [privatePath] }],
    ]);
    expect(debuggerSendCommand.mock.calls.some((call) => call[1] === "Input.dispatchMouseEvent")).toBe(false);
    expect(JSON.stringify({ result, state: store.snapshot })).not.toContain(privatePath);
  });

  it("types once only after an exact sensitive text grant without persisting or returning raw text", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 53, providerTabId: 53, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const targetFingerprint = "b".repeat(64);
    const rawText = "synthetic secret";
    const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawText));
    const textSha256 = Array.from(new Uint8Array(hashBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const command = vi.fn(async (_lease: TabLease, input: { command: { name: string } }) => ({
      ok: true,
      result: input.command.name === "cursor.activate"
        ? { state: "activated", x: 70, y: 60 }
        : input.command.name === "target.confirm_type_focus"
          ? { state: "type_focus_ready" }
          : input.command.name === "target.verify_type_value"
            ? { state: "type_verified" }
            : {
                state: "type_ready",
                x: 70,
                y: 60,
                action_class: "sensitive_input",
                target_fingerprint: targetFingerprint,
              },
    }));
    debuggerSendCommand.mockImplementation(async (_source: unknown, method: string) =>
      method === "DOM.getNodeForLocation" ? { backendNodeId: 91 } : {});
    const published = vi.fn();
    const runtime = new TestBrowserRuntime(
      store as unknown as RuntimeStore,
      async () => undefined,
      {
        bind: async (lease: TabLease) => ({
          ...lease,
          identity: { ...lease.identity, documentId: "document-type", documentEpoch: 1 },
          revision: lease.revision + 1,
        }),
        command,
        release: async () => undefined,
      } as unknown as import("./content-host").ContentRuntimeHost,
      { publishPersisted: published },
      new ChromeScreenshotDebuggerHost(),
    );

    const operation = runtime.perform(performParams({
      action: "type",
      target: { tab_handle: handle },
      args: {
        ref: "doc:epoch:opaque",
        text: rawText,
        text_sha256: textSha256,
        expected_action_class: "sensitive_input",
      },
      required_capabilities: ["semantic_dom_v1", "cursor_v1", "trusted_input_v1"],
      display: { cursor: true, foreground: false },
    }));
    await vi.waitFor(() => expect(store.snapshot.session.pendingChallenges).toHaveLength(1));
    const event = store.snapshot.ledger.criticalEvents.find(
      (candidate) => candidate.eventType === "challenge.required" && candidate.data.kind === "action",
    );
    if (!event || event.eventType !== "challenge.required" || event.data.kind !== "action") {
      throw new Error("missing type challenge event");
    }
    expect(event.data).toMatchObject({
      actionClass: "sensitive_input",
      dataClassification: { kind: "text", sensitivity: "sensitive", textSha256 },
      summary: "Allow Agent Zero to type into the highlighted field?",
    });
    expect(JSON.stringify(store.snapshot)).not.toContain(rawText);
    expect(debuggerSendCommand).not.toHaveBeenCalled();

    const dataClassification = { kind: "text", sensitivity: "sensitive", text_sha256: textSha256 };
    await runtime.resolveChallenge({
      contract_version: 1,
      control_id: "type-control-one",
      challenge_id: event.data.challengeId,
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      op_id: "op-one",
      action_id: "action-one",
      tab_handle: handle,
      document_id: event.data.documentId,
      document_epoch: event.data.documentEpoch,
      canonical_parameter_hash: event.data.canonicalParameterHash,
      target_fingerprint: event.data.targetFingerprint,
      origin: event.data.origin,
      action_class: "sensitive_input",
      data_classification: dataClassification,
      decision: "approve_once",
      grant: {
        action_grant_id: "type-grant-one",
        scope: "operation",
        origin: event.data.origin,
        action_class: "sensitive_input",
        canonical_parameter_hash: event.data.canonicalParameterHash,
        target_fingerprint: event.data.targetFingerprint,
        data_classification: dataClassification,
        expires_at_ms: event.data.expiresAtMs,
      },
    });
    const result = await operation;

    expect(debuggerSendCommand.mock.calls.map((call) => call[1])).toEqual([
      "DOM.getNodeForLocation",
      "DOM.focus",
      "Input.insertText",
    ]);
    expect(debuggerSendCommand).toHaveBeenNthCalledWith(1, { tabId: 53 }, "DOM.getNodeForLocation", {
      x: 70,
      y: 60,
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false,
    });
    expect(debuggerSendCommand).toHaveBeenNthCalledWith(2, { tabId: 53 }, "DOM.focus", { backendNodeId: 91 });
    expect(debuggerSendCommand).toHaveBeenNthCalledWith(3, { tabId: 53 }, "Input.insertText", { text: rawText });
    expect(result.result).toEqual({
      lease_id: snapshot.session.leasesByHandle[handle].leaseId,
      browser_id: handle,
      tab_handle: handle,
      document_epoch: "1",
      ref: "doc:epoch:opaque",
      action_class: "sensitive_input",
    });
    expect(JSON.stringify(result)).not.toContain(rawText);
    expect(JSON.stringify(result)).not.toContain(textSha256);
    expect(store.snapshot.ledger.operations).toEqual([
      expect.objectContaining({ actionId: "action-one", kind: "type", stage: "succeeded" }),
    ]);
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ eventType: "challenge.required" }));
  });

  it("rejects unsupported action capabilities and unknown finalization disposition identities", async () => {
    const snapshot = await addLease(snapshotFixture(), { byte: 12, providerTabId: 8, origin: "created" });
    const handle = Object.keys(snapshot.session.leasesByHandle)[0];
    const store = new FakeRuntimeStore(snapshot);
    const runtime = new TestBrowserRuntime(store as unknown as RuntimeStore);

    await expect(runtime.perform(performParams({
      action: "state",
      target: { tab_handle: handle },
      args: {},
      required_capabilities: ["upload_file", "cursor_v1"],
    }))).rejects.toMatchObject({ a0Code: "UNSUPPORTED_CAPABILITY" });
    await expect(runtime.finalize({
      contract_version: 1,
      control_id: "control-one",
      context_id: "context-one",
      browser_session_id: "session-one",
      turn_id: "turn-one",
      dispositions: { "lease-id-from-wire": "deliverable" },
      reason: "completed",
    })).rejects.toMatchObject({ a0Code: "LEASE_NOT_FOUND" });
    expect(tabsRemove).not.toHaveBeenCalled();
  });
});
