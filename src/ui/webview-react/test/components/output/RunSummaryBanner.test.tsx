import type { ComponentProps } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RunSummaryBanner } from "@components/output/RunSummaryBanner";
import { EXECUTION_STATES } from "@/types/messages";
import type { WorkflowTokenTotals } from "@root/types/CtrlYokeTypes";

const tokenTotals: WorkflowTokenTotals = {
  total: 410_000,
  coverage: "complete",
  reportedAttemptCount: 1,
  attemptCount: 1,
  isFinal: true,
  costUsd: 0.41,
  byHarness: {},
  byLocalDay: {},
};

function renderBanner(
  overrides: Partial<ComponentProps<typeof RunSummaryBanner>> = {}
) {
  return render(
    <RunSummaryBanner
      runId={14}
      startedAt={Date.parse("2026-08-10T12:10:23Z")}
      executionState={EXECUTION_STATES.COMPLETED}
      tokenTotals={tokenTotals}
      isPinned={true}
      onTogglePinned={vi.fn()}
      showBackToLive={false}
      onBackToLive={vi.fn()}
      {...overrides}
    />
  );
}

describe("RunSummaryBanner", () => {
  it("shows the run number, date, status, and token/cost totals", () => {
    renderBanner();

    expect(screen.getByText(/Run 14/)).toBeInTheDocument();
    expect(screen.getByText(EXECUTION_STATES.COMPLETED)).toBeInTheDocument();
    expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
      "410k · ≈$0.41"
    );
  });

  it("renders nothing for token usage when there is no usable total", () => {
    renderBanner({ tokenTotals: undefined });

    expect(
      screen.queryByTestId("workflow-token-usage")
    ).not.toBeInTheDocument();
  });

  it("applies sticky positioning only while pinned", () => {
    const { container, rerender } = renderBanner({ isPinned: true });
    expect(container.firstChild).toHaveClass("sticky");

    rerender(
      <RunSummaryBanner
        runId={14}
        startedAt={Date.now()}
        executionState={EXECUTION_STATES.COMPLETED}
        tokenTotals={tokenTotals}
        isPinned={false}
        onTogglePinned={vi.fn()}
        showBackToLive={false}
      />
    );
    expect(container.firstChild).not.toHaveClass("sticky");
  });

  it("shows a pinned icon when pinned and a plain pin icon when unpinned, toggling on click", () => {
    const onTogglePinned = vi.fn();
    const { container, rerender } = renderBanner({
      isPinned: true,
      onTogglePinned,
    });

    const pinButton = screen.getByRole("button", {
      name: "Unpin run summary",
    });
    expect(container.querySelector(".codicon-pinned")).not.toBeNull();

    fireEvent.click(pinButton);
    expect(onTogglePinned).toHaveBeenCalledOnce();

    rerender(
      <RunSummaryBanner
        runId={14}
        startedAt={Date.now()}
        executionState={EXECUTION_STATES.COMPLETED}
        tokenTotals={tokenTotals}
        isPinned={false}
        onTogglePinned={onTogglePinned}
        showBackToLive={false}
      />
    );
    expect(
      screen.getByRole("button", { name: "Pin run summary" })
    ).toBeInTheDocument();
    expect(container.querySelector(".codicon-pin")).not.toBeNull();
  });

  it("shows Back to Live only when browsing history during a live execution", () => {
    const onBackToLive = vi.fn();
    renderBanner({ showBackToLive: true, onBackToLive });

    const backToLive = screen.getByRole("button", { name: /Back to Live/ });
    fireEvent.click(backToLive);
    expect(onBackToLive).toHaveBeenCalledOnce();
  });

  it("hides Back to Live when not applicable", () => {
    renderBanner({ showBackToLive: false });

    expect(
      screen.queryByRole("button", { name: /Back to Live/ })
    ).not.toBeInTheDocument();
  });
});
