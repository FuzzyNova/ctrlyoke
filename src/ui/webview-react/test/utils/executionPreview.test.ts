import { afterEach, describe, expect, it } from "vitest";
import { useEditorStore } from "@store/editorStore";
import { useWorkflowStore } from "@store/workflowStore";
import {
  CONDITION_ACTIONS,
  EXECUTION_MODES,
  FINAL_STEP_PHASES,
  STEP_TYPES,
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
