import { describe, expect, it, vi } from "vitest";

import { createUiRouter, UiRequestError } from "./ui-router";

const fixture = () => {
  const dependencies = {
    getState: vi.fn(() => ({ phase: "READY" })),
    refresh: vi.fn(async () => ({ phase: "READY" })),
    pair: vi.fn(async () => ({ phase: "RECONCILING" })),
    disconnect: vi.fn(async () => ({ phase: "NEGOTIATING" })),
    contextList: vi.fn(async () => ({ contexts: [], selectedContextId: null, suggestedContextId: null, selected: null })),
    contextSubscribe: vi.fn(async () => ({ contexts: [], selectedContextId: "context-one", suggestedContextId: null, selected: null })),
    contextUnsubscribe: vi.fn(async () => ({ contexts: [], selectedContextId: null, suggestedContextId: null, selected: null })),
    contextSendMessage: vi.fn(async (panelId: string, input: { contextId: string; clientMessageId: string }) => ({
      contextId: input.contextId,
      clientMessageId: input.clientMessageId,
      status: "accepted" as const,
    })),
  };
  return { dependencies, route: createUiRouter(dependencies) };
};

describe("trusted extension UI router", () => {
  it("keeps unsent drafts local to an exact panel request", async () => {
    const { dependencies } = fixture();
    const saveDraft = vi.fn();
    const route = createUiRouter({ ...dependencies, saveDraft });
    const request = { type: "context_draft", context_id: "context-one", text: "Unsent text" };
    await expect(route(request)).rejects.toThrow("INVALID_UI_REQUEST");
    await expect(route({ ...request, text: {} }, { panelId: "panel-one" })).rejects.toThrow("INVALID_UI_REQUEST");
    await expect(route({ ...request, send: true }, { panelId: "panel-one" })).rejects.toThrow("INVALID_UI_REQUEST");
    await expect(route(request, { panelId: "panel-one" })).resolves.toEqual({ ok: true });
    expect(saveDraft).toHaveBeenCalledExactlyOnceWith("panel-one", "context-one", "Unsent text");
    expect(dependencies.contextSendMessage).not.toHaveBeenCalled();
  });
  it("keeps refresh read-only and accepts only parameterless explicit development reconnect", async () => {
    const { dependencies } = fixture();
    const reconnectDevelopmentBrowser = vi.fn(async () => ({ phase: "CONNECTING" }));
    const route = createUiRouter({ ...dependencies, reconnectDevelopmentBrowser });
    await route({ type: "refresh" });
    expect(reconnectDevelopmentBrowser).not.toHaveBeenCalled();
    await expect(route({ type: "reconnect_development_browser", params: {} })).rejects.toThrow("INVALID_UI_REQUEST");
    await expect(route({ type: "reconnect_development_browser", bridge_id: "forged" })).rejects.toThrow("INVALID_UI_REQUEST");
    await expect(route({ type: "reconnect_development_browser" })).resolves.toEqual({ ok: true, state: { phase: "CONNECTING" } });
    expect(reconnectDevelopmentBrowser).toHaveBeenCalledOnce();
  });

  it("accepts only exact viewer requests", async () => {
    const { dependencies, route } = fixture();
    await expect(route({ type: "get_state" })).resolves.toEqual({
      ok: true,
      state: { phase: "READY" },
    });
    await expect(route({ type: "refresh" })).resolves.toEqual({
      ok: true,
      state: { phase: "READY" },
    });
    expect(dependencies.getState).toHaveBeenCalledOnce();
    expect(dependencies.refresh).toHaveBeenCalledOnce();
    await expect(route({ type: "refresh", injected: true })).rejects.toBeInstanceOf(UiRequestError);
  });

  it("normalizes one transient pairing exchange and rejects smuggled fields", async () => {
    const { dependencies, route } = fixture();
    await expect(route({
      type: "pair_browser",
      params: {
        contract_version: 1,
        server_base_url: "http://localhost:50080/",
        pairing_code: "a0b1-deadbeef-0123456789abcdefghjkmnpqrstvwxyz",
      },
    })).resolves.toEqual({ ok: true, state: { phase: "RECONCILING" } });
    expect(dependencies.pair).toHaveBeenCalledWith({
      contract_version: 1,
      server_base_url: "http://localhost:50080",
      pairing_code: "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ",
    });

    await expect(route({
      type: "pair_browser",
      params: {
        contract_version: 1,
        server_base_url: "http://localhost:50080",
        pairing_code: "A0B1-DEADBEEF-0123456789ABCDEFGHJKMNPQRSTVWXYZ",
        api_key: "forbidden",
      },
    })).rejects.toBeInstanceOf(UiRequestError);
  });

  it("requires an explicit confirmation for disconnect", async () => {
    const { dependencies, route } = fixture();
    await expect(route({ type: "disconnect_browser", confirmed: false }))
      .rejects.toBeInstanceOf(UiRequestError);
    await expect(route({ type: "disconnect_browser", confirmed: true }))
      .resolves.toEqual({ ok: true, state: { phase: "NEGOTIATING" } });
    expect(dependencies.disconnect).toHaveBeenCalledOnce();
  });

  it("binds context routes to a panel and rejects ambiguous or smuggled fields", async () => {
    const { dependencies, route } = fixture();
    await expect(route({ type: "context_list" })).rejects.toBeInstanceOf(UiRequestError);
    await expect(route({ type: "context_list" }, { panelId: "panel-one" })).resolves.toMatchObject({ ok: true });

    await expect(route({
      type: "context_subscribe",
      params: { context_id: "context-one", history: "tail" },
    }, { panelId: "panel-one" })).resolves.toMatchObject({ ok: true });
    expect(dependencies.contextSubscribe).toHaveBeenCalledWith("panel-one", {
      contextId: "context-one",
      history: "tail",
    });

    await expect(route({
      type: "context_subscribe",
      params: { context_id: "context-one", history: "tail", from: 1 },
    }, { panelId: "panel-one" })).rejects.toBeInstanceOf(UiRequestError);
    await expect(route({
      type: "context_send_message",
      params: {
        context_id: "context-one",
        client_message_id: "client-one",
        text: "Continue.",
        raw_path: "/tmp/forbidden",
      },
    }, { panelId: "panel-one" })).rejects.toBeInstanceOf(UiRequestError);
  });
});
