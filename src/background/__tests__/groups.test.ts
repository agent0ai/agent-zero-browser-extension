import {
  beginCorrelatedGroupMove,
  bindProviderGroup,
  boundGroupTitle,
  createTaskGroupIntent,
  isExtensionOwnedGroup,
  observeTabGroupChange,
  planGroupPlacement,
} from "../groups";
import { createLease, type TabLease } from "../leases";
import { createLoadGenerationId, createTabHandle, type EntropySource } from "../lifecycle";

const entropy = (value: number): EntropySource => (length) => new Uint8Array(length).fill(value);
const generation = createLoadGenerationId(entropy(0x11));

function lease(origin: "created" | "claimed" = "created", windowId = 7): TabLease {
  return createLease({
    tabHandle: createTabHandle(generation, entropy(origin === "created" ? 0x21 : 0x22)),
    loadGenerationId: generation,
    contextId: "context-1",
    browserSessionId: "session-1",
    turnId: "turn-1",
    origin,
    disposition: "ephemeral",
    siteOrigin: "https://example.com",
    identity: {
      browserInstanceId: "browser-1",
      providerTabId: origin === "created" ? 10 : 11,
      providerWindowId: windowId,
      documentId: null,
      documentEpoch: 0,
    },
    groupIntentId: origin === "created" ? "intent-1" : null,
    providerGroupId: origin === "created" ? null : 88,
  });
}

function intent() {
  return createTaskGroupIntent({
    intentId: "intent-1",
    loadGenerationId: generation,
    browserSessionId: "session-1",
    title: "  Research    task  ",
    color: "green",
  });
}

describe("task group intent", () => {
  it("maps one task intent to a distinct provider group in each window", () => {
    const first = bindProviderGroup(intent(), 7, 70);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = bindProviderGroup(first.intent, 8, 80);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.intent.providerGroupsByWindow).toEqual({
      "7": { providerWindowId: 7, providerGroupId: 70 },
      "8": { providerWindowId: 8, providerGroupId: 80 },
    });
    expect(bindProviderGroup(second.intent, 7, 71)).toMatchObject({
      ok: false,
      code: "GROUP_BINDING_CONFLICT",
    });
  });

  it("groups created tabs but preserves claimed tabs in place", () => {
    const created = lease("created");
    const claimed = lease("claimed");
    const unbound = intent();
    const bound = bindProviderGroup(unbound, 7, 70);
    if (!bound.ok) throw new Error("expected group binding");

    expect(planGroupPlacement(created, unbound)).toMatchObject({
      action: "create_and_join",
      providerWindowId: 7,
    });
    expect(planGroupPlacement(created, bound.intent)).toEqual({
      action: "join_existing",
      providerWindowId: 7,
      providerGroupId: 70,
    });
    expect(planGroupPlacement(claimed, bound.intent)).toEqual({
      action: "preserve_user_location",
      reason: "claimed_tab",
    });
  });

  it("accepts an exact correlated move and treats uncorrelated regrouping as takeover", () => {
    const moving = beginCorrelatedGroupMove(lease(), "action-1", {
      providerWindowId: 7,
      providerGroupId: "new",
    });
    const grouped = observeTabGroupChange(moving, {
      providerWindowId: 7,
      providerGroupId: 70,
      correlatedActionId: "action-1",
    });
    expect(grouped).toMatchObject({
      state: "active",
      providerGroupId: 70,
      expectedGroupActionId: null,
      expectedGroupWindowId: null,
      expectedProviderGroupId: null,
    });

    const takenOver = observeTabGroupChange(grouped, {
      providerWindowId: 7,
      providerGroupId: 71,
    });
    expect(takenOver).toMatchObject({
      state: "released",
      userIntervened: true,
      userTakeoverReason: "regrouped",
      retentionReason: "user_takeover",
    });
  });

  it("rejects a matching action token when the observed group target is different", () => {
    const moving = beginCorrelatedGroupMove(lease(), "action-1", {
      providerWindowId: 7,
      providerGroupId: 70,
    });
    const takenOver = observeTabGroupChange(moving, {
      providerWindowId: 7,
      providerGroupId: 71,
      correlatedActionId: "action-1",
    });

    expect(takenOver).toMatchObject({
      state: "released",
      userIntervened: true,
      retentionReason: "user_takeover",
    });
  });

  it("recognizes extension ownership only from the exact generation, intent, window, and group", () => {
    const binding = bindProviderGroup(intent(), 7, 70);
    if (!binding.ok) throw new Error("expected group binding");
    const grouped = { ...lease(), providerGroupId: 70 };

    expect(isExtensionOwnedGroup(grouped, binding.intent, 70)).toBe(true);
    expect(isExtensionOwnedGroup(grouped, binding.intent, 71)).toBe(false);
    expect(isExtensionOwnedGroup(lease("claimed"), binding.intent, 70)).toBe(false);
  });

  it("bounds and normalizes task-derived group titles", () => {
    expect(boundGroupTitle("  A    useful   task ")).toBe("A useful task");
    expect(Array.from(boundGroupTitle("x".repeat(200)))).toHaveLength(80);
    expect(boundGroupTitle(" \n ")).toBe("Agent Zero");
  });
});
