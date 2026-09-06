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
  defaultView = { innerWidth: 1000, innerHeight: 700 };
  documentElement = new FakeElement("html");
  body = new FakeElement("body");
  createElement(tagName: string) {
    return new FakeElement(tagName);
  }
  createElementNS(_namespace: string, tagName: string) {
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
    const pointer = viewport.children[1].children[0];
    expect(pointer.tagName).toBe("svg");
    expect(pointer.attributes.get("viewBox")).toBe("0 0 28 34");
    expect(pointer.attributes.get("focusable")).toBe("false");
    expect(pointer.children[0].attributes.get("d")).toBe("M3 3 L3 26 L9.5 20.5 L14 31 L19 28.5 L14.5 18 L23 17 Z");
    expect(pointer.children[0].attributes.get("aria-hidden")).toBe("true");
    expect(OVERLAY_CSS).toContain("transform: translate3d(-4.5px, -4.5px, 0)");
    expect(OVERLAY_CSS).toContain("transform-origin: 4.5px 4.5px");
    expect(OVERLAY_CSS).toContain("drop-shadow(0 0 11px #4285f4)");
    expect(viewport.children[1].children[1].textContent).toBe("Agent Zero");
    view.setState("activated", true, true);
    expect(viewport.dataset).toMatchObject({ state: "activated", reducedMotion: "true" });
    expect(viewport.children[1].children[1].hidden).toBe(false);
    view.remove();
    expect(host.removed).toBe(true);
    view.setPosition(100, 100);
    expect(viewport.style.values.get("--a0-cursor-x")?.value).toBe("45px");
  });

  it("keeps the tip fixed while turning the pointer and label inward at page edges", () => {
    const document = new FakeDocument();
    const view = createCursorOverlay(document as unknown as Document);
    const viewport = document.documentElement.children[0].shadow!.children[1];
    view.setPosition(992, 692);
    expect(viewport.style.values.get("--a0-cursor-x")?.value).toBe("992px");
    expect(viewport.style.values.get("--a0-cursor-y")?.value).toBe("692px");
    expect(viewport.style.values.get("--a0-cursor-flip-x")?.value).toBe("-1");
    expect(viewport.style.values.get("--a0-cursor-flip-y")?.value).toBe("-1");
    expect(viewport.style.values.get("--a0-cursor-label-x")?.value).toBe("-88px");
    expect(viewport.style.values.get("--a0-cursor-label-y")?.value).toBe("-24px");
    view.setPosition(200, 200);
    expect(viewport.style.values.get("--a0-cursor-flip-x")?.value).toBe("1");
    expect(viewport.style.values.get("--a0-cursor-flip-y")?.value).toBe("1");
  });

  it("defines non-interception, reduced-motion, and forced-colors rules", () => {
    expect(OVERLAY_CSS).toContain("pointer-events: none !important");
    expect(OVERLAY_CSS).toContain("user-select: none !important");
    expect(OVERLAY_CSS).toContain("prefers-reduced-motion: reduce");
    expect(OVERLAY_CSS).toContain("animation: none !important");
    expect(OVERLAY_CSS).toContain("forced-colors: active");
    expect(OVERLAY_CSS).toContain("CanvasText");
    expect(OVERLAY_CSS).toContain("box-shadow: none !important");
    expect(OVERLAY_CSS).toContain('data-reduced-motion="true"');
    expect(OVERLAY_CSS).toContain("fill: CanvasText !important; stroke: Canvas !important");
    expect(OVERLAY_CSS).toContain("animation: a0-cursor-activate 280ms ease-out 1");
    const ringRule = OVERLAY_CSS.split(".ring {")[1].split("}")[0];
    expect(ringRule).toContain("opacity: 0;");
    expect(ringRule).toContain("transform: translate3d(-50%, -50%, 0) scale(.72);");
    expect(ringRule).not.toMatch(/(?:opacity|transform):[^;]*!important/);
  });
});
