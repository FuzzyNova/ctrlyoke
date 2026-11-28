import { afterEach, describe, expect, it } from "vitest";
import { useEditorStore } from "@store/editorStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  CONDITION_ACTIONS,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  STEP_TYPES,
  SUB_WORKFLOW_EDITOR_FORMS,
} from "@root/types/DashboardConstants";
import { getExecutionPreviewEditorSnapshot } from "@utils/executionPreview";

const savedScript = {
  type: STEP_TYPES.SCRIPT,
  script: "echo hello",
  executionMode: EXECUTION_MODES.INTERACTIVE,
  shell: "pwsh",
  onPass: "stopWorkflow",
  env: { SAVED: "value" },
} as const;

function selectSavedScript(): void {
  useWorkflowStore.getState().loadWorkflow({
    fileName: "workflow.ctrlyoke.yaml",
    steps: [savedScript],
  });
  useEditorStore
    .getState()
    .selectPrompt({ kind: FINAL_STEP_PHASES.QUEUE, index: 0 }, savedScript);
}

afterEach(() => {
  useEditorStore.setState(useEditorStore.getInitialState());
  useWorkflowStore.setState(useWorkflowStore.getInitialState());
});

describe("getExecutionPreviewEditorSnapshot script steps", () => {
  it("keeps saved script properties when the editor is unchanged", () => {
    selectSavedScript();

    expect(getExecutionPreviewEditorSnapshot()?.step).toMatchObject({
      executionMode: EXECUTION_MODES.INTERACTIVE,
      shell: "pwsh",
      onPass: "stopWorkflow",
      env: { SAVED: "value" },
    });
  });

  it("clears saved overrides when the editor returns them to defaults", () => {
    selectSavedScript();
    useEditorStore.setState({
      scriptExecutionMode: undefined,
      scriptShell: undefined,
      scriptOnPass: CONDITION_ACTIONS.CONTINUE,
    });

    const snapshot = getExecutionPreviewEditorSnapshot();
    expect(snapshot?.step).not.toHaveProperty("executionMode");
    expect(snapshot?.step).not.toHaveProperty("shell");
    expect(snapshot?.step).not.toHaveProperty("onPass");
  });

  it("applies unsaved shell and environment edits", () => {
    selectSavedScript();
    useEditorStore.setState({
      scriptShell: "bash",
      scriptEnv: { UNSAVED: "current" },
    });

    expect(getExecutionPreviewEditorSnapshot()?.step).toMatchObject({
      shell: "bash",
      env: { UNSAVED: "current" },
    });
  });
});

describe("getExecutionPreviewEditorSnapshot sub-workflow steps", () => {
  const savedWorkflowStep = {
    type: STEP_TYPES.WORKFLOW,
    workflow: "workflows/verify.ctrlyoke.yaml",
    onFail: CONDITION_ACTIONS.CONTINUE,
    name: "Verify",
  } as const;

  function selectSavedWorkflowStep(step: object = savedWorkflowStep): void {
    useWorkflowStore.getState().loadWorkflow({
      fileName: "workflow.ctrlyoke.yaml",
      steps: [step as never],
    });
    useEditorStore
      .getState()
      .selectPrompt({ kind: FINAL_STEP_PHASES.QUEUE, index: 0 }, step as never);
  }

  it("previews the edited file reference over the saved step", () => {
    selectSavedWorkflowStep();
    useEditorStore
      .getState()
      .setSubWorkflowPath("workflows/checks.ctrlyoke.yaml");
    useEditorStore
      .getState()
      .setSubWorkflowOnFail(CONDITION_ACTIONS.STOP_WORKFLOW);

    const snapshot = getExecutionPreviewEditorSnapshot();
    expect(snapshot).toMatchObject({
      stepIndex: 0,
      step: {
        type: STEP_TYPES.WORKFLOW,
        workflow: "workflows/checks.ctrlyoke.yaml",
        name: "Verify",
      },
    });
    expect(snapshot?.step).not.toHaveProperty("onFail");
  });

  it("previews a new file workflow step at the end of the queue", () => {
    useEditorStore.getState().setStepType(STEP_TYPES.WORKFLOW);
    useEditorStore
      .getState()
      .setSubWorkflowPath("workflows/next.ctrlyoke.yaml");

    expect(getExecutionPreviewEditorSnapshot()).toEqual({
      stepIndex: 0,
      step: {
        type: STEP_TYPES.WORKFLOW,
        workflow: "workflows/next.ctrlyoke.yaml",
      },
    });
  });

  it("previews an edited inline workflow step as the save builds it", () => {
    selectSavedWorkflowStep({
      type: STEP_TYPES.WORKFLOW,
      name: "Lane",
      workflow: { prompt: "Inline lane", worktree: { mode: "managed" } },
    });
    useEditorStore.getState().setPromptText("Edited lane");
    useEditorStore.getState().setProperty("model", "sonnet");

    const snapshot = getExecutionPreviewEditorSnapshot();
    expect(snapshot).toMatchObject({
      stepIndex: 0,
      step: { type: STEP_TYPES.WORKFLOW, name: "Lane" },
    });
    expect((snapshot?.step as { workflow?: unknown }).workflow).toEqual({
      prompt: "Edited lane",
      model: "sonnet",
      worktree: { mode: "managed" },
    });
  });

  it("has no editor snapshot for an empty inline step", () => {
    useEditorStore.getState().setStepType(STEP_TYPES.WORKFLOW);
    useEditorStore
      .getState()
      .setSubWorkflowForm(SUB_WORKFLOW_EDITOR_FORMS.INLINE);
    expect(getExecutionPreviewEditorSnapshot()).toBeUndefined();
  });
});
