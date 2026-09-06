import type { CursorOverlayView } from "./overlay";

export const MAX_CURSOR_TRAVEL_MS = 600;
const VIEWPORT_MARGIN_PX = 8;

export type CursorPoint = { x: number; y: number };

export interface AnimationScheduler {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

export type CursorEnvironment = {
  viewport(): { width: number; height: number };
  reducedMotion(): boolean;
};

export class CursorMoveInterruptedError extends Error {
  constructor() {
    super("Cursor travel was interrupted by a newer state.");
    this.name = "CursorMoveInterruptedError";
  }
}

const defaultScheduler: AnimationScheduler = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

const defaultEnvironment: CursorEnvironment = {
  viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

export const clampToViewport = (point: CursorPoint, viewport: { width: number; height: number }): CursorPoint => ({
  x: Math.min(Math.max(VIEWPORT_MARGIN_PX, point.x), Math.max(VIEWPORT_MARGIN_PX, viewport.width - VIEWPORT_MARGIN_PX)),
  y: Math.min(Math.max(VIEWPORT_MARGIN_PX, point.y), Math.max(VIEWPORT_MARGIN_PX, viewport.height - VIEWPORT_MARGIN_PX)),
});

export class CursorController {
  private frameHandle: number | null = null;
  private point: CursorPoint | null = null;
  private overlay: CursorOverlayView | null = null;
  private rejectPendingMove: ((reason: CursorMoveInterruptedError) => void) | null = null;
  private showLabel = true;
  private visibilityEpoch = 0;
  private suspendedEpoch: number | null = null;

  constructor(
    private readonly createOverlay: () => CursorOverlayView,
    private readonly scheduler: AnimationScheduler = defaultScheduler,
    private readonly environment: CursorEnvironment = defaultEnvironment,
  ) {}

  get currentPoint(): CursorPoint | null {
    return this.point ? { ...this.point } : null;
  }

  moveTo(destination: CursorPoint, showLabel = true): Promise<CursorPoint> {
    this.visibilityEpoch += 1;
    this.suspendedEpoch = null;
    this.overlay?.setVisible(true);
    this.cancelAnimation();
    const target = clampToViewport(destination, this.environment.viewport());
    const overlay = this.ensureOverlay();
    const reducedMotion = this.environment.reducedMotion();
    this.showLabel = showLabel;

    if (this.point === null || reducedMotion) {
      this.point = target;
      overlay.setPosition(target.x, target.y);
      overlay.setState("targeting", showLabel, reducedMotion);
      return Promise.resolve({ ...target });
    }

    const start = { ...this.point };
    const startedAt = this.scheduler.now();
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const duration = Math.min(MAX_CURSOR_TRAVEL_MS, Math.max(240, distance * 1.35));
    overlay.setState("travelling", showLabel, false);

    return new Promise((resolve, reject) => {
      this.rejectPendingMove = reject;
      const step = (timestamp: number) => {
        const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / duration));
        const eased = 1 - Math.pow(1 - progress, 3);
        this.point = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
        };
        overlay.setPosition(this.point.x, this.point.y);

        if (progress < 1) {
          this.frameHandle = this.scheduler.requestFrame(step);
          return;
        }

        this.frameHandle = null;
        this.rejectPendingMove = null;
        this.point = target;
        overlay.setPosition(target.x, target.y);
        overlay.setState("targeting", showLabel, false);
        resolve({ ...target });
      };
      this.frameHandle = this.scheduler.requestFrame(step);
    });
  }

  activate(showLabel = this.showLabel): CursorPoint | null {
    if (!this.point) return null;
    this.ensureOverlay().setState("activated", showLabel, this.environment.reducedMotion());
    return { ...this.point };
  }

  freeze(showLabel = this.showLabel): CursorPoint | null {
    this.cancelAnimation();
    if (!this.point || !this.overlay) return null;
    this.overlay.setState("frozen", showLabel, this.environment.reducedMotion());
    return { ...this.point };
  }

  suspend(): number | null {
    if (!this.overlay || !this.point) return null;
    this.suspendedEpoch = this.visibilityEpoch;
    this.overlay.setVisible(false);
    return this.suspendedEpoch;
  }

  resume(epoch: number | null): void {
    if (epoch === null || epoch !== this.suspendedEpoch || epoch !== this.visibilityEpoch || !this.overlay || !this.point) return;
    this.suspendedEpoch = null;
    this.overlay.setVisible(true);
  }

  teardown(): void {
    this.visibilityEpoch += 1;
    this.suspendedEpoch = null;
    this.cancelAnimation();
    this.overlay?.remove();
    this.overlay = null;
    this.point = null;
    this.showLabel = true;
  }

  private ensureOverlay(): CursorOverlayView {
    if (!this.overlay) this.overlay = this.createOverlay();
    return this.overlay;
  }

  private cancelAnimation(): void {
    if (this.frameHandle !== null) {
      this.scheduler.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.rejectPendingMove) {
      const reject = this.rejectPendingMove;
      this.rejectPendingMove = null;
      reject(new CursorMoveInterruptedError());
    }
  }
}
