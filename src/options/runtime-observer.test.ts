import { describe, expect, it, vi } from "vitest";
import { observeOptionsRuntime } from "./runtime-observer";

function fixture() {
  const messages = new Set<(message: unknown) => void>();
  const disconnects = new Set<() => void>();
  const disconnect = vi.fn();
  const postMessage = vi.fn();
  const port = {
    onMessage: { addListener: (fn: (message: unknown) => void) => messages.add(fn), removeListener: (fn: (message: unknown) => void) => messages.delete(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnects.add(fn), removeListener: (fn: () => void) => disconnects.delete(fn) },
    disconnect, postMessage,
  } as unknown as chrome.runtime.Port;
  const onState = vi.fn(), onDisconnected = vi.fn();
  const observer = observeOptionsRuntime(onState, onDisconnected, () => port);
  return { observer, messages, disconnects, disconnect, postMessage, onState, onDisconnected };
}

const state = (paired: boolean) => ({
  ready: false,
  bridge: {
    phase: "RECONCILING", connection: { state: "ready", reasonCode: "development_pairing_only", reportedServerState: paired ? "paired" : "unpaired", activationReady: false },
    capabilities: [], actions: [], activeLeaseCount: 0, candidateReady: false,
  },
});

describe("options worker presentation observer", () => {
  it("shows unpaired and paired worker pushes without refresh or control requests", () => {
    const f = fixture();
    for (const paired of [false, true]) for (const receive of f.messages) receive({ type: "state", state: state(paired) });
    expect(f.onState.mock.calls.map(([value]) => value.bridge.connection.reportedServerState)).toEqual(["unpaired", "paired"]);
    expect(f.onState.mock.calls.every(([value]) => value.ready === false)).toBe(true);
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("does not let a slow refresh or pairing response replace a newer worker push", () => {
    const f = fixture();
    const captured = f.observer.capture();
    for (const receive of f.messages) receive({ type: "state", state: state(true) });
    expect(f.observer.applyResponse(captured, state(false))).toBe(false);
    expect(f.onState).toHaveBeenCalledTimes(1);
    expect(f.observer.isCurrent(captured)).toBe(false);
  });

  it("accepts a request snapshot only until another snapshot supersedes it", () => {
    const f = fixture();
    const captured = f.observer.capture();
    expect(f.observer.applyResponse(captured, state(false))).toBe(true);
    expect(f.observer.applyResponse(captured, state(true))).toBe(false);
    for (const receive of f.messages) receive({ type: "context", state: state(true) });
    expect(f.onState).toHaveBeenCalledTimes(1);
  });

  it("removes the page subscription and rejects queued messages/responses on unmount", () => {
    const f = fixture();
    const queued = [...f.messages][0], captured = f.observer.capture();
    f.observer.close();
    f.observer.close();
    queued({ type: "state", state: state(true) });
    expect(f.observer.applyResponse(captured, state(true))).toBe(false);
    expect(f.observer.active).toBe(false);
    expect(f.messages.size).toBe(0);
    expect(f.disconnects.size).toBe(0);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(f.onState).not.toHaveBeenCalled();
  });

  it("invalidates pending responses when the worker port disconnects", () => {
    const f = fixture();
    const captured = f.observer.capture();
    for (const disconnected of [...f.disconnects]) disconnected();
    expect(f.observer.connected).toBe(false);
    expect(f.observer.applyResponse(captured, state(true))).toBe(false);
    expect(f.onDisconnected).toHaveBeenCalledTimes(1);
    expect(f.messages.size).toBe(0);
  });
});
