import { createCursorOverlay, OVERLAY_CSS, OVERLAY_HOST_TAG } from "./overlay";

class FakeStyle {
  values = new Map<string, { value: string; priority: string }>();
  setProperty(name: string, value: string, priority = "") {
    this.values.set(name, { value, priority });
  }
}

class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  className = "";
  dataset: Record<string, string> = {};
  hidden = false;
  removed = false;
  style = new FakeStyle();
  textContent = "";
  shadow: FakeElement | null = null;
  shadowMode = "";

  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...children: FakeElement[]) {
    this.children.push(...children);
  }
  attachShadow(options: { mode: string }) {
    this.shadowMode = options.mode;
    this.shadow = new FakeElement("shadow-root");
    return this.shadow;
  }
  remove() {
    this.removed = true;
  }
}

class FakeDocument {
  documentElement = new FakeElement("html");
  body = new FakeElement("body");
  createElement(tagName: string) {
    return new FakeElement(tagName);
  }
}

describe("cursor overlay", () => {
  it("is an inert, aria-hidden closed shadow overlay with no event hooks", () => {
    const ownerDocument = new FakeDocument();
    const view = createCursorOverlay(ownerDocument as unknown as Document);
    const host = ownerDocument.documentElement.children[0];

    expect(host.tagName).toBe(OVERLAY_HOST_TAG);
    expect(host.attributes.get("aria-hidden")).toBe("true");
    expect(host.attributes.has("inert")).toBe(true);
    expect(host.shadowMode).toBe("closed");
    expect(host.shadow).not.toBeNull();

    const viewport = host.shadow!.children[1];
    for (const child of [viewport, ...viewport.children, ...viewport.children[1].children]) {
      expect(child.attributes.get("aria-hidden")).toBe("true");
      expect(child.attributes.has("inert")).toBe(true);
    }

    view.setPosition(45, 60);
    expect(viewport.style.values.get("--a0-cursor-x")).toEqual({ value: "45px", priority: "important" });
    expect(viewport.style.values.get("--a0-cursor-y")).toEqual({ value: "60px", priority: "important" });
    view.remove();
    expect(host.removed).toBe(true);
  });

  it("defines non-interception, reduced-motion, and forced-colors rules", () => {
    expect(OVERLAY_CSS).toContain("pointer-events: none !important");
    expect(OVERLAY_CSS).toContain("user-select: none !important");
    expect(OVERLAY_CSS).toContain("prefers-reduced-motion: reduce");
    expect(OVERLAY_CSS).toContain("animation: none !important");
    expect(OVERLAY_CSS).toContain("forced-colors: active");
    expect(OVERLAY_CSS).toContain("CanvasText");
    expect(OVERLAY_CSS).toContain("box-shadow: none !important");
  });
});
