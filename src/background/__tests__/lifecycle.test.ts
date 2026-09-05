import {
  createInstallInstanceId,
  createLoadGenerationId,
  createTabHandle,
  createWorkerBootId,
  isTabHandle,
  parseTabHandle,
  persistedLifecycleProjection,
  planLifecycleBoot,
  tabHandleBelongsToGeneration,
  transitionLifecycle,
  type EntropySource,
} from "../lifecycle";

const filledEntropy = (value: number): EntropySource => (length) => new Uint8Array(length).fill(value);

describe("MV3 lifecycle identities", () => {
  it("creates opaque handles with independent 128-bit generation and lease components", () => {
    const generation = createLoadGenerationId(filledEntropy(0x11));
    const handle = createTabHandle(generation, filledEntropy(0x22));

    expect(generation).toBe(`a0g1.${"11".repeat(16)}`);
    expect(handle).toBe(`a0t1.${"11".repeat(16)}.${"22".repeat(16)}`);
    expect(parseTabHandle(handle)).toEqual({
      generationToken: "11".repeat(16),
      leaseToken: "22".repeat(16),
    });
    expect(isTabHandle(handle)).toBe(true);
    expect(tabHandleBelongsToGeneration(handle, generation)).toBe(true);
    expect(handle).not.toMatch(/\b(?:tab|window|group)[_-]?\d+/iu);
  });

  it("rejects malformed or cross-generation handles", () => {
    const generation = createLoadGenerationId(filledEntropy(0x11));
    const otherGeneration = createLoadGenerationId(filledEntropy(0x12));
    const handle = createTabHandle(generation, filledEntropy(0x22));

    expect(isTabHandle("a0t1.short.short")).toBe(false);
    expect(tabHandleBelongsToGeneration(handle, otherGeneration)).toBe(false);
    expect(() => createTabHandle("bad-generation" as typeof generation, filledEntropy(0x22))).toThrow(
      /invalid load generation/u,
    );
  });
});

describe("MV3 lifecycle boot planning", () => {
  it("resumes a valid session for the same install instance", () => {
    const installInstanceId = createInstallInstanceId(filledEntropy(0x01));
    const generation = createLoadGenerationId(filledEntropy(0x02));
    const workerBootId = createWorkerBootId(filledEntropy(0x03));
    const initial = planLifecycleBoot({
      installInstanceId,
      workerBootId,
      newGenerationId: generation,
    });
    const ready = { ...initial.state, phase: "READY" as const, revision: 7 };

    const resumed = planLifecycleBoot({
      installInstanceId,
      workerBootId: createWorkerBootId(filledEntropy(0x04)),
      persistedSession: persistedLifecycleProjection(ready),
      newGenerationId: createLoadGenerationId(filledEntropy(0x05)),
    });

    expect(resumed.disposition).toBe("resume_generation");
    expect(resumed.state.loadGenerationId).toBe(generation);
    expect(resumed.state.revision).toBe(7);
  });

  it("resets the generation when session state is absent, malformed, or belongs to another install", () => {
    const installInstanceId = createInstallInstanceId(filledEntropy(0x01));
    const newGenerationId = createLoadGenerationId(filledEntropy(0x09));
    const plan = planLifecycleBoot({
      installInstanceId,
      workerBootId: createWorkerBootId(filledEntropy(0x03)),
      persistedSession: { loadGenerationId: "a0g1.not-valid", revision: 500 },
      newGenerationId,
    });

    expect(plan.disposition).toBe("reset_generation");
    expect(plan.state).toMatchObject({
      loadGenerationId: newGenerationId,
      phase: "RESET_GENERATION",
      revision: 0,
    });
  });

  it("serializes phase changes with exact revision checks", () => {
    const plan = planLifecycleBoot({
      installInstanceId: createInstallInstanceId(filledEntropy(0x01)),
      workerBootId: createWorkerBootId(filledEntropy(0x02)),
      newGenerationId: createLoadGenerationId(filledEntropy(0x03)),
    });

    const connecting = transitionLifecycle(plan.state, 0, "CONNECTING");
    expect(connecting.ok).toBe(true);
    if (!connecting.ok) return;
    expect(connecting.state.revision).toBe(1);
    expect(transitionLifecycle(connecting.state, 0, "NEGOTIATING")).toMatchObject({
      ok: false,
      code: "REVISION_CONFLICT",
    });
    expect(transitionLifecycle(connecting.state, 1, "READY")).toMatchObject({
      ok: false,
      code: "INVALID_TRANSITION",
    });
  });
});
