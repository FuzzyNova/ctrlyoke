import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSchedule } from "@root/types/CtrlYokeTypes";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@messaging/sendMessage", () => ({ sendMessage }));
import { SchedulePanel } from "@components/workflow/SchedulePanel";

const address = { workflowKey: "wf-1" as never, kind: "draft" as const };

function renderPanel(schedule?: WorkflowSchedule, onBack = vi.fn()) {
  render(
    <SchedulePanel
      address={address}
      workflowName="Build"
      schedule={schedule}
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
