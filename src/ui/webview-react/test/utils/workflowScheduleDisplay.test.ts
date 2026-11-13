import { describe, expect, it } from "vitest";
import type { WorkflowSchedule } from "@root/types/CtrlYokeTypes";
import { upcomingScheduleRunAt } from "@utils/workflowScheduleDisplay";

describe("upcomingScheduleRunAt", () => {
  const now = Date.parse("2026-12-01T12:00:00Z");
  const daily = (timeZone?: string): WorkflowSchedule => ({
    enabled: true,
    hostId: "owner",
    trigger: { cron: "0 9 * * *" },
    ...(timeZone ? { timeZone } : {}),
  });

  it("uses the owner's next run while it is still in the future", () => {
    const scheduleNextRunAt = now + 5_000;
    expect(
      upcomingScheduleRunAt(
        { schedule: daily("Asia/Tokyo"), scheduleNextRunAt },
        now,
        "America/New_York"
      )
    ).toBe(scheduleNextRunAt);
  });

  it("computes a stale next run in the owner's recorded zone", () => {
    // 09:00 in Tokyo on 2 December is 00:00 UTC.
    expect(
      upcomingScheduleRunAt(
        { schedule: daily("Asia/Tokyo"), scheduleNextRunAt: now - 5_000 },
        now,
        "America/New_York"
      )
    ).toBe(Date.parse("2026-12-02T00:00:00Z"));
  });

  it("falls back to the viewing host's zone for a schedule with no recorded zone", () => {
    // 09:00 in New York on 1 December is 14:00 UTC.
    expect(
      upcomingScheduleRunAt({ schedule: daily() }, now, "America/New_York")
    ).toBe(Date.parse("2026-12-01T14:00:00Z"));
  });
});
