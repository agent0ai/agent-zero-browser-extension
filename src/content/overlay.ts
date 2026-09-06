export type CursorVisualState = "activated" | "frozen" | "targeting" | "travelling";

export interface CursorOverlayView {
  setVisible(visible: boolean): void;
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
  transform-origin: 3px 3px !important;
  transform: scale(var(--a0-cursor-flip-x, 1), var(--a0-cursor-flip-y, 1)) !important;
  filter: drop-shadow(0 1px 2px #000) drop-shadow(0 0 4px #79b8ff) drop-shadow(0 0 11px #4285f4) !important;
}
.pointer path {
  fill: #151b26 !important;
  stroke: #fff !important;
  stroke-width: 2px !important;
  stroke-linejoin: round !important;
}
.ring {
  position: absolute !important;
  top: var(--a0-cursor-y, -100px) !important;
  left: var(--a0-cursor-x, -100px) !important;
  width: 32px !important;
  height: 32px !important;
  border: 2px solid #8fc7ff !important;
  border-radius: 999px !important;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .55), 0 0 12px rgba(66, 133, 244, .8) !important;
  opacity: 0;
  transform: translate3d(-50%, -50%, 0) scale(.72);
}
.viewport[data-state="targeting"] .ring,
.viewport[data-state="frozen"] .ring {
  opacity: .85 !important;
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
  .pointer, .ring {
    forced-color-adjust: none !important;
    border-color: CanvasText !important;
    outline: 2px solid Highlight !important;
    box-shadow: none !important;
  }
  .pointer { filter: none !important; outline: none !important; }
  .pointer path { fill: CanvasText !important; stroke: Canvas !important; }
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
  // At native size, the tip (3, 3) cancels the (-3px, -3px) offset.
  // Edge mirroring uses that same tip as its origin; input coordinates never move.
  arrow.setAttribute("d", "M3 3 L3 26 L9.5 20.5 L14 31 L19 28.5 L14.5 18 L23 17 Z");
  hideFromAccessibility(arrow);
  pointer.append(arrow);

  cursor.append(pointer);
  viewport.append(ring, cursor);
  shadow.append(style, viewport);
  (ownerDocument.documentElement || ownerDocument.body).append(host);

  let removed = false;
  return {
    setVisible(visible) {
      if (removed) return;
      viewport.style.setProperty("display", visible ? "block" : "none", "important");
    },
    setPosition(x, y) {
      if (removed) return;
      viewport.style.setProperty("--a0-cursor-x", `${x}px`, "important");
      viewport.style.setProperty("--a0-cursor-y", `${y}px`, "important");
      const width = ownerDocument.defaultView?.innerWidth ?? ownerDocument.documentElement?.clientWidth ?? Infinity;
      const height = ownerDocument.defaultView?.innerHeight ?? ownerDocument.documentElement?.clientHeight ?? Infinity;
      const nearRight = x > width - 40;
      const nearBottom = y > height - 48;
      viewport.style.setProperty("--a0-cursor-flip-x", nearRight ? "-1" : "1", "important");
      viewport.style.setProperty("--a0-cursor-flip-y", nearBottom ? "-1" : "1", "important");
    },
    // Keep the protocol-compatible argument; the visual deliberately has no label.
    setState(state, _showLabel, reducedMotion) {
      if (removed) return;
      viewport.dataset.state = state;
      viewport.dataset.reducedMotion = reducedMotion ? "true" : "false";
    },
    remove() {
      if (removed) return;
      removed = true;
      host.remove();
    },
  };
};
