import { describe, expect, it, vi } from "vitest";

import type { ContextSummary } from "../protocol/context";
import { ContextRelay, ContextRelayError, type ContextTransport } from "./context-relay";

const task: ContextSummary = {
  contextId: "context-one",
  label: "Research plans",
  kind: "task",
  status: "running",
  createdAtMs: 1,
  updatedAtMs: 2,
};

const fixture = () => {
  const transport: ContextTransport = {
    contextList: vi.fn(async () => ({ contractVersion: 1 as const, contexts: [task] })),
    contextSubscribe: vi.fn(async (input) => ({
      contextId: input.contextId,
      subscribed: true as const,
      lastSequence: 0,
      historyBefore: 0,
      hasMoreHistory: false,
    })),
    contextUnsubscribe: vi.fn(async (contextId) => ({ contextId, unsubscribed: true as const })),
    contextSendMessage: vi.fn(async (input) => ({
      contextId: input.contextId,
      clientMessageId: input.clientMessageId,
      status: "accepted" as const,
    })),
  };
  const relay = new ContextRelay(transport);
  const updates: unknown[] = [];
  relay.registerPanel("panel-one", "tab:12", (view) => updates.push(view));
  relay.activate("generation:connection-one");
  return { relay, transport, updates };
};

describe("context relay", () => {
  it("requires advertisement and explicit panel selection before projecting events", async () => {
    const { relay, updates } = fixture();
    await relay.list("panel-one");
    relay.acceptEvent({
      contextId: "context-one",
      sequence: 1,
      lastSequence: 1,
      event: "message",
      data: { role: "assistant", text: "Not selected yet" },
    });
    expect(updates.at(-1)).toMatchObject({ selected: null });

    await relay.subscribe("panel-one", { contextId: "context-one", history: "tail" });
    relay.acceptEvent({
      contextId: "context-one",
      sequence: 1,
      lastSequence: 2,
      event: "message",
      data: { role: "assistant", text: "Visible after selection" },
    });
    expect(updates.at(-1)).toMatchObject({
      selectedContextId: "context-one",
      selected: { events: [{ data: { text: "Visible after selection" } }] },
    });
    relay.acceptEvent({
      contextId: "context-one",
      sequence: 1,
      lastSequence: 3,
      event: "message",
      data: { role: "assistant", text: "Visible streaming update" },
    });
    expect(updates.at(-1)).toMatchObject({
      selected: {
        lastSequence: 3,
        events: [{ data: { text: "Visible streaming update" } }],
      },
    });
    relay.acceptSnapshot({
      contextId: "context-one",
      events: [{
        contextId: "context-one",
        sequence: 1,
        event: "message",
        data: { role: "assistant", text: "Older paged text" },
      }],
      lastSequence: 3,
      complete: false,
    });
    expect(updates.at(-1)).toMatchObject({
      selected: { events: [{ data: { text: "Visible streaming update" } }] },
    });
  });

  it("ref-counts viewers and panel close only unsubscribes presentation", async () => {
    const { relay, transport } = fixture();
    relay.registerPanel("panel-two", "tab:13", () => undefined);
    await relay.list("panel-one");
    await relay.subscribe("panel-one", { contextId: "context-one", history: "tail" });
    await relay.subscribe("panel-two", { contextId: "context-one", history: "tail" });
    expect(transport.contextSubscribe).toHaveBeenCalledOnce();

    await relay.unregisterPanel("panel-one");
    expect(transport.contextUnsubscribe).not.toHaveBeenCalled();
    await relay.unregisterPanel("panel-two");
    expect(transport.contextUnsubscribe).toHaveBeenCalledExactlyOnceWith("context-one");
  });

  it("clears projected history at a connection-generation boundary", async () => {
    const { relay, transport } = fixture();
    await relay.list("panel-one");
    await relay.subscribe("panel-one", { contextId: "context-one", history: "tail" });
    relay.acceptEvent({
      contextId: "context-one",
      sequence: 1,
      lastSequence: 1,
      event: "message",
      data: { role: "user", text: "Sensitive in-memory text" },
    });

    relay.deactivate();
    await expect(relay.sendMessage("panel-one", {
      contextId: "context-one",
      clientMessageId: "client-one",
      text: "continue",
    })).rejects.toBeInstanceOf(ContextRelayError);
    expect(transport.contextSendMessage).not.toHaveBeenCalled();
  });

  it("binds sends to the selected advertised context and exact client id", async () => {
    const { relay, transport } = fixture();
    await relay.list("panel-one");
    await relay.subscribe("panel-one", { contextId: "context-one", history: "tail" });
    await expect(relay.sendMessage("panel-one", {
      contextId: "context-one",
      clientMessageId: "client-one",
      text: "Continue.",
    })).resolves.toMatchObject({ status: "accepted", clientMessageId: "client-one" });
    expect(transport.contextSendMessage).toHaveBeenCalledWith({
      contextId: "context-one",
      clientMessageId: "client-one",
      text: "Continue.",
    });
  });

  it("offers a prior explicit selection for reconstruction after panel reopen", async () => {
    const { relay } = fixture();
    await relay.list("panel-one");
    await relay.subscribe("panel-one", { contextId: "context-one", history: "tail" });
    await relay.unregisterPanel("panel-one");
    const reopened = relay.registerPanel("panel-reopened", "tab:12", () => undefined);
    expect(reopened).toMatchObject({
      selectedContextId: null,
      suggestedContextId: "context-one",
    });
  });
});
