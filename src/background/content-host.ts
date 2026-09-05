import contentScriptFile from "../content/index.ts?script";
import {
  CONTENT_CONTRACT,
  type ContentBindEnvelope,
  type ContentBindResponse,
  type ContentCommand,
  type ContentCommandEnvelope,
  type ContentResponse,
} from "../content/protocol";
import type { TabLease } from "./leases";
import { NativeRequestError } from "./native-port";

const bindingForLease = (lease: TabLease) => {
  if (!lease.identity.documentId) {
    throw new NativeRequestError("The leased page document is not bound.", "DOCUMENT_MISMATCH");
  }
  return {
    load_generation_id: lease.loadGenerationId,
    lease_id: lease.leaseId,
    tab_handle: lease.tabHandle,
    document_id: lease.identity.documentId,
    document_epoch: String(lease.identity.documentEpoch),
  };
};

const contentErrorCode = (code: string): ConstructorParameters<typeof NativeRequestError>[1] => {
  switch (code) {
    case "STALE_ELEMENT_REFERENCE":
      return "ELEMENT_REFERENCE_STALE";
    case "TARGET_NOT_VISIBLE":
      return "INVALID_STATE";
    case "TARGET_UNSUPPORTED":
      return "UNSUPPORTED_CAPABILITY";
    case "TARGET_CHANGED":
      return "DOCUMENT_MISMATCH";
    case "DEADLINE_EXCEEDED":
      return "DEADLINE_EXCEEDED";
    default:
      return "DOCUMENT_MISMATCH";
  }
};

function assertContentResponse(
  value: unknown,
  kind: "content.bound" | "content.response",
): asserts value is ContentBindResponse | ContentResponse {
  if (
    typeof value !== "object"
    || value === null
    || (value as { contract?: unknown }).contract !== CONTENT_CONTRACT
    || (value as { kind?: unknown }).kind !== kind
    || (value as { ok?: unknown }).ok !== true
  ) {
    throw new NativeRequestError("The isolated page runtime rejected its binding.", "DOCUMENT_MISMATCH");
  }
}

function assertBoundResponse(value: unknown, expected: ReturnType<typeof bindingForLease>): asserts value is ContentBindResponse {
  assertContentResponse(value, "content.bound");
  const actual = (value as ContentBindResponse).binding;
  if (
    !actual
    || actual.load_generation_id !== expected.load_generation_id
    || actual.lease_id !== expected.lease_id
    || actual.tab_handle !== expected.tab_handle
    || actual.document_id !== expected.document_id
    || actual.document_epoch !== expected.document_epoch
  ) {
    throw new NativeRequestError("The isolated page runtime bound a different document lease.", "DOCUMENT_MISMATCH");
  }
}

function assertCommandResponse(
  value: unknown,
  envelope: ContentCommandEnvelope,
): asserts value is ContentResponse {
  if (
    typeof value !== "object"
    || value === null
    || (value as { contract?: unknown }).contract !== CONTENT_CONTRACT
    || (value as { kind?: unknown }).kind !== "content.response"
  ) {
    throw new NativeRequestError("The isolated page runtime returned an invalid response.", "DOCUMENT_MISMATCH");
  }
  const response = value as ContentResponse;
  if (
    response.load_generation_id !== envelope.load_generation_id
    || response.lease_id !== envelope.lease_id
    || response.tab_handle !== envelope.tab_handle
    || response.document_id !== envelope.document_id
    || response.document_epoch !== envelope.document_epoch
    || response.command_id !== envelope.command_id
    || response.operation_id !== envelope.operation_id
    || response.action_id !== envelope.action_id
    || typeof response.ok !== "boolean"
  ) {
    throw new NativeRequestError("The isolated page runtime response binding did not match.", "DOCUMENT_MISMATCH");
  }
  if (!response.ok) {
    throw new NativeRequestError(
      response.error?.message || "The isolated page runtime rejected the command.",
      contentErrorCode(response.error?.code || "DOCUMENT_MISMATCH"),
    );
  }
}

export class ContentRuntimeHost {
  private async getExactLeasedTab(lease: TabLease): Promise<chrome.tabs.Tab & { id: number }> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(lease.identity.providerTabId);
    } catch {
      throw new NativeRequestError("The page no longer matches its exact lease.", "TAB_IDENTITY_MISMATCH");
    }
    if (
      tab.id !== lease.identity.providerTabId
      || tab.windowId !== lease.identity.providerWindowId
      || tab.incognito
    ) {
      throw new NativeRequestError("The page no longer matches its exact lease.", "TAB_IDENTITY_MISMATCH");
    }
    let url: URL;
    try {
      url = new URL(tab.url || "about:blank");
    } catch {
      throw new NativeRequestError("Chrome does not allow page runtime access on this URL.", "CHROME_RESTRICTED_URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new NativeRequestError("Chrome does not allow page runtime access on this URL.", "CHROME_RESTRICTED_URL");
    }
    if (url.origin !== lease.siteOrigin) {
      throw new NativeRequestError("The leased page moved outside its authorized origin.", "ORIGIN_BLOCKED");
    }
    return tab as chrome.tabs.Tab & { id: number };
  }

  private async assertExactDocumentOrigin(lease: TabLease, documentId: string): Promise<void> {
    let probe: chrome.scripting.InjectionResult<string>[];
    try {
      probe = await chrome.scripting.executeScript({
        target: { tabId: lease.identity.providerTabId, documentIds: [documentId] },
        world: "ISOLATED",
        func: () => location.origin,
      });
    } catch {
      throw new NativeRequestError("The leased page document changed.", "DOCUMENT_MISMATCH");
    }
    if (
      probe.length !== 1
      || probe[0].frameId !== 0
      || probe[0].documentId !== documentId
      || probe[0].result !== lease.siteOrigin
    ) {
      throw new NativeRequestError("The leased page document changed.", "DOCUMENT_MISMATCH");
    }
  }

  async bind(lease: TabLease, assertAuthority: () => void = () => undefined): Promise<TabLease> {
    assertAuthority();
    if (lease.state !== "active" || lease.userIntervened) {
      throw new NativeRequestError("The page runtime requires an active exact lease.", "LEASE_CONFLICT");
    }
    const tab = await this.getExactLeasedTab(lease);
    assertAuthority();

    // Resolve Chrome's exact top-level document identity before loading the packaged
    // content entry, then target that document rather than whichever frame is current.
    const probe = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "ISOLATED",
      func: () => location.origin,
    });
    const documentId = probe[0]?.documentId;
    assertAuthority();
    if (
      probe.length !== 1
      || probe[0].frameId !== 0
      || probe[0].result !== lease.siteOrigin
      || !documentId
    ) {
      throw new NativeRequestError("Chrome did not provide an exact document identity.", "DOCUMENT_MISMATCH");
    }
    await this.getExactLeasedTab(lease);
    assertAuthority();
    await this.assertExactDocumentOrigin(lease, documentId);
    assertAuthority();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, documentIds: [documentId] },
      files: [contentScriptFile],
      world: "ISOLATED",
    });
    assertAuthority();
    await this.getExactLeasedTab(lease);
    assertAuthority();
    await this.assertExactDocumentOrigin(lease, documentId);
    assertAuthority();

    const boundLease: TabLease = {
      ...lease,
      identity: {
        ...lease.identity,
        documentId,
        documentEpoch: lease.identity.documentId === documentId
          ? lease.identity.documentEpoch
          : lease.identity.documentEpoch + 1,
      },
      revision: lease.identity.documentId === documentId ? lease.revision : lease.revision + 1,
    };
    const binding = bindingForLease(boundLease);
    const envelope: ContentBindEnvelope = {
      contract: CONTENT_CONTRACT,
      kind: "content.bind",
      binding,
      deadline_ms: Date.now() + 5_000,
    };
    const response: unknown = await chrome.tabs.sendMessage(tab.id, envelope, { documentId });
    assertAuthority();
    assertBoundResponse(response, binding);
    await this.getExactLeasedTab(boundLease);
    assertAuthority();
    await this.assertExactDocumentOrigin(boundLease, documentId);
    assertAuthority();
    return boundLease;
  }

  async command(
    lease: TabLease,
    input: {
      commandId: string;
      operationId: string;
      actionId: string;
      deadlineAtMs: number;
      command: ContentCommand;
      // Worker-local callback only; it is never part of the content envelope.
      assertAuthority?: () => void;
    },
  ): Promise<ContentResponse> {
    const assertAuthority = input.assertAuthority ?? (() => undefined);
    assertAuthority();
    const binding = bindingForLease(lease);
    await this.getExactLeasedTab(lease);
    assertAuthority();
    await this.assertExactDocumentOrigin(lease, binding.document_id);
    assertAuthority();
    const envelope: ContentCommandEnvelope = {
      contract: CONTENT_CONTRACT,
      kind: "content.command",
      ...binding,
      command_id: input.commandId,
      operation_id: input.operationId,
      action_id: input.actionId,
      deadline_ms: input.deadlineAtMs,
      command: input.command,
    };
    const response: unknown = await chrome.tabs.sendMessage(
      lease.identity.providerTabId,
      envelope,
      { documentId: binding.document_id },
    );
    assertAuthority();
    assertCommandResponse(response, envelope);
    await this.getExactLeasedTab(lease);
    assertAuthority();
    await this.assertExactDocumentOrigin(lease, binding.document_id);
    assertAuthority();
    return response as ContentResponse;
  }

  async release(
    lease: TabLease,
    reason: "complete" | "detach" | "finalize" | "lease_lost" | "navigation" | "takeover",
  ): Promise<void> {
    if (!lease.identity.documentId) return;
    const nonce = crypto.randomUUID();
    try {
      await this.command(lease, {
        commandId: `release:${nonce}`,
        operationId: `release:${nonce}`,
        actionId: `release:${nonce}`,
        deadlineAtMs: Date.now() + 5_000,
        command: { name: "runtime.release", reason },
      });
    } catch {
      // Release is best effort after the exact document disappears.
    }
  }
}
