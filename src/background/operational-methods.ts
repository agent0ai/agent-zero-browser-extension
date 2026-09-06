import type { NativeMethod } from "../protocol/rpc";

// Companion → extension only. protocol-v1 §6 is the combined duplex method
// inventory; §13 artifact.begin/chunk/end/abort are extension client requests,
// not missing worker handlers. Input artifacts use the private native handoff.
export const REQUIRED_OPERATIONAL_INBOUND_METHODS = [
  "credential.changed",
  "bridge.ping",
  "context.snapshot",
  "context.event",
  "context.complete",
  "context.queue_updated",
  "browser.perform",
  "browser.cancel",
  "browser.finalize_turn",
  "browser.resolve_challenge",
  "browser.reconcile",
  "browser.ack_events",
] as const satisfies readonly NativeMethod[];

// Mirrors index.ts's actual worker dispatch; never add outbound client methods
// here to satisfy activation. Each entry must have a real inbound handler.
export const IMPLEMENTED_OPERATIONAL_INBOUND_METHODS: ReadonlySet<NativeMethod> = new Set([
  "credential.changed",
  "bridge.ping",
  "context.snapshot",
  "context.event",
  "context.complete",
  "context.queue_updated",
  "browser.perform",
  "browser.cancel",
  "browser.finalize_turn",
  "browser.resolve_challenge",
  "browser.reconcile",
  "browser.ack_events",
]);

export function operationalInboundSurfaceReady(
  implemented: ReadonlySet<NativeMethod> = IMPLEMENTED_OPERATIONAL_INBOUND_METHODS,
): boolean {
  return REQUIRED_OPERATIONAL_INBOUND_METHODS.every((method) => implemented.has(method));
}
