/**
 * UI-driven persist/reload round trip for PropertiesDrawer-authored prompt-step
 * overrides.
 *
 * `src/test/integration/*.integration.test.ts` proves the *backend* persists a
 * hand-built `UPDATE_PROMPT` payload faithfully, but never renders React — a
 * payload the UI never actually constructs, or a value the UI never reads back
 * from a reloaded step, passes those suites without ever being reachable by a
 * user. This suite closes that gap for the two nested-object surfaces
 * (`preCondition.env`, `toolPermissions` allow/deny lists) most likely to hide
 * a frontend construction/read-back bug of the kind fixed in PromptEditor's
 * script-step payload and editorStore's script-step read-back.
 *
 * Flow: seed the editor with an override, drive the *real* env/tool-list
 * controls, click Update, capture the exact `UPDATE_PROMPT` message the
 * component posts, feed its `properties` back into `enterEditMode` (the same
 * function the app calls when a user reopens a saved step), and assert the
 * re-rendered controls show what was saved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@components/shared/HarnessIcon", () => ({
  HarnessIcon: () => null,
}));

vi.mock("../../hooks/useCompatibilityDiagnostics", () => ({
  useCompatibilityDiagnostics: () => ({
    isChecking: false,
    diagnostics: [],
  }),
}));

import { PromptEditor } from "@components/editor/PromptEditor";
import { useEditorStore } from "@store/editorStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import {
  MESSAGE_TYPES,
  FINAL_STEP_PHASES,
  EXECUTION_STATES,
  CONDITION_ACTIONS,
} from "@/types/messages";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";

const postMessageSpy = vi.fn();

beforeEach(() => {
  useEditorStore.getState().resetEditor();
  useWorkflowStore.setState({
    steps: [{ prompt: "do the thing" }],
    currentStep: 0,
    executionState: EXECUTION_STATES.IDLE,
  });
  useSecretRegistryStore.getState().resetSecretRegistry();
  useUiStore.setState({ propertiesDrawerOpen: false });
  (
    window.vscodeApi as unknown as { postMessage: typeof postMessageSpy }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

function findUpdatePromptMessage(): Record<string, unknown> | undefined {
  return postMessageSpy.mock.calls.find(
    ([msg]) => (msg as { type?: string }).type === MESSAGE_TYPES.UPDATE_PROMPT
  )?.[0] as Record<string, unknown> | undefined;
}

describe("PropertiesDrawer — prompt-step persist/reload round trip", () => {
  it("preCondition env and tool-permission lists survive a save -> reload cycle", async () => {
    useEditorStore.setState({
      selectionTarget: { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      promptText: "do the thing",
      properties: {
        ...useEditorStore.getState().properties,
        preCondition: {
          script: "git diff --quiet",
          onFail: CONDITION_ACTIONS.SKIP_PROMPT,
        },
        toolPermissions: { mode: PERMISSION_MODES.CUSTOM },
      },
    });

    render(<PromptEditor />);
    act(() => useUiStore.getState().openPropertiesDrawer());

    // Drive the real Validation-tab env control.
    fireEvent.click(screen.getByTitle("Validation"));
    const preEnv = screen.getByLabelText("prop-pre-env");
    fireEvent.change(preEnv, {
      target: { value: "PRE_TOKEN=${secret:PRE_TOKEN}" },
    });
    fireEvent.blur(preEnv);

    // Drive the real Permissions-tab allow/deny-list controls.
    fireEvent.click(screen.getByTitle("Permissions"));
    fireEvent.change(screen.getByLabelText("Allowed Tools"), {
      target: { value: "Bash\nRead" },
    });
    fireEvent.change(screen.getByLabelText("Denied Tools"), {
      target: { value: "Write" },
    });

    fireEvent.click(
      document.querySelector(".btn-editor-update") as HTMLButtonElement
    );

    const message = findUpdatePromptMessage();
    const properties = message?.properties as Record<string, unknown>;
    expect(properties.preCondition).toMatchObject({
      script: "git diff --quiet",
      env: { PRE_TOKEN: "${secret:PRE_TOKEN}" },
    });
    expect(properties.toolPermissions).toEqual({
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: ["Bash", "Read"],
      deniedTools: ["Write"],
    });

    // Simulate the step being saved to disk and the editor reopening it —
    // exactly what enterEditMode does when a user clicks a saved step.
    act(() =>
      useEditorStore.getState().enterEditMode(0, {
        prompt: "do the thing",
        preCondition: properties.preCondition as never,
        toolPermissions: properties.toolPermissions as never,
      })
    );

    expect(useEditorStore.getState().properties.preCondition).toMatchObject({
      script: "git diff --quiet",
      env: { PRE_TOKEN: "${secret:PRE_TOKEN}" },
    });

    // enterEditMode resets the drawer back to the Harness tab, mirroring what
    // happens when a user reopens a step in the real app.
    fireEvent.click(screen.getByTitle("Validation"));
    expect(screen.getByLabelText("prop-pre-env")).toHaveValue(
      "PRE_TOKEN=${secret:PRE_TOKEN}"
    );

    fireEvent.click(screen.getByTitle("Permissions"));
    expect(screen.getByLabelText("Allowed Tools")).toHaveValue("Bash\nRead");
    expect(screen.getByLabelText("Denied Tools")).toHaveValue("Write");
  });
});
