import { ElementReferenceRegistry, visiblePointForRect } from "./semantics";

describe("ElementReferenceRegistry", () => {
  it("creates opaque document-bound references rather than selectors", () => {
    const ownerDocument = {} as Document;
    const element = { ownerDocument, isConnected: true } as unknown as Element;
    const registry = new ElementReferenceRegistry("epoch:123", ownerDocument, () => "0123456789abcdef");

    const reference = registry.register(element);

    expect(reference).toBe("doc:epoch123:0123456789abcdef");
    expect(reference).not.toContain("nth-of-type");
    expect(registry.resolve(reference)).toEqual({ ok: true, element });
    expect(registry.register(element)).toBe(reference);
  });

  it("invalidates detached and released document references", () => {
    const ownerDocument = {} as Document;
    const element = { ownerDocument, isConnected: true } as unknown as Element;
    const registry = new ElementReferenceRegistry("epoch", ownerDocument, () => "random");
    const reference = registry.register(element);

    (element as unknown as { isConnected: boolean }).isConnected = false;
    expect(registry.resolve(reference)).toEqual({ ok: false, code: "STALE_ELEMENT_REFERENCE" });

    registry.invalidate();
    expect(registry.resolve(reference)).toEqual({ ok: false, code: "STALE_ELEMENT_REFERENCE" });
  });
});

describe("visiblePointForRect", () => {
  it("chooses the center of only the visible portion", () => {
    expect(
      visiblePointForRect(
        { left: -100, right: 100, top: 20, bottom: 80, width: 200, height: 60 },
        { width: 500, height: 400 },
      ),
    ).toEqual({ ok: true, point: { x: 50, y: 50 } });
  });

  it("rejects offscreen and zero-size targets", () => {
    expect(
      visiblePointForRect(
        { left: 600, right: 700, top: 20, bottom: 80, width: 100, height: 60 },
        { width: 500, height: 400 },
      ),
    ).toEqual({ ok: false, code: "TARGET_NOT_VISIBLE" });
    expect(
      visiblePointForRect(
        { left: 20, right: 20, top: 20, bottom: 80, width: 0, height: 60 },
        { width: 500, height: 400 },
      ),
    ).toEqual({ ok: false, code: "TARGET_NOT_VISIBLE" });
  });
});
