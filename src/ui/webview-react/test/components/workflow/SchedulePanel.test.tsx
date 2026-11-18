import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSchedule } from "@root/types/CtrlYokeTypes";
import {
  localTimeZone,
  scheduleCalendar,
} from "@root/utils/ScheduleCalendar";
import { ownerScheduleCalendar } from "@root/utils/WorkflowSchedule";
import { upcomingScheduleRunLabel } from "@utils/workflowScheduleDisplay";
import { useUiStore } from "@store/uiStore";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@messaging/sendMessage", () => ({ sendMessage }));
import { SchedulePanel } from "@components/workflow/SchedulePanel";

const address = { workflowKey: "wf-1" as never, kind: "draft" as const };

function renderPanel(
  schedule?: WorkflowSchedule,
  onBack = vi.fn(),
  scheduleOnOtherHost = false
) {
  render(
    <SchedulePanel
      address={address}
      workflowName="Build"
      schedule={schedule}
      scheduleOnOtherHost={scheduleOnOtherHost}
      backLabel="Back to workflow list"
      onBack={onBack}
    />
  );
  return { onBack };
}

describe("SchedulePanel", () => {
  afterEach(() => {
    cleanup();
    sendMessage.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useUiStore.setState({ hostTimeZone: undefined });
  });

  describe("when the host is in another time zone", () => {
    // UTC+14, so its wall clock differs from any test machine's but its own.
    const HOST_ZONE = "Pacific/Kiritimati";
    // 02:00 on 2 December in the host's zone.
    const NOW = Date.parse("2026-12-01T12:00:00Z");
    const hostZoneDiffers = localTimeZone() !== HOST_ZONE;

    function useHostZone() {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      useUiStore.setState({ hostTimeZone: HOST_ZONE });
    }

    it.runIf(hostZoneDiffers)(
      "defaults a once time to the host's next whole hour and names the zone",
      () => {
        useHostZone();
        renderPanel();
        expect(screen.getByLabelText("Date and time")).toHaveValue(
          "2026-12-02T03:00"
        );
        expect(
          screen.getByText(`Times are in the host's timezone, ${HOST_ZONE}.`)
        ).toBeInTheDocument();
      }
    );

    it.runIf(hostZoneDiffers)(
      "refuses a once time already past on the host's clock",
      () => {
        useHostZone();
        renderPanel();
        fireEvent.change(screen.getByLabelText("Date and time"), {
          target: { value: "2026-12-02T01:00" },
        });
        expect(screen.getByRole("alert")).toHaveTextContent(
          "This schedule has no future runs."
        );
        fireEvent.change(screen.getByLabelText("Date and time"), {
          target: { value: "2026-12-02T09:00" },
        });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      }
    );

    it.runIf(hostZoneDiffers)(
      "previews a cron run at the host's wall-clock time",
      () => {
        useHostZone();
        renderPanel({
          enabled: true,
          trigger: { cron: "0 9 * * *" },
          hostId: "host",
        });
        const expected = new Date(
          Date.parse("2026-12-01T19:00:00Z")
        ).toLocaleString(undefined, {
          timeZone: HOST_ZONE,
          timeZoneName: "short",
        });
        expect(screen.getByText(/^Next run:/).closest("p")).toHaveTextContent(
          expected
        );
      }
    );
  });

  it("titles the view with the workflow name and backs out", () => {
    const { onBack } = renderPanel();
    expect(
      screen.getByRole("region", { name: "Schedule Build" })
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to workflow list" })
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("creates an active schedule without a pause or enabled control", () => {
    const { onBack } = renderPanel();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove schedule" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Daily" }));
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "08:35" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(sendMessage).toHaveBeenCalledWith("setSchedule", {
      address,
      enabled: true,
      trigger: { cron: "35 8 * * *" },
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("builds a weekly cron from the day buttons and requires a day", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "Weekly" }));
    for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      const button = screen.getByRole("button", { name: day });
      if (button.getAttribute("aria-pressed") === "true") {
        fireEvent.click(button);
      }
    }
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Pick at least one day."
    );
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Wed" }));
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(sendMessage).toHaveBeenCalledWith("setSchedule", {
      address,
      enabled: true,
      trigger: { cron: "0 9 * * 1,3" },
    });
  });

  it("refuses a one-shot time in the past", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Date and time"), {
      target: { value: "2001-01-01T08:00" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This schedule has no future runs."
    );
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
  });

  it("maps a matching cron back to its picker and previews the next run", () => {
    renderPanel({
      enabled: true,
      trigger: { cron: "15 10 * * 1,3" },
      hostId: "host",
    });
    expect(screen.getByRole("radio", { name: "Weekly" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByLabelText("Time")).toHaveValue("10:15");
    expect(
      screen.getByText(/^Next run:/).closest("p")?.textContent
    ).not.toContain("None");
  });

  it("maps a monthly cron back to the day-of-month picker", () => {
    renderPanel({
      enabled: true,
      trigger: { cron: "0 6 31 * *" },
      hostId: "host",
    });
    expect(screen.getByRole("radio", { name: "Monthly" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.getByLabelText("Day of month")).toHaveValue(31);
    expect(
      screen.getByText("Months without this day are skipped.")
    ).toBeInTheDocument();
  });

  it("pauses an existing schedule and saves the change", () => {
    renderPanel({
      enabled: true,
      trigger: { cron: "0 9 * * *" },
      hostId: "host",
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Pause this schedule" })
    );
    expect(screen.getByText(/^Next run:/).closest("p")).toHaveTextContent(
      "Paused"
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(sendMessage).toHaveBeenCalledWith("setSchedule", {
      address,
      enabled: false,
      trigger: { cron: "0 9 * * *" },
    });
  });

  describe("a schedule owned in another timezone", () => {
    const HOST_ZONE = "America/New_York";
    const OWNER_ZONE = "Asia/Tokyo";
    const NOW = Date.parse("2026-03-07T00:00:00Z");

    function useZones() {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      useUiStore.setState({ hostTimeZone: HOST_ZONE });
    }

    const onceSchedule: WorkflowSchedule = {
      enabled: true,
      trigger: { at: "2026-03-08T02:30" },
      hostId: "owner",
      timeZone: OWNER_ZONE,
    };

    it("shows the same next run as the workflow list", () => {
      useZones();
      const schedule: WorkflowSchedule = {
        enabled: true,
        trigger: { cron: "0 9 * * *" },
        hostId: "owner",
        timeZone: OWNER_ZONE,
      };
      renderPanel(schedule, vi.fn(), true);
      const listLabel = upcomingScheduleRunLabel(
        { schedule },
        NOW,
        HOST_ZONE
      );
      expect(screen.getByText(/^Next run:/).closest("p")).toHaveTextContent(
        listLabel!
      );
    });

    it("converts an untouched Once time and keeps its instant on a Pause-only save", () => {
      useZones();
      renderPanel(onceSchedule, vi.fn(), true);
      expect(screen.getByLabelText("Date and time")).toHaveValue(
        "2026-03-07T12:30"
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Pause this schedule" })
      );
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(sendMessage).toHaveBeenCalledWith("setSchedule", {
        address,
        enabled: false,
        trigger: { at: "2026-03-07T12:30" },
      });
      expect(
        scheduleCalendar(HOST_ZONE)
          .fromFields(2026, 2, 7, 12, 30, 0)
          .getTime()
      ).toBe(
        ownerScheduleCalendar(onceSchedule, HOST_ZONE)
          .fromFields(2026, 2, 8, 2, 30, 0)
          .getTime()
      );
    });

    it("does not report a false DST-gap validation error for an untouched Once time", () => {
      useZones();
      renderPanel(onceSchedule, vi.fn(), true);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save changes" })
      ).toBeEnabled();
    });

    it("explains the timezone reinterpretation for recurring schedules", () => {
      useZones();
      renderPanel(
        {
          enabled: true,
          trigger: { cron: "0 9 * * *" },
          hostId: "owner",
          timeZone: OWNER_ZONE,
        },
        vi.fn(),
        true
      );
      expect(screen.getByText(/Scheduled on another machine/)).toHaveTextContent(
        `It currently runs in ${OWNER_ZONE}`
      );
      expect(screen.getByText(/Scheduled on another machine/)).toHaveTextContent(
        `saving reinterprets its times in this machine's timezone ${HOST_ZONE}`
      );
    });
  });

  it("removes an existing schedule and backs out", () => {
    const { onBack } = renderPanel({
      enabled: false,
      trigger: { at: "2027-01-02T08:35" },
      hostId: "host",
    });
    expect(
      screen.getByRole("checkbox", { name: "Pause this schedule" })
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Remove schedule" }));
    expect(sendMessage).toHaveBeenCalledWith("clearSchedule", { address });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
