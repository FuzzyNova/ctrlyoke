import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusIcon } from "@components/steps/StatusIcon";
import { STEP_STATUS, type StepStatus } from "@/types/messages";
import { getStatusColorClass } from "@utils/status";

const EXPECTED_ICONS: Record<StepStatus, string> = {
  [STEP_STATUS.PENDING]: "codicon-circle-outline",
  [STEP_STATUS.SENT]: "codicon-arrow-up",
  [STEP_STATUS.RUNNING]: "codicon-play",
  [STEP_STATUS.COMPLETED]: "codicon-pass",
  [STEP_STATUS.FAILED]: "codicon-error",
  [STEP_STATUS.CANCELLED]: "codicon-circle-slash",
  [STEP_STATUS.SKIPPED]: "codicon-debug-step-over",
  [STEP_STATUS.NO_TURN_STARTED]: "codicon-debug-pause",
};

function renderIcon(props: React.ComponentProps<typeof StatusIcon>): Element {
  const { container } = render(<StatusIcon {...props} />);
  const icon = container.querySelector(".codicon");
  if (!icon) throw new Error("StatusIcon rendered no codicon");
  return icon;
}

describe("StatusIcon", () => {
  for (const [status, iconClass] of Object.entries(EXPECTED_ICONS)) {
    it(`renders ${iconClass} for ${status}`, () => {
      const icon = renderIcon({ status: status as StepStatus });
      expect(icon.classList.contains(iconClass)).toBe(true);
      for (const colorClass of getStatusColorClass(status as StepStatus).split(
        " "
      )) {
        expect(icon.classList.contains(colorClass)).toBe(true);
      }
    });
  }

  it("renders a disabled step as circle-slash regardless of status", () => {
    const icon = renderIcon({ status: STEP_STATUS.COMPLETED, disabled: true });
    expect(icon.classList.contains("codicon-circle-slash")).toBe(true);
    expect(icon.classList.contains("text-disabled-fg")).toBe(true);
    expect(icon.getAttribute("aria-label")).toBe("disabled");
  });

  it("falls back to the pending icon for an unknown status", () => {
    const icon = renderIcon({ status: "bogus" as StepStatus });
    expect(icon.classList.contains("codicon-circle-outline")).toBe(true);
  });

  it("pulses only a running icon when animated", () => {
    expect(
      renderIcon({ status: STEP_STATUS.RUNNING, animate: true }).classList
    ).toContain("animate-pulse-custom");
    expect(
      renderIcon({ status: STEP_STATUS.PENDING, animate: true }).classList
    ).not.toContain("animate-pulse-custom");
  });
});
