import { describe, expect, it } from "vitest";
import type { ContextEvent } from "../protocol/context";
import { activityDeadline, compactEvents } from "./activity";

const activity = (sequence: number, status: "working" | "updated" | "failed" = "updated"): ContextEvent => ({
  event: "activity", contextId: "chat", sequence, data: { activity: "tool", status },
});

describe("transient chat activity", () => {
  it("keeps only the newest routine update without removing messages or errors", () => {
    const message: ContextEvent = { event: "message", contextId: "chat", sequence: 2, data: { role: "assistant", text: "Reply" } };
    const error = activity(3, "failed");
    const latest = activity(4, "working");
    expect(compactEvents([activity(1), message, error, latest])).toEqual([message, error, latest]);
  });
  it("expires updates after five seconds and does not revive historical timestamps", () => {
    expect(activityDeadline(activity(1), 10_000)).toBe(15_000);
    expect(activityDeadline({ ...activity(1), timestampMs: 1_000 }, 10_000)).toBe(6_000);
    expect(activityDeadline({ ...activity(1), timestampMs: 999_000 }, 10_000)).toBe(15_000);
  });
});
