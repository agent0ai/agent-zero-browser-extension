import {
  CONTENT_CONTRACT,
  isTrustedWorkerSender,
  parseContentEnvelope,
  type ContentBinding,
} from "./protocol";

const binding: ContentBinding = {
  load_generation_id: "generation-1",
  lease_id: "lease-1",
  tab_handle: "tab-handle-1",
  document_id: "document-1",
  document_epoch: "epoch-1",
};

describe("content protocol", () => {
  it("accepts only a boolean optional internal favicon indication on exact binds", () => {
    const value = { contract: CONTENT_CONTRACT, kind: "content.bind", binding, deadline_ms: 1_500 };
    for (const flag of [true, false]) expect(parseContentEnvelope({ ...value, agent_created_favicon: flag }, 1_000).ok).toBe(true);
    for (const flag of ["true", 1, null, {}]) expect(parseContentEnvelope({ ...value, agent_created_favicon: flag }, 1_000).ok).toBe(false);
  });
  it("accepts exact document- and lease-bound cursor commands", () => {
    const parsed = parseContentEnvelope(
      {
        contract: CONTENT_CONTRACT,
        kind: "content.command",
        ...binding,
        command_id: "command-1",
        operation_id: "operation-1",
        action_id: "action-1",
        deadline_ms: 1_500,
        command: { name: "cursor.move_to_point", x: 20, y: 30, show_label: true },
      },
      1_000,
    );

    expect(parsed.ok).toBe(true);
  });

  it("accepts only bounded semantic inspection and ref-bound page targets", () => {
    const base = {
      contract: CONTENT_CONTRACT,
      kind: "content.command",
      ...binding,
      command_id: "command-1",
      operation_id: "operation-1",
      action_id: "action-1",
      deadline_ms: 1_500,
    };

    expect(parseContentEnvelope({
      ...base,
      command: { name: "semantics.inspect", max_nodes: 64, max_text_chars: 12_000 },
    }, 1_000).ok).toBe(true);
    expect(parseContentEnvelope({
      ...base,
      command: { name: "page.scroll_to_ref", element_ref: "doc:epoch:opaque", show_cursor: true },
    }, 1_000).ok).toBe(true);
    expect(parseContentEnvelope({
      ...base,
      command: { name: "target.prepare_hover", element_ref: "doc:epoch:opaque" },
    }, 1_000).ok).toBe(true);
    expect(parseContentEnvelope({
      ...base,
      command: { name: "target.prepare_click", element_ref: "doc:epoch:opaque" },
    }, 1_000).ok).toBe(true);
    expect(parseContentEnvelope({
      ...base,
      command: { name: "target.revalidate_click", element_ref: "doc:epoch:opaque", target_fingerprint: "a".repeat(64) },
    }, 1_000).ok).toBe(true);
    expect(parseContentEnvelope({
      ...base,
      command: { name: "target.prepare_type", element_ref: "doc:epoch:opaque", has_line_feed: false },
    }, 1_000).ok).toBe(true);
    expect(parseContentEnvelope({
      ...base,
      command: {
        name: "target.verify_type_value",
        element_ref: "doc:epoch:opaque",
        target_fingerprint: "a".repeat(64),
        text_sha256: "b".repeat(64),
        has_line_feed: false,
      },
    }, 1_000).ok).toBe(true);
    expect(parseContentEnvelope({
      ...base,
      command: { name: "semantics.inspect", max_nodes: 129 },
    }, 1_000)).toEqual({ ok: false, code: "INVALID_ENVELOPE" });
    expect(parseContentEnvelope({
      ...base,
      command: { name: "page.scroll_to_ref", element_ref: "doc:epoch:opaque", selector: "#target" },
    }, 1_000)).toEqual({ ok: false, code: "INVALID_ENVELOPE" });
    expect(parseContentEnvelope({
      ...base,
      command: { name: "target.prepare_hover", element_ref: "doc:epoch:opaque", x: 40 },
    }, 1_000)).toEqual({ ok: false, code: "INVALID_ENVELOPE" });
    expect(parseContentEnvelope({
      ...base,
      command: { name: "target.prepare_type", element_ref: "doc:epoch:opaque", has_line_feed: false, text: "secret" },
    }, 1_000)).toEqual({ ok: false, code: "INVALID_ENVELOPE" });
  });

  it("rejects smuggled fields, legacy selectors, and stale deadlines", () => {
    const base = {
      contract: CONTENT_CONTRACT,
      kind: "content.command",
      ...binding,
      command_id: "command-1",
      operation_id: "operation-1",
      action_id: "action-1",
      deadline_ms: 1_500,
    };

    expect(parseContentEnvelope({ ...base, selector: "#submit", command: { name: "cursor.freeze" } }, 1_000)).toEqual({
      ok: false,
      code: "INVALID_ENVELOPE",
    });
    expect(
      parseContentEnvelope({ ...base, command: { name: "click_node", element_ref: "doc:e:r" } }, 1_000),
    ).toEqual({ ok: false, code: "INVALID_ENVELOPE" });
    expect(parseContentEnvelope({ ...base, deadline_ms: 999, command: { name: "cursor.freeze" } }, 1_000)).toMatchObject({
      ok: false,
      code: "DEADLINE_EXCEEDED",
    });
  });

  it("accepts only this extension's worker sender", () => {
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const origin = `chrome-extension://${extensionId}`;

    expect(isTrustedWorkerSender({ id: extensionId, url: `${origin}/worker.js` }, extensionId, origin)).toBe(true);
    expect(isTrustedWorkerSender({ id: "other", url: `${origin}/worker.js` }, extensionId, origin)).toBe(false);
    expect(
      isTrustedWorkerSender(
        { id: extensionId, url: `${origin}/worker.js`, tab: { id: 4 } as chrome.tabs.Tab },
        extensionId,
        origin,
      ),
    ).toBe(false);
    expect(
      isTrustedWorkerSender(
        { id: extensionId, url: `${origin}/sidepanel.html`, documentId: "panel-document", frameId: 0 },
        extensionId,
        origin,
      ),
    ).toBe(false);
    expect(isTrustedWorkerSender({ id: extensionId, url: "https://attacker.invalid/" }, extensionId, origin)).toBe(false);
  });
});
