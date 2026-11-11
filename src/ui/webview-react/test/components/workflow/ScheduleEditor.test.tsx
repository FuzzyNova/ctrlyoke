import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSchedule } from "@root/types/CtrlYokeTypes";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@messaging/sendMessage", () => ({ sendMessage }));
import { ScheduleEditor } from "@components/workflow/ScheduleEditor";

const address = { workflowKey: "wf-1" as never, kind: "draft" as const };

describe("ScheduleEditor", () => {
  afterEach(() => {
    cleanup();
    sendMessage.mockClear();
  });

  it("maps a daily picker to cron and posts a schedule", () => {
    render(
      <ScheduleEditor
        address={address}
        workflowName="Build"
        anchor={null}
        onClose={vi.fn()}
      />
    );
    fireEvent.change(screen.getByLabelText("Frequency"), {
      target: { value: "daily" },
    });
    fireEvent.change(screen.getByLabelText("Start date and time"), {
      target: { value: "2027-01-02T08:35" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sendMessage).toHaveBeenCalledWith("setSchedule", {
      address,
      enabled: true,
      trigger: { cron: "35 8 * * *" },
    });
  });

  it("maps a matching cron back to its picker and previews the next run", () => {
    const schedule: WorkflowSchedule = {
      enabled: true,
      trigger: { cron: "15 10 * * 1,3" },
      hostId: "host",
    };
    render(
      <ScheduleEditor
        address={address}
        workflowName="Build"
        schedule={schedule}
        anchor={null}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Frequency")).toHaveValue("weekly");
    expect(screen.getByText(/^Next run:/).textContent).not.toContain("None");
  });

  it("removes an existing schedule", () => {
    const schedule: WorkflowSchedule = {
      enabled: false,
      trigger: { at: "2027-01-02T08:35" },
      hostId: "host",
    };
    render(
      <ScheduleEditor
        address={address}
        workflowName="Build"
        schedule={schedule}
        anchor={null}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(sendMessage).toHaveBeenCalledWith("clearSchedule", { address });
  });
});
