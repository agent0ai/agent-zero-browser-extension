import { ContentRuntime } from "./bridge";
import { CursorController } from "./cursor";
import type { CursorOverlayView, CursorVisualState } from "./overlay";
import { CONTENT_CONTRACT, type ContentBinding, type ContentCommand } from "./protocol";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionOrigin = `chrome-extension://${extensionId}`;
const sender = { id: extensionId, url: `${extensionOrigin}/service-worker.js` } as chrome.runtime.MessageSender;

const binding: ContentBinding = {
  load_generation_id: "generation-1",
  lease_id: "lease-1",
  tab_handle: "tab-handle-1",
  document_id: "document-1",
  document_epoch: "epoch-1",
};

const bindEnvelope = () => ({
  contract: CONTENT_CONTRACT,
  kind: "content.bind" as const,
  binding,
  deadline_ms: 2_000,
});

const commandEnvelope = (command: ContentCommand, overrides: Record<string, unknown> = {}) => ({
  contract: CONTENT_CONTRACT,
  kind: "content.command" as const,
  ...binding,
  command_id: "command-1",
  operation_id: "operation-1",
  action_id: "action-1",
  deadline_ms: 2_000,
  command,
  ...overrides,
});

const makeRuntime = (createFavicon?: () => { remove(): void } | null) => {
  const states: CursorVisualState[] = [];
  const positions: Array<{ x: number; y: number }> = [];
  const visibility: boolean[] = [];
  let removals = 0;
  const view: CursorOverlayView = {
    setVisible: (visible) => visibility.push(visible),
    setPosition: (x, y) => positions.push({ x, y }),
    setState: (state) => states.push(state),
    remove: () => {
      removals += 1;
    },
  };
  const cursor = new CursorController(
    () => view,
    {
      now: () => 0,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
    },
    { viewport: () => ({ width: 800, height: 600 }), reducedMotion: () => true },
  );
  const arrivals: unknown[] = [];
  const ownerDocument = { defaultView: null } as unknown as Document;
  const runtime = new ContentRuntime({
    extensionId,
    extensionOrigin,
    ownerDocument,
    cursor,
    createFavicon,
    now: () => 1_000,
    viewport: () => ({ width: 800, height: 600 }),
    emitArrival: (event) => {
      arrivals.push(event);
    },
  });
  return { runtime, arrivals, positions, states, visibility, removals: () => removals };
};

describe("ContentRuntime", () => {
  it.each(["new_move", "release", "navigation"])("never revives a suspended cursor after %s", async (change) => {
    const { runtime, visibility } = makeRuntime();
    await runtime.handle(bindEnvelope(), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.move_to_point", x: 100, y: 100 }), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.suspend" }), sender);
    if (change === "new_move") await runtime.handle(commandEnvelope({ name: "cursor.move_to_point", x: 120, y: 120 }, { action_id: "new-action" }), sender);
    if (change === "release") await runtime.handle(commandEnvelope({ name: "runtime.release", reason: "finalize" }), sender);
    if (change === "navigation") runtime.handleNavigation();
    const count = visibility.length;
    await runtime.handle(commandEnvelope({ name: "cursor.resume" }), sender);
    expect(visibility).toHaveLength(count);
  });
  it("restores only the same bound suspended operation/action and preserves the favicon", async () => {
    const removeFavicon = vi.fn();
    const { runtime, visibility, positions } = makeRuntime(() => ({ remove: removeFavicon }));
    await runtime.handle({ ...bindEnvelope(), agent_created_favicon: true }, sender);
    await runtime.handle(commandEnvelope({ name: "cursor.move_to_point", x: 100, y: 100 }), sender);
    expect(await runtime.handle(commandEnvelope({ name: "cursor.suspend" }), sender)).toMatchObject({ result: { state: "suspended" } });
    await runtime.handle(commandEnvelope({ name: "cursor.resume" }, { operation_id: "wrong" }), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.resume" }, { action_id: "wrong" }), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.resume" }, { lease_id: "wrong" }), sender);
    expect(visibility).toEqual([false]);
    expect(await runtime.handle(commandEnvelope({ name: "cursor.resume" }), sender)).toMatchObject({ result: { state: "resumed" } });
    expect(visibility).toEqual([false, true]);
    expect(positions).toHaveLength(1);
    expect(removeFavicon).not.toHaveBeenCalled();
    await runtime.handle(commandEnvelope({ name: "cursor.suspend" }), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.cancel", reason: "cancel" }), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.resume" }), sender);
    expect(visibility).toEqual([false, true, false]);
    expect(removeFavicon).toHaveBeenCalledTimes(1);
  });
  it.each(["cancel", "navigation", "release"])("shows no favicon before authenticated created-tab binding and removes it on %s", async (terminal) => {
    const remove = vi.fn();
    const create = vi.fn(() => ({ remove }));
    const { runtime, positions } = makeRuntime(create);
    const indicated = { ...bindEnvelope(), agent_created_favicon: true };
    await runtime.handle(indicated, { id: "untrusted" });
    expect(create).not.toHaveBeenCalled();
    await runtime.handle(bindEnvelope(), sender);
    expect(create).not.toHaveBeenCalled();
    await runtime.handle({ ...indicated, binding: { ...binding, lease_id: "other" } }, sender);
    expect(create).not.toHaveBeenCalled();
    await runtime.handle(indicated, sender);
    await runtime.handle(indicated, sender);
    expect(create).toHaveBeenCalledTimes(1);
    expect(positions).toEqual([]);
    if (terminal === "navigation") runtime.handleNavigation();
    else await runtime.handle(commandEnvelope(terminal === "cancel"
      ? { name: "cursor.cancel", reason: "disconnect" }
      : { name: "runtime.release", reason: "finalize" }), sender);
    expect(remove).toHaveBeenCalledTimes(1);
    runtime.handleNavigation();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("rejects callers other than its own service worker", async () => {
    const { runtime } = makeRuntime();
    const response = await runtime.handle(bindEnvelope(), {
      id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      url: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/worker.js",
    });

    expect(response).toMatchObject({ ok: false, error: { code: "UNTRUSTED_SENDER" } });
  });

  it("binds exactly once and rejects mismatched lease or document commands", async () => {
    const { runtime } = makeRuntime();
    expect(await runtime.handle(bindEnvelope(), sender)).toMatchObject({ ok: true, binding });
    expect(
      await runtime.handle(
        { ...bindEnvelope(), binding: { ...binding, document_epoch: "epoch-2" } },
        sender,
      ),
    ).toMatchObject({ ok: false, error: { code: "STALE_BINDING" } });

    const response = await runtime.handle(
      commandEnvelope({ name: "cursor.freeze" }, { lease_id: "lease-stale" }),
      sender,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "STALE_BINDING" } });
  });

  it("requires a binding before executing cursor telemetry", async () => {
    const { runtime } = makeRuntime();
    const response = await runtime.handle(
      commandEnvelope({ name: "cursor.move_to_point", x: 25, y: 40 }),
      sender,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "UNBOUND" } });
  });

  it("rejects expired commands while echoing their authority bindings", async () => {
    const { runtime } = makeRuntime();
    await runtime.handle(bindEnvelope(), sender);
    const response = await runtime.handle(
      commandEnvelope({ name: "cursor.freeze" }, { deadline_ms: 999 }),
      sender,
    );

    expect(response).toMatchObject({
      ok: false,
      ...binding,
      command_id: "command-1",
      operation_id: "operation-1",
      action_id: "action-1",
      error: { code: "DEADLINE_EXCEEDED", outcome: "not_applied" },
    });
  });

  it("echoes all authority bindings and emits one arrival per action", async () => {
    const { runtime, arrivals, positions } = makeRuntime();
    await runtime.handle(bindEnvelope(), sender);

    const first = await runtime.handle(
      commandEnvelope({ name: "cursor.move_to_point", x: -20, y: 900 }),
      sender,
    );
    const second = await runtime.handle(
      commandEnvelope(
        { name: "cursor.move_to_point", x: 100, y: 200 },
        { command_id: "command-2" },
      ),
      sender,
    );

    expect(first).toMatchObject({
      ok: true,
      ...binding,
      command_id: "command-1",
      operation_id: "operation-1",
      action_id: "action-1",
      result: { state: "arrived", x: 8, y: 592 },
    });
    expect(second).toMatchObject({ ok: true, result: { state: "arrived", x: 100, y: 200 } });
    expect(positions.at(-1)).toEqual({ x: 100, y: 200 });
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]).toMatchObject({ kind: "cursor.arrived", ...binding, action_id: "action-1" });
  });

  it("pulses once per action and tears down on cancel, navigation, and release", async () => {
    const { runtime, states, removals } = makeRuntime();
    await runtime.handle(bindEnvelope(), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.move_to_point", x: 20, y: 20 }), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.activate" }, { command_id: "activate-1" }), sender);
    await runtime.handle(commandEnvelope({ name: "cursor.activate" }, { command_id: "activate-2" }), sender);
    expect(states.filter((state) => state === "activated")).toHaveLength(1);

    await runtime.handle(commandEnvelope({ name: "cursor.cancel", reason: "pause" }, { command_id: "cancel-1" }), sender);
    expect(removals()).toBe(1);

    await runtime.handle(
      commandEnvelope({ name: "cursor.move_to_point", x: 40, y: 40 }, { command_id: "move-2", action_id: "action-2" }),
      sender,
    );
    await runtime.handle(
      commandEnvelope({ name: "runtime.release", reason: "finalize" }, { command_id: "release-1", action_id: "action-3" }),
      sender,
    );
    expect(removals()).toBe(2);
    expect(
      await runtime.handle(
        commandEnvelope({ name: "cursor.move_to_point", x: 60, y: 60 }, { command_id: "move-3", action_id: "action-4" }),
        sender,
      ),
    ).toMatchObject({ ok: false, error: { code: "RELEASED" } });

    runtime.handleNavigation();
    expect(removals()).toBe(2);
  });

  it("returns bounded semantics and resolves scroll, hover, and safe click only through a current ref", async () => {
    const scrollIntoView = vi.fn();
    let buttonType = "button";
    let formTarget = false;
    const form = { getAttribute: (name: string) => name === "method" ? "post" : null } as unknown as Element;
    let ownerDocument: Document;
    const element = {
      isConnected: true,
      tagName: "BUTTON",
      textContent: "Continue",
      value: "must-not-be-returned",
      getAttribute: (name: string) => name === "aria-label" ? "Continue" : name === "type" ? buttonType : null,
      hasAttribute: () => false,
      closest: () => formTarget ? form : null,
      contains: () => false,
      getBoundingClientRect: () => ({ left: 20, right: 120, top: 40, bottom: 80, width: 100, height: 40 }),
      scrollIntoView,
      get ownerDocument() {
        return ownerDocument;
      },
    } as unknown as Element;
    ownerDocument = {
      title: "Example page",
      body: { innerText: "Visible page text" },
      querySelectorAll: () => [element],
      elementFromPoint: () => element,
      defaultView: {
        getComputedStyle: () => ({
          display: "block",
          visibility: "visible",
          contentVisibility: "visible",
          pointerEvents: "auto",
          opacity: "1",
        }),
      },
    } as unknown as Document;
    const view: CursorOverlayView = {
      setVisible: vi.fn(),
      setPosition: vi.fn(),
      setState: vi.fn(),
      remove: vi.fn(),
    };
    const cursor = new CursorController(
      () => view,
      { now: () => 0, requestFrame: () => 1, cancelFrame: () => undefined },
      { viewport: () => ({ width: 800, height: 600 }), reducedMotion: () => true },
    );
    const runtime = new ContentRuntime({
      extensionId,
      extensionOrigin,
      ownerDocument,
      cursor,
      now: () => 1_000,
      viewport: () => ({ width: 800, height: 600 }),
    });
    await runtime.handle(bindEnvelope(), sender);

    const inspected = await runtime.handle(
      commandEnvelope({ name: "semantics.inspect", max_nodes: 1, max_text_chars: 8 }),
      sender,
    );
    expect(inspected).toMatchObject({
      ok: true,
      result: {
        state: "inspected",
        snapshot: {
          title: "Example page",
          text: "Visible ",
          nodes: [{ ref: expect.stringMatching(/^doc:epoch1:/u), role: "button", name: "Continue" }],
          truncated: true,
        },
      },
    });
    expect(JSON.stringify(inspected)).not.toContain("must-not-be-returned");

    const ref = inspected.ok && inspected.kind === "content.response" && inspected.result?.state === "inspected"
      ? inspected.result.snapshot.nodes[0].ref
      : "missing";
    const scrolled = await runtime.handle(
      commandEnvelope(
        { name: "page.scroll_to_ref", element_ref: ref, show_cursor: true },
        { command_id: "scroll-1", action_id: "action-scroll" },
      ),
      sender,
    );
    expect(scrolled).toMatchObject({ ok: true, result: { state: "scrolled", x: 70, y: 60 } });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "auto" });

    const hovered = await runtime.handle(
      commandEnvelope(
        { name: "target.prepare_hover", element_ref: ref },
        { command_id: "hover-1", action_id: "action-hover" },
      ),
      sender,
    );
    expect(hovered).toMatchObject({ ok: true, result: { state: "hover_ready", x: 70, y: 60 } });

    const preparedClick = await runtime.handle(
      commandEnvelope(
        { name: "target.prepare_click", element_ref: ref },
        { command_id: "click-1", action_id: "action-click" },
      ),
      sender,
    );
    expect(preparedClick).toMatchObject({
      ok: true,
      result: {
        state: "click_ready",
        x: 70,
        y: 60,
        action_class: "reversible_input",
        target_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    if (!preparedClick.ok || preparedClick.kind !== "content.response" || preparedClick.result?.state !== "click_ready") {
      throw new Error("missing prepared click");
    }
    await expect(runtime.handle(
      commandEnvelope(
        {
          name: "target.revalidate_click",
          element_ref: ref,
          target_fingerprint: preparedClick.result.target_fingerprint,
        },
        { command_id: "click-2", action_id: "action-click" },
      ),
      sender,
    )).resolves.toMatchObject({ ok: true, result: { state: "click_ready" } });

    buttonType = "submit";
    formTarget = true;
    await expect(runtime.handle(
      commandEnvelope(
        { name: "target.prepare_click", element_ref: ref },
        { command_id: "click-submit", action_id: "action-submit" },
      ),
      sender,
    )).resolves.toMatchObject({ ok: false, error: { code: "TARGET_UNSUPPORTED" } });
  });

  it("allows only a visible empty single-file target and invalidates changed upload semantics", async () => {
    let ownerDocument: Document;
    const element = { isConnected: true, tagName: "INPUT", type: "file", multiple: false, disabled: false, hidden: false,
      files: { length: 0 }, accept: "text/plain", form: null, textContent: "",
      getAttribute: (name: string) => name === "type" ? "file" : name === "aria-label" ? "Attachment" : null,
      hasAttribute: () => false, closest: () => null,
      getBoundingClientRect: () => ({ left: 20, right: 120, top: 40, bottom: 80, width: 100, height: 40 }),
      get ownerDocument() { return ownerDocument; },
    } as unknown as HTMLInputElement;
    ownerDocument = { elementFromPoint: () => element, defaultView: { getComputedStyle: () => ({
      display: "block", visibility: "visible", contentVisibility: "visible", pointerEvents: "auto", opacity: "1",
    }) } } as unknown as Document;
    const cursor = new CursorController(() => ({ setVisible: vi.fn(), setPosition: vi.fn(), setState: vi.fn(), remove: vi.fn() }),
      { now: () => 0, requestFrame: () => 1, cancelFrame: () => undefined },
      { viewport: () => ({ width: 800, height: 600 }), reducedMotion: () => true });
    const runtime = new ContentRuntime({ extensionId, extensionOrigin, ownerDocument, cursor, now: () => 1_000,
      viewport: () => ({ width: 800, height: 600 }) });
    await runtime.handle(bindEnvelope(), sender);
    const ref = runtime.registerElement(element);
    const prepared = await runtime.handle(commandEnvelope({ name: "target.prepare_upload", element_ref: ref }), sender);
    expect(prepared).toMatchObject({ ok: true, result: { state: "click_ready", action_class: "external_side_effect" } });
    if (!prepared.ok || prepared.kind !== "content.response" || prepared.result?.state !== "click_ready") throw new Error("missing upload target");
    element.accept = "image/png";
    expect(await runtime.handle(commandEnvelope({ name: "target.revalidate_upload", element_ref: ref,
      target_fingerprint: prepared.result.target_fingerprint }, { command_id: "upload-changed" }), sender)).toMatchObject({
      ok: false, error: { code: "TARGET_CHANGED" },
    });
    element.multiple = true;
    expect(await runtime.handle(commandEnvelope({ name: "target.prepare_upload", element_ref: ref }, { command_id: "upload-multiple" }), sender)).toMatchObject({ ok: false, error: { code: "TARGET_UNSUPPORTED" } });
    element.multiple = false;
    Object.defineProperty(element, "files", { value: { length: 1 } });
    expect(await runtime.handle(commandEnvelope({ name: "target.prepare_upload", element_ref: ref }, { command_id: "upload-existing" }), sender)).toMatchObject({ ok: false, error: { code: "TARGET_UNSUPPORTED" } });
  });

  it("prepares, focus-confirms, and digest-verifies only an exact empty semantic type target", async () => {
    let ownerDocument: Document;
    const element = {
      isConnected: true,
      tagName: "INPUT",
      value: "",
      disabled: false,
      readOnly: false,
      maxLength: -1,
      required: false,
      textContent: "",
      getAttribute: (name: string) => name === "type" ? "text" : name === "aria-label" ? "Message" : null,
      hasAttribute: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 20.2, right: 120.8, top: 40.2, bottom: 80.8, width: 100.6, height: 40.6 }),
      get ownerDocument() {
        return ownerDocument;
      },
    } as unknown as HTMLInputElement;
    ownerDocument = {
      activeElement: null,
      elementFromPoint: () => element,
      defaultView: {
        getComputedStyle: () => ({
          display: "block",
          visibility: "visible",
          contentVisibility: "visible",
          pointerEvents: "auto",
          opacity: "1",
        }),
      },
    } as unknown as Document;
    const cursor = new CursorController(
      () => ({ setVisible: vi.fn(), setPosition: vi.fn(), setState: vi.fn(), remove: vi.fn() }),
      { now: () => 0, requestFrame: () => 1, cancelFrame: () => undefined },
      { viewport: () => ({ width: 800, height: 600 }), reducedMotion: () => true },
    );
    const runtime = new ContentRuntime({
      extensionId,
      extensionOrigin,
      ownerDocument,
      cursor,
      now: () => 1_000,
      viewport: () => ({ width: 800, height: 600 }),
    });
    await runtime.handle(bindEnvelope(), sender);
    const ref = runtime.registerElement(element);
    const prepared = await runtime.handle(commandEnvelope({
      name: "target.prepare_type",
      element_ref: ref,
      has_line_feed: false,
    }), sender);
    expect(prepared).toMatchObject({
      ok: true,
      result: {
        state: "type_ready",
        x: 71,
        y: 61,
        action_class: "sensitive_input",
        target_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    if (!prepared.ok || prepared.kind !== "content.response" || prepared.result?.state !== "type_ready") {
      throw new Error("missing prepared type target");
    }
    const targetFingerprint = prepared.result.target_fingerprint;
    Object.defineProperty(ownerDocument, "activeElement", { configurable: true, value: element });
    expect(await runtime.handle(commandEnvelope({
      name: "target.confirm_type_focus",
      element_ref: ref,
      target_fingerprint: targetFingerprint,
      has_line_feed: false,
    }, { command_id: "type-focus" }), sender)).toMatchObject({ ok: true, result: { state: "type_focus_ready" } });

    const proposedText = "synthetic text";
    element.value = proposedText;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proposedText));
    const textSha256 = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const verified = await runtime.handle(commandEnvelope({
      name: "target.verify_type_value",
      element_ref: ref,
      target_fingerprint: targetFingerprint,
      text_sha256: textSha256,
      has_line_feed: false,
    }, { command_id: "type-verify" }), sender);
    expect(verified).toMatchObject({ ok: true, result: { state: "type_verified" } });
    expect(JSON.stringify(verified)).not.toContain(proposedText);
    expect(JSON.stringify(verified)).not.toContain(textSha256);
  });
});
