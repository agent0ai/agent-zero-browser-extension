import {
  CursorController,
  CursorMoveInterruptedError,
  MAX_CURSOR_TRAVEL_MS,
  type AnimationScheduler,
} from "./cursor";
import type { CursorOverlayView, CursorVisualState } from "./overlay";

class FakeScheduler implements AnimationScheduler {
  time = 0;
  nextHandle = 1;
  frames = new Map<number, FrameRequestCallback>();
  cancelled: number[] = [];

  now() {
    return this.time;
  }

  requestFrame(callback: FrameRequestCallback) {
    const handle = this.nextHandle++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number) {
    this.cancelled.push(handle);
    this.frames.delete(handle);
  }

  runNext(timestamp: number) {
    const entry = this.frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error("No animation frame is queued.");
    this.frames.delete(entry[0]);
    this.time = timestamp;
    entry[1](timestamp);
  }
}

const fakeOverlay = () => {
  const positions: Array<{ x: number; y: number }> = [];
  const states: Array<{ state: CursorVisualState; reduced: boolean }> = [];
  let removals = 0;
  const view: CursorOverlayView = {
    setPosition: (x, y) => positions.push({ x, y }),
    setState: (state, _label, reduced) => states.push({ state, reduced }),
    remove: () => {
      removals += 1;
    },
  };
  return { view, positions, states, removals: () => removals };
};

describe("CursorController", () => {
  it("clamps endpoints and caps requestAnimationFrame travel at 600ms", async () => {
    const overlay = fakeOverlay();
    const scheduler = new FakeScheduler();
    const cursor = new CursorController(
      () => overlay.view,
      scheduler,
      { viewport: () => ({ width: 1_000, height: 700 }), reducedMotion: () => false },
    );

    await cursor.moveTo({ x: -200, y: -10 });
    expect(cursor.currentPoint).toEqual({ x: 8, y: 8 });

    const travelling = cursor.moveTo({ x: 20_000, y: 20_000 });
    scheduler.runNext(MAX_CURSOR_TRAVEL_MS - 1);
    expect(scheduler.frames.size).toBe(1);
    scheduler.runNext(MAX_CURSOR_TRAVEL_MS);

    await expect(travelling).resolves.toEqual({ x: 992, y: 692 });
    expect(overlay.states.at(-1)).toEqual({ state: "targeting", reduced: false });
  });

  it("positions instantly and keeps activation static under reduced motion", async () => {
    const overlay = fakeOverlay();
    const scheduler = new FakeScheduler();
    const cursor = new CursorController(
      () => overlay.view,
      scheduler,
      { viewport: () => ({ width: 400, height: 300 }), reducedMotion: () => true },
    );

    await cursor.moveTo({ x: 100, y: 120 });
    await cursor.moveTo({ x: 200, y: 220 });
    cursor.activate();

    expect(scheduler.frames.size).toBe(0);
    expect(overlay.states.at(-1)).toEqual({ state: "activated", reduced: true });
  });

  it("interrupts in-flight travel and removes the overlay on teardown", async () => {
    const overlay = fakeOverlay();
    const scheduler = new FakeScheduler();
    const cursor = new CursorController(
      () => overlay.view,
      scheduler,
      { viewport: () => ({ width: 800, height: 600 }), reducedMotion: () => false },
    );

    await cursor.moveTo({ x: 20, y: 20 });
    const travelling = cursor.moveTo({ x: 700, y: 500 });
    cursor.teardown();

    await expect(travelling).rejects.toBeInstanceOf(CursorMoveInterruptedError);
    expect(scheduler.cancelled).toHaveLength(1);
    expect(overlay.removals()).toBe(1);
    expect(cursor.currentPoint).toBeNull();
  });
});
