import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTENT_CONTRACT, type ContentBindEnvelope } from "../content/protocol";
import { ContentRuntimeHost } from "./content-host";
import { createLease } from "./leases";
import { createLoadGenerationId, createTabHandle } from "./lifecycle";

const entropy = (byte: number) => (length: number) => new Uint8Array(length).fill(byte);

const leaseFixture = () => {
  const generation = createLoadGenerationId(entropy(1));
  return createLease({
    tabHandle: createTabHandle(generation, entropy(2)),
    loadGenerationId: generation,
    contextId: "context-one",
    browserSessionId: "session-one",
    turnId: "turn-one",
    origin: "created",
    disposition: "ephemeral",
    siteOrigin: "https://example.com",
    identity: {
      browserInstanceId: "browser-one",
      providerTabId: 7,
      providerWindowId: 4,
      documentId: null,
      documentEpoch: 0,
    },
  });
};

describe("content runtime host document binding", () => {
  const priorChrome = globalThis.chrome;
  const tabsGet = vi.fn();
  const sendMessage = vi.fn();
  const executeScript = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    tabsGet.mockResolvedValue({
      id: 7,
      windowId: 4,
      url: "https://example.com/page",
      incognito: false,
    });
    executeScript.mockImplementation(async (details: { files?: string[] }) => {
      if ("files" in details) return [{ frameId: 0, documentId: "document-one" }];
      return [{ frameId: 0, documentId: "document-one", result: "https://example.com" }];
    });
    sendMessage.mockImplementation(async (_tabId: number, message: ContentBindEnvelope) => ({
      contract: CONTENT_CONTRACT,
      kind: "content.bound",
      ok: true,
      binding: message.binding,
    }));
    globalThis.chrome = {
      tabs: { get: tabsGet, sendMessage },
      scripting: { executeScript },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    globalThis.chrome = priorChrome;
  });

  it.each(["tab_read", "document_probe"])("rechecks the authority callback before packaged injection after %s", async (boundary) => {
    let active = true;
    const assertAuthority = () => { if (!active) throw new Error("authority revoked"); };
    if (boundary === "tab_read") {
      tabsGet.mockImplementationOnce(async () => {
        active = false;
        return { id: 7, windowId: 4, url: "https://example.com/page", incognito: false };
      });
    } else {
      let probes = 0;
      executeScript.mockImplementation(async () => {
        if (++probes === 2) active = false;
        return [{ frameId: 0, documentId: "document-one", result: "https://example.com" }];
      });
    }
    await expect(new ContentRuntimeHost().bind(leaseFixture(), assertAuthority)).rejects.toThrow("authority revoked");
    expect(executeScript.mock.calls.every(([input]) => !("files" in input))).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rechecks the authority callback after the document probe and before content command dispatch", async () => {
    const lease = leaseFixture();
    lease.identity.documentId = "document-one";
    let active = true;
    executeScript.mockImplementationOnce(async () => {
      active = false;
      return [{ frameId: 0, documentId: "document-one", result: "https://example.com" }];
    });
    await expect(new ContentRuntimeHost().command(lease, {
      commandId: "scroll-one", operationId: "op-one", actionId: "action-one", deadlineAtMs: Date.now() + 5_000,
      command: { name: "semantics.inspect" },
      assertAuthority: () => { if (!active) throw new Error("authority revoked"); },
    })).rejects.toThrow("authority revoked");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("binds only the exact top-level document and distinct lease identity", async () => {
    const lease = leaseFixture();
    const bound = await new ContentRuntimeHost().bind(lease);

    expect(bound.identity).toMatchObject({ documentId: "document-one", documentEpoch: 1 });
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        binding: expect.objectContaining({
          lease_id: lease.leaseId,
          tab_handle: lease.tabHandle,
          document_id: "document-one",
        }),
      }),
      { documentId: "document-one" },
    );
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 7, documentIds: ["document-one"] },
      files: expect.any(Array),
      world: "ISOLATED",
    }));
  });

  it("rejects a cross-origin probe before injecting the packaged content runtime", async () => {
    executeScript.mockResolvedValueOnce([{
      frameId: 0,
      documentId: "document-other",
      result: "https://other.example",
    }]);

    await expect(new ContentRuntimeHost().bind(leaseFixture()))
      .rejects.toMatchObject({ a0Code: "DOCUMENT_MISMATCH" });

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses a page response when the exact document changes before return", async () => {
    const lease = leaseFixture();
    const bound = {
      ...lease,
      identity: { ...lease.identity, documentId: "document-one", documentEpoch: 1 },
      revision: lease.revision + 1,
    };
    executeScript
      .mockResolvedValueOnce([{
        frameId: 0,
        documentId: "document-one",
        result: "https://example.com",
      }])
      .mockResolvedValueOnce([{
        frameId: 0,
        documentId: "document-two",
        result: "https://other.example",
      }]);
    sendMessage.mockResolvedValueOnce({
      contract: CONTENT_CONTRACT,
      kind: "content.response",
      load_generation_id: bound.loadGenerationId,
      lease_id: bound.leaseId,
      tab_handle: bound.tabHandle,
      document_id: "document-one",
      document_epoch: "1",
      command_id: "content:action-one",
      operation_id: "op-one",
      action_id: "action-one",
      ok: true,
      result: {
        state: "inspected",
        snapshot: { title: "Private", text: "Private", nodes: [], truncated: false },
      },
    });

    await expect(new ContentRuntimeHost().command(bound, {
      commandId: "content:action-one",
      operationId: "op-one",
      actionId: "action-one",
      deadlineAtMs: Date.now() + 5_000,
      command: { name: "semantics.inspect" },
    })).rejects.toMatchObject({ a0Code: "DOCUMENT_MISMATCH" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
