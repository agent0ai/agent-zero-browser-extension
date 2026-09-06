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
  const visibility: boolean[] = [];
  let removals = 0;
  const view: CursorOverlayView = {
    setVisible: (visible) => visibility.push(visible),
    setPosition: (x, y) => positions.push({ x, y }),
    setState: (state, _label, reduced) => states.push({ state, reduced }),
    remove: () => {
      removals += 1;
    },
  };
  return { view, positions, states, visibility, removals: () => removals };
};

describe("CursorController", () => {
  it("suspends without losing the real point and animates the next move after restoration", async () => {
    const overlay = fakeOverlay();
    const scheduler = new FakeScheduler();
    const create = vi.fn(() => overlay.view);
    const cursor = new CursorController(create, scheduler,
      { viewport: () => ({ width: 800, height: 600 }), reducedMotion: () => false });
    cursor.resume(cursor.suspend());
    expect(create).not.toHaveBeenCalled();
    await cursor.moveTo({ x: 100, y: 100 });
    const token = cursor.suspend();
    expect(cursor.currentPoint).toEqual({ x: 100, y: 100 });
    cursor.resume(token);
    expect(overlay.visibility).toEqual([false, true]);
    const travel = cursor.moveTo({ x: 120, y: 100 });
    expect(scheduler.frames.size).toBe(1);
    expect(cursor.currentPoint).toEqual({ x: 100, y: 100 });
    scheduler.runNext(240);
    await travel;
    expect(create).toHaveBeenCalledTimes(1);
    const stale = cursor.suspend();
    const later = cursor.moveTo({ x: 140, y: 100 });
    const visibleCount = overlay.visibility.length;
    cursor.resume(stale);
    expect(overlay.visibility).toHaveLength(visibleCount);
    scheduler.runNext(480);
    await later;
    const ended = cursor.suspend();
    cursor.teardown();
    cursor.resume(ended);
    expect(create).toHaveBeenCalledTimes(1);
    expect(cursor.currentPoint).toBeNull();
  });
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

  it("makes short real movements visible without exceeding the travel cap", async () => {
    const overlay = fakeOverlay();
    const scheduler = new FakeScheduler();
    const cursor = new CursorController(() => overlay.view, scheduler,
      { viewport: () => ({ width: 800, height: 600 }), reducedMotion: () => false });
    await cursor.moveTo({ x: 100, y: 100 });
    const travelling = cursor.moveTo({ x: 120, y: 100 });
    scheduler.runNext(120);
    expect(cursor.currentPoint!.x).toBeGreaterThan(100);
    expect(cursor.currentPoint!.x).toBeLessThan(120);
    scheduler.runNext(240);
    await expect(travelling).resolves.toEqual({ x: 120, y: 100 });
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
