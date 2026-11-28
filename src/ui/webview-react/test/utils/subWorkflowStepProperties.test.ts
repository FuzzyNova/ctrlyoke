import { beforeEach, describe, expect, it } from "vitest";
import {
  CONDITION_ACTIONS,
  STEP_TYPES,
  SUB_WORKFLOW_EDITOR_FORMS,
} from "@root/types/DashboardConstants";
import type { InlineSubWorkflowDefinition } from "@root/types/CtrlYokeTypes";
import {
  getSubWorkflowStepPropertyUpdate,
  getSubWorkflowStepUpdateFromEditor,
} from "@utils/subWorkflowStepProperties";
import { useEditorStore } from "@store/editorStore";

const DEFAULTS = {
  workflow: "workflows/verify.ctrlyoke.yaml",
  onFail: CONDITION_ACTIONS.STOP_WORKFLOW,
  color: undefined,
  enabled: true,
  promptName: "",
} as const;

describe("getSubWorkflowStepPropertyUpdate", () => {
  it("sends only the kind and clears every field at its default", () => {
    expect(getSubWorkflowStepPropertyUpdate(DEFAULTS)).toEqual({
      text: "workflows/verify.ctrlyoke.yaml",
      properties: { type: STEP_TYPES.WORKFLOW },
      clearProperties: ["onFail", "color", "enabled", "name"],
    });
  });

  it("sends the fields the editor overrides", () => {
    expect(
      getSubWorkflowStepPropertyUpdate({
        workflow: "workflows/verify.ctrlyoke.yaml",
        onFail: CONDITION_ACTIONS.CONTINUE,
        color: "#6b8e23",
        enabled: false,
        promptName: "Verify",
      })
    ).toEqual({
      text: "workflows/verify.ctrlyoke.yaml",
      properties: {
        type: STEP_TYPES.WORKFLOW,
        onFail: CONDITION_ACTIONS.CONTINUE,
        color: "#6b8e23",
        enabled: false,
      },
      clearProperties: [],
    });
  });

  it("keeps an authored onFail placeholder as written", () => {
    const { properties, clearProperties } = getSubWorkflowStepPropertyUpdate({
      ...DEFAULTS,
      onFail: "{{onFail}}",
    });
    expect(properties.onFail).toBe("{{onFail}}");
    expect(clearProperties).not.toContain("onFail");
  });

  it("sends an inline definition whole, with its step text as the text", () => {
    const inline = {
      type: STEP_TYPES.SCRIPT,
      script: "npm test",
      worktree: { mode: "managed" },
    } as InlineSubWorkflowDefinition;
    expect(
      getSubWorkflowStepPropertyUpdate({ ...DEFAULTS, workflow: inline })
    ).toEqual({
      text: "npm test",
      properties: { type: STEP_TYPES.WORKFLOW, workflow: inline },
      clearProperties: ["onFail", "color", "enabled", "name"],
    });
  });
});

/**
 * Load → save through the editor: every field an authored inline definition
 * holds comes back as written, so the editor's own save never drops one.
 */
describe("inline definitions round-trip through the editor", () => {
  beforeEach(() => {
    useEditorStore.getState().resetEditor();
  });

  const saveAfterLoading = (workflow: InlineSubWorkflowDefinition) => {
    useEditorStore.getState().enterEditMode(0, {
      type: STEP_TYPES.WORKFLOW,
      name: "Lane",
      color: "#123456",
      enabled: false,
      onFail: CONDITION_ACTIONS.CONTINUE,
      workflow,
    });
    return getSubWorkflowStepUpdateFromEditor(useEditorStore.getState());
  };

  it("keeps every prompt field, the worktree and the wrapped display fields", () => {
    const workflow = {
      type: STEP_TYPES.PROMPT,
      prompt: "Implement the lane",
      name: "Inner",
      enabled: false,
      color: "#abcdef",
      harness: "claude-cli",
      model: "sonnet",
      executionMode: "headless",
      agent: "lane-agent",
      skills: ["commit"],
      secrets: ["DEPLOY_TOKEN"],
      sessionId: "seeded-session-id",
      mcpServers: ["ctrlyoke"],
      hooks: [{ event: "stop", command: "echo done" }],
      errorBehavior: { onError: "retry", maxRetries: 2 },
      endCondition: { script: "npm test", maxRetries: 1 },
      preCondition: { script: "git diff --quiet" },
      priorContext: { workflow: "planner", run: 3 },
      priorContextDetail: "summary",
      additionalArgs: "--effort high",
      toolPermissions: { mode: "custom", allowedTools: ["Bash"] },
      sandbox: true,
      sandboxMode: "read-only",
      worktree: { mode: "named", branch: "lane/docs", setup: "npm ci" },
    } as InlineSubWorkflowDefinition;

    const update = saveAfterLoading(workflow);

    expect(update.properties).toEqual({
      type: STEP_TYPES.WORKFLOW,
      workflow,
      onFail: CONDITION_ACTIONS.CONTINUE,
      color: "#123456",
      enabled: false,
    });
    expect(update.text).toBe("Implement the lane");
  });

  it("keeps every script field and the worktree", () => {
    const workflow = {
      type: STEP_TYPES.SCRIPT,
      script: "npm test",
      env: { CI: "1" },
      secrets: ["DEPLOY_TOKEN"],
      errorBehavior: { onError: "continue" },
      timeoutSec: 45,
      onPass: "stopWorkflow",
      onFail: "continue",
      compareSource: "stdout",
      operator: "contains",
      expected: "OK",
      ignoreCase: true,
      executionMode: "headless",
      shell: "bash",
      worktree: false,
    } as InlineSubWorkflowDefinition;

    expect(saveAfterLoading(workflow).properties.workflow).toEqual(workflow);
  });

  it("saves the File form's path after switching back from Inline", () => {
    useEditorStore.getState().enterEditMode(0, {
      type: STEP_TYPES.WORKFLOW,
      workflow: "workflows/verify.ctrlyoke.yaml",
    });
    const store = useEditorStore.getState();
    store.setSubWorkflowForm(SUB_WORKFLOW_EDITOR_FORMS.INLINE);
    store.setPromptText("Implement the lane");
    expect(
      getSubWorkflowStepUpdateFromEditor(useEditorStore.getState()).properties
        .workflow
    ).toEqual({ prompt: "Implement the lane" });

    store.setSubWorkflowForm(SUB_WORKFLOW_EDITOR_FORMS.FILE);
    const update = getSubWorkflowStepUpdateFromEditor(
      useEditorStore.getState()
    );
    expect(update.text).toBe("workflows/verify.ctrlyoke.yaml");
    expect(update.properties.workflow).toBeUndefined();
  });
});
