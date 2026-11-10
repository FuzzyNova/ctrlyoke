import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PromptChangesButton } from "@components/shared/PromptChangesButton";
import {
  createPromptChangeSummary,
  getPromptChangeLabelSteps,
} from "@utils/promptUndo";

describe("getPromptChangeLabelSteps", () => {
  it("steps from the full label to View N, N and the icon alone", () => {
    const summary = createPromptChangeSummary(12, 10, 2, 0);
    expect(getPromptChangeLabelSteps(summary)).toEqual([
      { main: "View 12 changes", undone: " (2 undone)" },
      { main: "View 12", undone: "" },
      { main: "12", undone: "" },
      { main: "", undone: "" },
    ]);
  });

  it("starts at View N when compact", () => {
    const summary = createPromptChangeSummary(3, 3, 0, 0);
    expect(
      getPromptChangeLabelSteps(summary, true).map((step) => step.main)
    ).toEqual(["View 3", "3", ""]);
  });
});

describe("PromptChangesButton", () => {
  /** Natural widths of each step's content (icon included), by its text. */
  const STEP_WIDTHS: Record<string, number> = {
    "View 3 changes": 110,
    "View 3": 60,
    "3": 30,
    "": 16,
  };
  let buttonWidth = 0;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width =
          this.tagName === "BUTTON"
            ? buttonWidth
            : (STEP_WIDTHS[this.textContent ?? ""] ?? 0);
        return DOMRect.fromRect({ width, height: 16 });
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderAt = (width: number, compact = false) => {
    buttonWidth = width;
    const summary = createPromptChangeSummary(3, 3, 0, 0);
    render(
      <PromptChangesButton
        summary={summary}
        compact={compact}
        onClick={() => {}}
        title={summary.title}
        ariaLabel={summary.label}
        className="gap-1"
      />
    );
    return screen.getByRole("button", { name: "View 3 changes" });
  };

  const activeStepText = (button: HTMLElement) =>
    button.querySelector("[data-change-label-step='active']")?.textContent;

  it.each([
    [200, "View 3 changes"],
    [110, "View 3 changes"],
    [109, "View 3"],
    [59, "3"],
    [29, ""],
    [0, ""],
  ])("at %ipx shows %j, never a truncated label", (width, expected) => {
    expect(activeStepText(renderAt(width))).toBe(expected);
  });

  it("never offers the full label when compact", () => {
    expect(activeStepText(renderAt(200, true))).toBe("View 3");
  });

  it("pins its width to the widest step and its minimum to the icon", () => {
    const button = renderAt(50);
    expect(button.style.width).toBe("110px");
    expect(button.style.minWidth).toBe("16px");
  });

  it("keeps the hidden steps out of sight", () => {
    const button = renderAt(59);
    const hidden = [
      ...button.querySelectorAll(":scope > span:not([data-change-label-step])"),
    ];
    expect(hidden).toHaveLength(3);
    for (const step of hidden) expect(step).toHaveClass("invisible");
  });
});
