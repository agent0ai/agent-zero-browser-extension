import type { TabLease } from "./leases";
import { NativeRequestError } from "./native-port";
import { consumeInputArtifactPath, type VerifiedInputArtifact } from "./input-artifact";

export interface DebuggerLeaseBinding {
  actionId: string;
  leaseId: string;
  tabHandle: string;
  providerTabId: number;
}

export type ScreenshotCaptureOptions =
  | { format: "png" }
  | { format: "jpeg"; quality: number };

export interface ScreenshotDebuggerHost {
  attach(binding: DebuggerLeaseBinding): Promise<void>;
  capture(binding: DebuggerLeaseBinding, options: ScreenshotCaptureOptions): Promise<string>;
  dispatchHover(binding: DebuggerLeaseBinding, point: { x: number; y: number }): Promise<void>;
  dispatchClickPhase(
    binding: DebuggerLeaseBinding,
    phase: "mousePressed" | "mouseReleased",
    point: { x: number; y: number },
  ): Promise<void>;
  resolveBackendNodeAtPoint(binding: DebuggerLeaseBinding, point: { x: number; y: number }): Promise<number>;
  focusBackendNode(binding: DebuggerLeaseBinding, backendNodeId: number): Promise<void>;
  insertText(binding: DebuggerLeaseBinding, text: string): Promise<void>;
  setInputFile?(binding: DebuggerLeaseBinding, backendNodeId: number, artifact: VerifiedInputArtifact,
    assertAuthority: () => void): Promise<void>;
  detach(binding: DebuggerLeaseBinding): Promise<boolean>;
  detachLease(lease: TabLease): Promise<boolean>;
  observeDetached(source: chrome.debugger.Debuggee): DebuggerLeaseBinding | null;
}

function sameBinding(actual: DebuggerLeaseBinding | undefined, expected: DebuggerLeaseBinding): boolean {
  return Boolean(
    actual
    && actual.actionId === expected.actionId
    && actual.leaseId === expected.leaseId
    && actual.tabHandle === expected.tabHandle
    && actual.providerTabId === expected.providerTabId,
  );
}

export function debuggerBindingForLease(lease: TabLease, actionId: string): DebuggerLeaseBinding {
  return {
    actionId,
    leaseId: lease.leaseId,
    tabHandle: lease.tabHandle,
    providerTabId: lease.identity.providerTabId,
  };
}

export class ChromeScreenshotDebuggerHost implements ScreenshotDebuggerHost {
  private readonly attached = new Map<number, DebuggerLeaseBinding>();

  async attach(binding: DebuggerLeaseBinding): Promise<void> {
    if (this.attached.has(binding.providerTabId)) {
      throw new NativeRequestError("The leased tab already has an extension-owned debugger session.", "CDP_ATTACH_FAILED");
    }
    try {
      await chrome.debugger.attach({ tabId: binding.providerTabId }, "1.3");
      this.attached.set(binding.providerTabId, { ...binding });
    } catch {
      throw new NativeRequestError("Chrome did not confirm the debugger attachment.", "CDP_ATTACH_FAILED", "unknown");
    }
  }

  async capture(binding: DebuggerLeaseBinding, options: ScreenshotCaptureOptions): Promise<string> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) {
      throw new NativeRequestError("The debugger session is not bound to this exact lease operation.", "TAB_IDENTITY_MISMATCH");
    }
    let result: unknown;
    try {
      result = await chrome.debugger.sendCommand(
        { tabId: binding.providerTabId },
        "Page.captureScreenshot",
        {
          format: options.format,
          ...(options.format === "jpeg" ? { quality: options.quality } : {}),
          fromSurface: true,
          captureBeyondViewport: false,
        },
      );
    } catch {
      throw new NativeRequestError("Chrome did not return a certain screenshot outcome.", "OUTCOME_UNKNOWN", "unknown");
    }
    if (
      typeof result !== "object"
      || result === null
      || Array.isArray(result)
      || Object.keys(result).some((key) => key !== "data")
      || typeof (result as { data?: unknown }).data !== "string"
    ) {
      throw new NativeRequestError("Chrome returned a malformed screenshot result.", "OUTCOME_UNKNOWN", "unknown");
    }
    return (result as { data: string }).data;
  }

  async dispatchHover(binding: DebuggerLeaseBinding, point: { x: number; y: number }): Promise<void> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) {
      throw new NativeRequestError("The debugger session is not bound to this exact hover operation.", "TAB_IDENTITY_MISMATCH");
    }
    if (
      !Number.isFinite(point.x)
      || !Number.isFinite(point.y)
      || point.x < 0
      || point.y < 0
      || point.x > 100_000
      || point.y > 100_000
    ) throw new NativeRequestError("The resolved hover point is outside the bounded viewport domain.", "INVALID_STATE");
    try {
      await chrome.debugger.sendCommand(
        { tabId: binding.providerTabId },
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "none",
          buttons: 0,
          pointerType: "mouse",
        },
      );
    } catch {
      throw new NativeRequestError("Chrome did not return a certain hover outcome.", "OUTCOME_UNKNOWN", "unknown");
    }
  }

  async dispatchClickPhase(
    binding: DebuggerLeaseBinding,
    phase: "mousePressed" | "mouseReleased",
    point: { x: number; y: number },
  ): Promise<void> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) {
      throw new NativeRequestError("The debugger session is not bound to this exact click operation.", "TAB_IDENTITY_MISMATCH");
    }
    if (
      !Number.isFinite(point.x)
      || !Number.isFinite(point.y)
      || point.x < 0
      || point.y < 0
      || point.x > 100_000
      || point.y > 100_000
    ) throw new NativeRequestError("The resolved click point is outside the bounded viewport domain.", "INVALID_STATE");
    try {
      await chrome.debugger.sendCommand(
        { tabId: binding.providerTabId },
        "Input.dispatchMouseEvent",
        {
          type: phase,
          x: point.x,
          y: point.y,
          button: "left",
          buttons: phase === "mousePressed" ? 1 : 0,
          clickCount: 1,
          pointerType: "mouse",
        },
      );
    } catch {
      throw new NativeRequestError("Chrome did not return a certain click phase outcome.", "OUTCOME_UNKNOWN", "unknown");
    }
  }

  async resolveBackendNodeAtPoint(
    binding: DebuggerLeaseBinding,
    point: { x: number; y: number },
  ): Promise<number> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) {
      throw new NativeRequestError("The debugger session is not bound to this exact type operation.", "TAB_IDENTITY_MISMATCH");
    }
    if (
      !Number.isSafeInteger(point.x)
      || !Number.isSafeInteger(point.y)
      || point.x < 0
      || point.y < 0
      || point.x > 100_000
      || point.y > 100_000
    ) throw new NativeRequestError("The resolved type point is outside the bounded viewport domain.", "INVALID_STATE");
    let result: unknown;
    try {
      result = await chrome.debugger.sendCommand(
        { tabId: binding.providerTabId },
        "DOM.getNodeForLocation",
        {
          x: point.x,
          y: point.y,
          includeUserAgentShadowDOM: false,
          ignorePointerEventsNone: false,
        },
      );
    } catch {
      throw new NativeRequestError("Chrome did not resolve the exact semantic type target.", "DOCUMENT_MISMATCH");
    }
    const backendNodeId = typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as { backendNodeId?: unknown }).backendNodeId
      : undefined;
    if (!Number.isSafeInteger(backendNodeId) || Number(backendNodeId) < 1) {
      throw new NativeRequestError("Chrome returned a malformed semantic type target.", "DOCUMENT_MISMATCH");
    }
    return Number(backendNodeId);
  }

  async focusBackendNode(binding: DebuggerLeaseBinding, backendNodeId: number): Promise<void> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) {
      throw new NativeRequestError("The debugger session is not bound to this exact type operation.", "TAB_IDENTITY_MISMATCH");
    }
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId < 1) {
      throw new NativeRequestError("The semantic type target identity is invalid.", "INVALID_STATE");
    }
    try {
      await chrome.debugger.sendCommand(
        { tabId: binding.providerTabId },
        "DOM.focus",
        { backendNodeId },
      );
    } catch {
      throw new NativeRequestError("Chrome did not return a certain type focus outcome.", "OUTCOME_UNKNOWN", "unknown");
    }
  }

  async insertText(binding: DebuggerLeaseBinding, text: string): Promise<void> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) {
      throw new NativeRequestError("The debugger session is not bound to this exact type operation.", "TAB_IDENTITY_MISMATCH");
    }
    try {
      await chrome.debugger.sendCommand(
        { tabId: binding.providerTabId },
        "Input.insertText",
        { text },
      );
    } catch {
      throw new NativeRequestError("Chrome did not return a certain text insertion outcome.", "OUTCOME_UNKNOWN", "unknown");
    }
  }

  async setInputFile(binding: DebuggerLeaseBinding, backendNodeId: number, artifact: VerifiedInputArtifact,
    assertAuthority: () => void): Promise<void> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)
      || !Number.isSafeInteger(backendNodeId) || backendNodeId < 1) {
      throw new NativeRequestError("The file input is not bound to this exact operation.", "TAB_IDENTITY_MISMATCH");
    }
    assertAuthority();
    const described = await chrome.debugger.sendCommand({ tabId: binding.providerTabId }, "DOM.describeNode", { backendNodeId, depth: 0 }) as { node?: { nodeName?: string; backendNodeId?: number; attributes?: unknown } };
    const node = described?.node;
    if (node?.nodeName !== "INPUT" || node.backendNodeId !== backendNodeId || !Array.isArray(node.attributes)
      || node.attributes.length > 256 || node.attributes.length % 2 !== 0 || node.attributes.some((entry) => typeof entry !== "string")) {
      throw new NativeRequestError("The exact target is not a file input.", "DOCUMENT_MISMATCH");
    }
    const attributes = new Map<string, string>();
    for (let index = 0; index < node.attributes.length; index += 2) attributes.set(node.attributes[index], node.attributes[index + 1]);
    if (attributes.get("type")?.toLowerCase() !== "file" || attributes.has("disabled") || attributes.has("multiple") || attributes.has("webkitdirectory")) {
      throw new NativeRequestError("Only an enabled single-file input is supported.", "INVALID_STATE");
    }
    assertAuthority();
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) throw new NativeRequestError("The upload debugger lease changed.", "TAB_IDENTITY_MISMATCH");
    const path = consumeInputArtifactPath(artifact, binding.actionId);
    try {
      await chrome.debugger.sendCommand({ tabId: binding.providerTabId }, "DOM.setFileInputFiles", { backendNodeId, files: [path] });
    } catch {
      throw new NativeRequestError("Chrome did not confirm the file input outcome.", "OUTCOME_UNKNOWN", "unknown");
    }
  }

  async detach(binding: DebuggerLeaseBinding): Promise<boolean> {
    if (!sameBinding(this.attached.get(binding.providerTabId), binding)) return false;
    try {
      await chrome.debugger.detach({ tabId: binding.providerTabId });
      this.attached.delete(binding.providerTabId);
      return true;
    } catch {
      // Keep the binding as cleanup debt. A failed detach is not proof that the
      // Chrome debugger session ended.
      return false;
    }
  }

  async detachLease(lease: TabLease): Promise<boolean> {
    const binding = this.attached.get(lease.identity.providerTabId);
    if (
      !binding
      || binding.leaseId !== lease.leaseId
      || binding.tabHandle !== lease.tabHandle
      || binding.providerTabId !== lease.identity.providerTabId
    ) return false;
    return await this.detach(binding);
  }

  observeDetached(source: chrome.debugger.Debuggee): DebuggerLeaseBinding | null {
    if (typeof source.tabId !== "number") return null;
    const binding = this.attached.get(source.tabId);
    if (!binding) return null;
    this.attached.delete(source.tabId);
    return { ...binding };
  }
}
