export type CursorVisualState = "activated" | "frozen" | "targeting" | "travelling";

export interface CursorOverlayView {
  setPosition(x: number, y: number): void;
  setState(state: CursorVisualState, showLabel: boolean, reducedMotion: boolean): void;
  remove(): void;
}

export const OVERLAY_HOST_TAG = "a0-browser-cursor";

export const OVERLAY_CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483646 !important;
  width: 100vw !important;
  height: 100vh !important;
  contain: strict !important;
  overflow: hidden !important;
  pointer-events: none !important;
  user-select: none !important;
}
*, *::before, *::after {
  box-sizing: border-box !important;
  pointer-events: none !important;
  user-select: none !important;
}
.viewport {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  overflow: hidden !important;
}
.cursor {
  position: absolute !important;
  top: var(--a0-cursor-y, -100px) !important;
  left: var(--a0-cursor-x, -100px) !important;
  width: 18px !important;
  height: 18px !important;
  border: 2px solid #fff !important;
  border-radius: 999px !important;
  background: #2b5ab9 !important;
  box-shadow: 0 0 0 1px #000, 0 0 0 7px rgba(43, 90, 185, .2) !important;
  transform: translate3d(-50%, -50%, 0) !important;
}
.cursor::after {
  content: "" !important;
  position: absolute !important;
  inset: 4px !important;
  border-radius: inherit !important;
  background: #fff !important;
  outline: 1px solid #000 !important;
}
.ring {
  position: absolute !important;
  top: var(--a0-cursor-y, -100px) !important;
  left: var(--a0-cursor-x, -100px) !important;
  width: 38px !important;
  height: 38px !important;
  border: 2px solid #fff !important;
  border-radius: 999px !important;
  outline: 1px solid #000 !important;
  opacity: 0 !important;
  transform: translate3d(-50%, -50%, 0) scale(.72) !important;
}
.label {
  position: absolute !important;
  inset-block-start: 14px !important;
  inset-inline-start: 14px !important;
  min-width: 25px !important;
  padding: 3px 6px !important;
  border: 1px solid #fff !important;
  border-radius: 999px !important;
  background: #111 !important;
  color: #fff !important;
  font: 600 11px/1 system-ui, sans-serif !important;
  letter-spacing: .02em !important;
  text-align: center !important;
  white-space: nowrap !important;
}
.viewport[data-state="targeting"] .ring,
.viewport[data-state="frozen"] .ring {
  opacity: 1 !important;
}
.viewport[data-state="activated"] .ring {
  animation: a0-cursor-activate 280ms ease-out 1 !important;
}
@keyframes a0-cursor-activate {
  0% { opacity: 1; transform: translate3d(-50%, -50%, 0) scale(.72); }
  100% { opacity: 0; transform: translate3d(-50%, -50%, 0) scale(1.18); }
}
@media (prefers-reduced-motion: reduce) {
  .viewport[data-state="activated"] .ring {
    animation: none !important;
    opacity: 1 !important;
  }
}
@media (forced-colors: active) {
  .cursor, .ring, .label {
    forced-color-adjust: none !important;
    border-color: CanvasText !important;
    outline: 2px solid Highlight !important;
    box-shadow: none !important;
  }
  .cursor { background: Highlight !important; }
  .cursor::after { background: CanvasText !important; outline-color: Canvas !important; }
  .label { background: Canvas !important; color: CanvasText !important; }
}
`;

const hideFromAccessibility = (element: HTMLElement): void => {
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("inert", "");
};

export const createCursorOverlay = (ownerDocument: Document = document): CursorOverlayView => {
  const host = ownerDocument.createElement(OVERLAY_HOST_TAG);
  hideFromAccessibility(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = ownerDocument.createElement("style");
  style.textContent = OVERLAY_CSS;

  const viewport = ownerDocument.createElement("div");
  viewport.className = "viewport";
  viewport.dataset.state = "travelling";
  hideFromAccessibility(viewport);

  const ring = ownerDocument.createElement("div");
  ring.className = "ring";
  hideFromAccessibility(ring);

  const cursor = ownerDocument.createElement("div");
  cursor.className = "cursor";
  hideFromAccessibility(cursor);

  const label = ownerDocument.createElement("span");
  label.className = "label";
  label.textContent = "A0";
  label.hidden = true;
  hideFromAccessibility(label);

  cursor.append(label);
  viewport.append(ring, cursor);
  shadow.append(style, viewport);
  (ownerDocument.documentElement || ownerDocument.body).append(host);

  let removed = false;
  return {
    setPosition(x, y) {
      if (removed) return;
      viewport.style.setProperty("--a0-cursor-x", `${x}px`, "important");
      viewport.style.setProperty("--a0-cursor-y", `${y}px`, "important");
    },
    setState(state, showLabel, reducedMotion) {
      if (removed) return;
      viewport.dataset.state = state;
      viewport.dataset.reducedMotion = reducedMotion ? "true" : "false";
      label.hidden = !showLabel;
    },
    remove() {
      if (removed) return;
      removed = true;
      host.remove();
    },
  };
};
