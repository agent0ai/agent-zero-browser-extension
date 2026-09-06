import { describe, expect, it } from "vitest";
import {
  IMPLEMENTED_OPERATIONAL_INBOUND_METHODS,
  REQUIRED_OPERATIONAL_INBOUND_METHODS,
  operationalInboundSurfaceReady,
} from "./operational-methods";

describe("operational inbound method direction", () => {
  it("admits the implemented worker surface without requiring outbound artifact handlers", () => {
    expect(operationalInboundSurfaceReady()).toBe(true);
    for (const method of ["artifact.begin", "artifact.chunk", "artifact.end", "artifact.abort"] as const) {
      expect(REQUIRED_OPERATIONAL_INBOUND_METHODS).not.toContain(method);
      expect(IMPLEMENTED_OPERATIONAL_INBOUND_METHODS.has(method)).toBe(false);
    }
  });

  it("fails closed for every missing required inbound handler", () => {
    for (const method of REQUIRED_OPERATIONAL_INBOUND_METHODS) {
      const implemented = new Set(IMPLEMENTED_OPERATIONAL_INBOUND_METHODS);
      implemented.delete(method);
      expect(operationalInboundSurfaceReady(implemented), method).toBe(false);
    }
  });
});
