import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  WorkflowList,
  type UnifiedWorkflowRow,
} from "@components/workflow/WorkflowList";
import { EXECUTION_STATES, HARNESS_IDS } from "@/types/messages";
import type { WorkflowTokenTotals } from "@root/types/CtrlYokeTypes";
import type { WorkflowRowTier } from "@/constants";

const totalsBase: WorkflowTokenTotals = {
  total: 410_000,
  coverage: "complete",
  reportedAttemptCount: 1,
  attemptCount: 1,
  isFinal: true,
  byHarness: {},
  byLocalDay: {},
};

function makeTotals(
  variant: "complete" | "partial" | "running"
): WorkflowTokenTotals {
  return {
    ...totalsBase,
    coverage: variant === "partial" ? "partial" : "complete",
    isFinal: variant !== "running",
  };
}

function renderWorkflowList(
  tier: WorkflowRowTier,
  kind: "recent" | "running",
  totals?: WorkflowTokenTotals
) {
  const row: UnifiedWorkflowRow =
    kind === "recent"
      ? {
          kind,
          key: "recent:wf",
          workflow: {
            address: {
              workflowKey: "wf" as never,
              kind: "run",
              runRef: "run-1" as never,
            },
            workflowName: "Token workflow",
            executionState: EXECUTION_STATES.COMPLETED,
            totalSteps: 2,
            harness: HARNESS_IDS.CLAUDE_CLI,
            tokenTotals: totals,
          },
        }
      : {
          kind,
          key: "running:wf",
          workflow: {
            id: "workflow-id",
            workflowName: "Token workflow",
            filePath: "workflow.prompt.md",
            executionState: EXECUTION_STATES.RUNNING,
            currentStep: 1,
            totalSteps: 2,
            harness: HARNESS_IDS.CLAUDE_CLI,
            tokenTotals: totals,
          },
        };

  return render(
    <WorkflowList
      rows={[row]}
      currentAddress={null}
      activeWorkflowId={kind === "running" ? "workflow-id" : null}
      runningHasActiveTerminal={() => false}
      onSelectRecent={() => undefined}
      onSwitchRunning={() => undefined}
      onPauseRunning={() => undefined}
      onCancelPauseRunning={() => undefined}
      onResumeRunning={() => undefined}
      onStopRunning={() => undefined}
      onClearHistory={() => undefined}
      tier={tier}
    />
  );
}

describe("WorkflowList token totals", () => {
  afterEach(() => cleanup());

  it.each(["flat", "stacked", "compact"] as const)(
    "renders complete totals and the full accessible phrase at the %s tier",
    (tier) => {
      renderWorkflowList(tier, "recent", makeTotals("complete"));

      expect(
        screen.getByRole("button", { name: /410,000 total tokens/ })
      ).toBeInTheDocument();
      if (tier === "compact") {
        expect(screen.queryByTestId("workflow-token-usage")).toBeNull();
      } else {
        expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
          "410k"
        );
      }
    }
  );

  it.each(["flat", "stacked", "compact"] as const)(
    "renders partial totals as lower bounds at the %s tier",
    (tier) => {
      renderWorkflowList(tier, "recent", makeTotals("partial"));

      expect(
        screen.getByRole("button", { name: /at least 410,000 observed tokens/ })
      ).toBeInTheDocument();
      if (tier !== "compact") {
        expect(screen.getByTestId("workflow-token-usage")).toHaveTextContent(
          "≥410k"
        );
      }
    }
  );

  it.each(["flat", "stacked", "compact"] as const)(
    "shows the live observed-so-far total at the %s tier",
    (tier) => {
      renderWorkflowList(tier, "running", makeTotals("running"));

      const usage = screen.queryByTestId("workflow-token-usage");
      expect(
        screen.getByRole("button", { name: /410,000 total tokens/ })
      ).toBeInTheDocument();
      if (tier === "compact") {
        expect(usage).toBeNull();
      } else {
        expect(usage).toHaveAttribute(
          "title",
          expect.stringContaining("still increasing")
        );
      }
    }
  );

  it.each(["flat", "stacked", "compact"] as const)(
    "renders no usage slot for unavailable totals at the %s tier",
    (tier) => {
      renderWorkflowList(tier, "recent");

      expect(screen.queryByTestId("workflow-token-usage")).toBeNull();
      expect(
        screen.getByRole("button", { name: /Token workflow/ })
      ).not.toHaveAttribute("aria-label", expect.stringMatching(/tokens/));
    }
  );
});
