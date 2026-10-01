import { suite, test } from "mocha";
import * as assert from "assert";
import {
  STATUS_BAR_BACKGROUNDS,
  buildStatusBarView,
} from "../../ui/StatusBarManager";
import {
  EMPTY_WORKFLOW_ACTIVITY,
  type LiveWorkflowActivity,
  type WorkflowActivitySummary,
} from "../../core/HostPorts";
import { HarnessStatus } from "../../core/HarnessIntegration";
import { HARNESS_IDS, VSCODE_COMMANDS } from "../../types/DashboardConstants";

function live(workflowId: string, progressLabel = "3/7"): LiveWorkflowActivity {
  return { workflowId, workflowName: `Workflow ${workflowId}`, progressLabel };
}

function activity(
  overrides: Partial<WorkflowActivitySummary>
): WorkflowActivitySummary {
  return { ...EMPTY_WORKFLOW_ACTIVITY, ...overrides };
}

suite("StatusBarManager view", () => {
  test("idle shows the default harness's readiness by its user-facing name", () => {
    const view = buildStatusBarView(EMPTY_WORKFLOW_ACTIVITY, {
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      initializationStatus: HarnessStatus.Ready,
      isReady: true,
      message: "",
    });

    assert.strictEqual(view.text, "$(compass-active) ctrlyoke - Ready");
    assert.strictEqual(
      view.tooltip,
      "ctrlyoke - Ready to run workflows with Claude Code"
    );
    assert.strictEqual(view.background, undefined);
    assert.strictEqual(view.command, VSCODE_COMMANDS.OPEN_PANEL);
  });

  test("an unavailable default harness is named and the click re-checks it", () => {
    const view = buildStatusBarView(EMPTY_WORKFLOW_ACTIVITY, {
      harnessId: HARNESS_IDS.CODEX_CLI,
      initializationStatus: HarnessStatus.Unavailable,
      isReady: false,
      message: "",
    });

    assert.strictEqual(view.text, "$(warning) ctrlyoke - Setup Required");
    assert.match(view.tooltip, /^ctrlyoke - Codex was not found\./);
    assert.strictEqual(view.command, VSCODE_COMMANDS.RETRY_HARNESS_DETECTION);
  });

  test("a single running workflow shows its progress without a color", () => {
    const view = buildStatusBarView(activity({ running: [live("a")] }));

    assert.strictEqual(view.text, "$(compass-dot) ctrlyoke 3/7");
    assert.strictEqual(view.background, undefined);
    assert.match(view.tooltip, /Running: Workflow a \(3\/7\)/);
  });

  test("several live workflows are counted, and any paused one warns", () => {
    const view = buildStatusBarView(
      activity({ running: [live("a"), live("b")], paused: [live("c")] })
    );

    assert.strictEqual(
      view.text,
      "$(debug-pause) ctrlyoke 1 paused · 2 running"
    );
    assert.strictEqual(view.background, STATUS_BAR_BACKGROUNDS.WARNING);
  });

  test("an unseen failure outranks live work and opens the failed run", () => {
    const view = buildStatusBarView(
      activity({
        running: [live("a")],
        unseenFailures: [{ workflowId: "b", workflowName: "" }],
      })
    );

    assert.strictEqual(view.text, "$(error) ctrlyoke 1 failed · 1 running");
    assert.strictEqual(view.background, STATUS_BAR_BACKGROUNDS.ERROR);
    assert.strictEqual(view.command, VSCODE_COMMANDS.OPEN_UNSEEN_FAILED_RUN);
    assert.match(view.tooltip, /Failed: New Workflow/);
  });

  test("a recent completion shows only while nothing else needs attention", () => {
    const recentCompletion = { workflowId: "a", workflowName: "Build" };

    assert.strictEqual(
      buildStatusBarView(activity({ recentCompletion })).text,
      "$(check) ctrlyoke Complete"
    );
    assert.strictEqual(
      buildStatusBarView(activity({ recentCompletion, running: [live("b")] }))
        .text,
      "$(compass-dot) ctrlyoke 3/7"
    );
  });
});
