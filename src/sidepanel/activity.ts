import type { ContextEvent } from "../protocol/context";

export const ACTIVITY_VISIBLE_MS = 5_000;

export function routineActivity(event: ContextEvent): boolean {
  return event.event === "activity" && event.data.status !== "failed";
}

// Historical updates must not become fresh merely because a panel reopened.
// Missing timestamps get a bounded local presentation lifetime, never authority.
export function activityDeadline(event: ContextEvent, firstSeen: number): number {
  return Math.min(event.timestampMs ?? firstSeen, firstSeen) + ACTIVITY_VISIBLE_MS;
}

export function compactEvents(events: ContextEvent[]): ContextEvent[] {
  let latest: ContextEvent | undefined;
  for (const event of events) if (routineActivity(event)) latest = event;
  return events.filter((event) => !routineActivity(event) || event === latest);
}
