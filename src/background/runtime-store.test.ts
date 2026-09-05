import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDurableLeaseShadow } from "./journal";
import { createLease } from "./leases";
import { createTabHandle } from "./lifecycle";
import {
  LEGACY_BACKGROUND_KEY,
  LOCAL_ACTIVATION_EVIDENCE_KEY,
  LOCAL_LEDGER_KEY,
  RuntimeStore,
  SESSION_RUNTIME_KEY,
} from "./runtime-store";

const storageArea = (initial: Record<string, unknown> = {}) => {
  const values = { ...initial };
  return {
    values,
    get: vi.fn(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => key in values).map((key) => [key, values[key]]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }),
    setAccessLevel: vi.fn(async () => undefined),
  };
};

describe("MV3 runtime storage hydration", () => {
  const priorChrome = globalThis.chrome;
  let local: ReturnType<typeof storageArea>;
  let session: ReturnType<typeof storageArea>;

  beforeEach(() => {
    local = storageArea({
      [LEGACY_BACKGROUND_KEY]: {
        config: { apiKey: "must-not-be-loaded" },
        composeDraft: "must-not-be-loaded",
      },
    });
    session = storageArea();
    globalThis.chrome = {
      storage: { local, session },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    globalThis.chrome = priorChrome;
  });

  it("shares one cold hydration, locks storage to trusted contexts, and deletes legacy secrets by key", async () => {
    const store = new RuntimeStore();
    const [first, second] = await Promise.all([store.hydrate(), store.hydrate()]);

    expect(first).toBe(second);
    expect(first.lifecycle.phase).toBe("RESET_GENERATION");
    expect(local.setAccessLevel).toHaveBeenCalledOnce();
    expect(session.setAccessLevel).toHaveBeenCalledOnce();
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(local.remove).toHaveBeenCalledWith(LEGACY_BACKGROUND_KEY);
    expect(local.get).toHaveBeenCalledWith(LOCAL_LEDGER_KEY);
    expect(JSON.stringify(local.values)).not.toContain("must-not-be-loaded");
    expect(first.activationEvidence).toEqual({
      schemaVersion: 1,
      storageMigrationState: "v1_ready",
      legacyControlPlaneInactive: true,
      legacyStorageKeyRemoved: LEGACY_BACKGROUND_KEY,
    });
    expect(local.values[LOCAL_ACTIVATION_EVIDENCE_KEY]).toEqual(first.activationEvidence);
    expect(session.values[SESSION_RUNTIME_KEY]).toBeDefined();
  });

  it("does not expose activation evidence when the durable migration receipt cannot be stored", async () => {
    local.set.mockRejectedValueOnce(new Error("quota unavailable"));
    const store = new RuntimeStore();

    await expect(store.hydrate()).rejects.toThrow("quota unavailable");
    expect(() => store.snapshot).toThrow("Runtime state has not been hydrated");
    expect(local.values[LOCAL_ACTIVATION_EVIDENCE_KEY]).toBeUndefined();
  });

  it("resumes an ordinary worker restart but resets identity after session loss", async () => {
    const first = await new RuntimeStore().hydrate();
    const resumed = await new RuntimeStore().hydrate();

    expect(resumed.lifecycle.phase).toBe("RESUME_GENERATION");
    expect(resumed.lifecycle.loadGenerationId).toBe(first.lifecycle.loadGenerationId);
    expect(resumed.lifecycle.workerBootId).not.toBe(first.lifecycle.workerBootId);

    delete session.values[SESSION_RUNTIME_KEY];
    const reset = await new RuntimeStore().hydrate();
    expect(reset.lifecycle.phase).toBe("RESET_GENERATION");
    expect(reset.lifecycle.loadGenerationId).not.toBe(first.lifecycle.loadGenerationId);
    expect(reset.ledger.generations).toEqual([
      expect.objectContaining({ loadGenerationId: first.lifecycle.loadGenerationId, state: "prior" }),
      expect.objectContaining({ loadGenerationId: reset.lifecycle.loadGenerationId, state: "current" }),
    ]);
  });

  it("preserves finalized-turn barriers across an ordinary worker restart", async () => {
    const store = new RuntimeStore();
    await store.hydrate();
    await store.updateSession((current) => ({
      ...current,
      finalizedTurns: [{
        contextId: "context-one",
        browserSessionId: "session-one",
        turnId: "turn-one",
        controlId: "control-one",
        createdAtMs: 10,
      }],
      finalizationControls: [{
        controlId: "control-one",
        canonicalRequestHash: "a".repeat(64),
        status: "completed",
        result: {
          contract_version: 1,
          control_id: "control-one",
          closed: ["lease-one"],
          released: [],
          retained: [],
          already_finalized: [],
          errors: [],
        },
        createdAtMs: 10,
        completedAtMs: 11,
      }],
    }));

    const resumed = await new RuntimeStore().hydrate();
    expect(resumed.session.finalizedTurns).toEqual([{
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      controlId: "control-one",
      createdAtMs: 10,
    }]);
    expect(resumed.session.finalizationControls).toEqual([
      expect.objectContaining({
        controlId: "control-one",
        status: "completed",
        result: expect.objectContaining({ closed: ["lease-one"] }),
      }),
    ]);
  });

  it("orphans legacy leases that have no distinct lease identity", async () => {
    const first = await new RuntimeStore().hydrate();
    const lease = createLease({
      tabHandle: createTabHandle(first.lifecycle.loadGenerationId),
      loadGenerationId: first.lifecycle.loadGenerationId,
      contextId: "context-one",
      browserSessionId: "session-one",
      turnId: "turn-one",
      origin: "created",
      disposition: "ephemeral",
      siteOrigin: "https://example.com",
      identity: {
        browserInstanceId: first.session.browserInstanceId,
        providerTabId: 7,
        providerWindowId: 4,
        documentId: null,
        documentEpoch: 0,
      },
    });
    const shadow = createDurableLeaseShadow({
      lease,
      rawUrl: "https://example.com/path",
      leaseIdDigest: "1".repeat(64),
      leaseHandleDigest: "2".repeat(64),
      exactIdentityDigest: "3".repeat(64),
      digestPath: () => "4".repeat(64),
      now: 1,
    });
    const { leaseId: _legacyLeaseId, ...legacyLease } = lease;
    const { leaseIdDigest: _legacyLeaseIdDigest, ...legacyShadow } = shadow;
    session.values[SESSION_RUNTIME_KEY] = {
      ...first.session,
      leasesByHandle: { [lease.tabHandle]: legacyLease },
    };
    local.values[LOCAL_LEDGER_KEY] = {
      ...first.ledger,
      leases: [legacyShadow],
    };

    const recovered = await new RuntimeStore().hydrate();

    expect(recovered.lifecycle.loadGenerationId).not.toBe(first.lifecycle.loadGenerationId);
    expect(recovered.session.leasesByHandle).toEqual({});
    expect(recovered.ledger.leases).toEqual([
      expect.objectContaining({ state: "orphan" }),
    ]);
  });
});
