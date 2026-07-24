/**
 * Tests for PromptEditor's EXECUTE_PROMPT submission addressing.
 *
 * A prompt-editor submission must carry the displayed run address and
 * optimistic revisions (`mutation`) so the backend appends to the exact run
 * the client is viewing — not whatever run the lineage's bound instance
 * happens to hold (typically the latest), which silently targeted the wrong
 * run when an older run was selected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub HarnessIcon so this test does not depend on `?raw` SVG asset
// resolution from src/ui/icons (denied by Vite's fs allow-list when vitest is
// invoked with a bare `--root src/ui/webview-react` instead of the project
// config). The icons are irrelevant to what is asserted here.
vi.mock("@components/shared/HarnessIcon", () => ({
  HarnessIcon: () => null,
}));

import { PromptEditor } from "@components/editor/PromptEditor";
import { useEditorStore } from "@store/editorStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  MESSAGE_TYPES,
  ACTION_TYPES,
  FINAL_STEP_PHASES,
  EXECUTION_STATES,
  STEP_STATUS,
} from "@/types/messages";
import { STEP_TYPES } from "@root/types/DashboardConstants";

// The vscode mock is set up in test/setup.ts (window.vscodeApi).
const postMessageSpy = vi.fn();

beforeEach(() => {
  useEditorStore.getState().resetEditor();
  useWorkflowStore.setState({
    steps: [],
    currentStep: 0,
    executionState: EXECUTION_STATES.IDLE,
  });
  useUiStore.setState({
    displayedViewAddress: null,
    displayedDefinitionRevision: null,
    displayedDescriptorRevision: null,
  });
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

function findExecutePromptMessage(): Record<string, unknown> | undefined {
  return postMessageSpy.mock.calls.find(
    ([msg]) => (msg as { type?: string }).type === MESSAGE_TYPES.EXECUTE_PROMPT
  )?.[0] as Record<string, unknown> | undefined;
}

describe("PromptEditor — EXECUTE_PROMPT run addressing", () => {
  it("attaches the displayed run mutation to a prompt submission", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().setPromptText("append to the viewed run");
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 4,
      displayedDescriptorRevision: 9,
    });

    const { container } = render(<PromptEditor />);
    const runButton = container.querySelector(
      ".btn-editor-run"
    ) as HTMLButtonElement;
    expect(runButton).not.toBeNull();
    await user.click(runButton);

    const message = findExecutePromptMessage();
    expect(message).toMatchObject({
      type: MESSAGE_TYPES.EXECUTE_PROMPT,
      text: "append to the viewed run",
      action: ACTION_TYPES.RUN,
      mutation: {
        address: { workflowKey: "wf-1", kind: "run", runRef: "run-1" },
        expectedDefinitionRevision: 4,
        expectedDescriptorRevision: 9,
      },
    });
  });

  it("attaches the displayed run mutation to a script final-step update", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      selectionTarget: { kind: FINAL_STEP_PHASES.FINAL_STEP },
      stepType: STEP_TYPES.SCRIPT,
      scriptCommand: "echo done",
    });
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 4,
      displayedDescriptorRevision: 9,
    });

    const { container } = render(<PromptEditor />);
    const updateButton = container.querySelector(
      ".btn-editor-update"
    ) as HTMLButtonElement;
    expect(updateButton).not.toBeNull();
    await user.click(updateButton);

    const message = postMessageSpy.mock.calls.find(
      ([msg]) =>
        (msg as { type?: string }).type === MESSAGE_TYPES.UPDATE_FINAL_PROMPT
    )?.[0] as Record<string, unknown> | undefined;
    expect(message).toMatchObject({
      type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
      mutation: {
        address: { workflowKey: "wf-1", kind: "run", runRef: "run-1" },
        expectedDefinitionRevision: 4,
        expectedDescriptorRevision: 9,
      },
    });
  });

  it("coordinates a completed-step edit in one update message instead of posting a stale rewind", async () => {
    const user = userEvent.setup();
    useWorkflowStore.setState({
      steps: [
        { prompt: "completed prefix", status: STEP_STATUS.COMPLETED },
        { prompt: "completed suffix", status: STEP_STATUS.COMPLETED },
      ],
      currentStep: 2,
      executionState: EXECUTION_STATES.COMPLETED,
    });
    useEditorStore
      .getState()
      .selectPrompt(
        { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        { prompt: "completed suffix" }
      );
    useEditorStore.getState().setPromptText("edited suffix");
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 2,
      displayedDescriptorRevision: 7,
    });

    const { container } = render(<PromptEditor />);
    const updateButton = container.querySelector(
      ".btn-editor-update"
    ) as HTMLButtonElement;
    expect(updateButton).not.toBeNull();
    await user.click(updateButton);

    const updateMessages = postMessageSpy.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === MESSAGE_TYPES.UPDATE_PROMPT);
    expect(updateMessages).toHaveLength(1);
    expect(updateMessages[0]).toMatchObject({
      index: 1,
      text: "edited suffix",
      rewindCompletedStep: true,
      mutation: {
        address: { workflowKey: "wf-1", kind: "run", runRef: "run-1" },
        expectedDefinitionRevision: 2,
        expectedDescriptorRevision: 7,
      },
    });
    expect(
      postMessageSpy.mock.calls.some(
        ([message]) =>
          (message as { type?: string }).type ===
          MESSAGE_TYPES.SET_START_POSITION
      )
    ).toBe(false);
  });

  it("omits the mutation when no persisted draft/run view is displayed", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().setPromptText("fresh ephemeral prompt");

    const { container } = render(<PromptEditor />);
    const runButton = container.querySelector(
      ".btn-editor-run"
    ) as HTMLButtonElement;
    await user.click(runButton);

    const message = findExecutePromptMessage();
    expect(message).toBeDefined();
    expect(message).not.toHaveProperty("mutation");
  });
});
