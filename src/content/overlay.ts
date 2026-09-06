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
  width: 28px !important;
  height: 34px !important;
  transform: translate3d(-3px, -3px, 0) !important;
}
.pointer {
  display: block !important;
  width: 28px !important;
  height: 34px !important;
  overflow: visible !important;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .55)) drop-shadow(0 0 5px rgba(66, 133, 244, .9)) !important;
}
.pointer path {
  fill: #151b26 !important;
  stroke: #fff !important;
  stroke-width: 1.75px !important;
  stroke-linejoin: round !important;
}
.ring {
  position: absolute !important;
  top: var(--a0-cursor-y, -100px) !important;
  left: var(--a0-cursor-x, -100px) !important;
  width: 30px !important;
  height: 30px !important;
  border: 1.5px solid #76a7fa !important;
  border-radius: 999px !important;
  box-shadow: 0 0 5px rgba(66, 133, 244, .45) !important;
  opacity: 0;
  transform: translate3d(-50%, -50%, 0) scale(.72);
}
.label {
  position: absolute !important;
  inset-block-start: 20px !important;
  inset-inline-start: 26px !important;
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
  opacity: .65 !important;
}
.viewport[data-state="activated"] .ring {
  animation: a0-cursor-activate 280ms ease-out 1 !important;
}
@keyframes a0-cursor-activate {
  0% { opacity: .75; transform: translate3d(-50%, -50%, 0) scale(.72); }
  100% { opacity: 0; transform: translate3d(-50%, -50%, 0) scale(1.18); }
}
.viewport[data-reduced-motion="true"][data-state="activated"] .ring {
  animation: none !important;
  opacity: .65 !important;
}
@media (prefers-reduced-motion: reduce) {
  .viewport[data-state="activated"] .ring {
    animation: none !important;
    opacity: 1 !important;
  }
}
@media (forced-colors: active) {
  .pointer, .ring, .label {
    forced-color-adjust: none !important;
    border-color: CanvasText !important;
    outline: 2px solid Highlight !important;
    box-shadow: none !important;
  }
  .pointer { filter: none !important; outline: none !important; }
  .pointer path { fill: CanvasText !important; stroke: Canvas !important; }
  .label { background: Canvas !important; color: CanvasText !important; }
}
`;

const hideFromAccessibility = (element: Element): void => {
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

  const pointer = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  pointer.setAttribute("class", "pointer");
  pointer.setAttribute("viewBox", "0 0 28 34");
  pointer.setAttribute("focusable", "false");
  hideFromAccessibility(pointer);
  const arrow = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  // The tip at (3, 3) cancels the cursor's (-3px, -3px) offset exactly.
  arrow.setAttribute("d", "M3 3 L3 26 L9.5 20.5 L14 31 L19 28.5 L14.5 18 L23 17 Z");
  hideFromAccessibility(arrow);
  pointer.append(arrow);

  const label = ownerDocument.createElement("span");
  label.className = "label";
  label.textContent = "A0";
  label.hidden = true;
  hideFromAccessibility(label);

  cursor.append(pointer, label);
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
