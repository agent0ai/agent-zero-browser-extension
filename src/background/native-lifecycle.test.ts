import { describe, expect, it, vi } from "vitest";
import { NativeLifecycleQueue } from "./native-lifecycle";
import type { NativeConnectionSnapshot } from "./native-port";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const ready = (id: string): NativeConnectionSnapshot => ({
  state: "ready", connectionId: id, reasonCode: "native_ready", activationReady: true,
});

describe("native connection initialization barrier", () => {
  it("holds early and repeated reconciliation behind ready persistence without regressing READY", async () => {
    const connection = ready("one");
    const queue = new NativeLifecycleQueue(() => connection);
    const writing = deferred();
    const entered = deferred();
    const failed = vi.fn();
    let phase = "NEGOTIATING";
    let persistedId: string | undefined;
    queue.observe(connection, async (guard) => {
      entered.resolve();
      await writing.promise;
      guard();
      persistedId = connection.connectionId;
      phase = "RECONCILING";
    }, failed);
    await entered.promise;
    const reconcile = vi.fn(async () => {
      expect(persistedId).toBe("one");
      expect(["RECONCILING", "READY"]).toContain(phase);
      phase = "READY";
    });
    const first = queue.reconcile(reconcile);
    const second = queue.reconcile(reconcile);
    expect(reconcile).not.toHaveBeenCalled();
    writing.resolve();
    await Promise.all([first, second]);
    expect(phase).toBe("READY");
    expect(failed).not.toHaveBeenCalled();
  });

  it.each([false, true])("abandons stale ready initialization and reconcile on replacement (write rejects: %s)", async (rejectWrite) => {
    let connection = ready("old");
    const queue = new NativeLifecycleQueue(() => connection);
    const writing = deferred();
    const entered = deferred();
    const failed = vi.fn();
    const oldEffects = vi.fn();
    queue.observe(connection, async (guard) => {
      entered.resolve();
      await writing.promise;
      guard();
      oldEffects();
    }, failed);
    await entered.promise;
    const stale = queue.reconcile(async () => { oldEffects(); });
    const staleRejected = expect(stale).rejects.toMatchObject({ a0Code: "INVALID_STATE" });
    connection = { state: "connecting", reasonCode: "native_connecting" };
    queue.observe(connection, async (guard) => { guard(); }, failed);
    connection = ready("new");
    let phase = "NEGOTIATING";
    queue.observe(connection, async (guard) => { guard(); phase = "RECONCILING"; }, failed);
    const replacement = queue.reconcile(async (guard, current) => {
      guard();
      expect(current.connectionId).toBe("new");
      expect(phase).toBe("RECONCILING");
      phase = "READY";
    });
    if (rejectWrite) writing.reject(new Error("old persistence failed"));
    else writing.resolve();
    await staleRejected;
    await replacement;
    expect(phase).toBe("READY");
    expect(oldEffects).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("rechecks the original connection after an awaited READY write before publishing", async () => {
    let connection = ready("old");
    const queue = new NativeLifecycleQueue(() => connection);
    const writing = deferred();
    const entered = deferred();
    const publish = vi.fn();
    const result = queue.reconcile(async (guard) => {
      entered.resolve();
      await writing.promise;
      guard();
      publish();
    });
    const rejected = expect(result).rejects.toMatchObject({ a0Code: "INVALID_STATE" });
    await entered.promise;
    // The synchronous live getter alone revokes even before a queued projection.
    connection = ready("replacement");
    writing.resolve();
    await rejected;
    expect(publish).not.toHaveBeenCalled();
  });
});
