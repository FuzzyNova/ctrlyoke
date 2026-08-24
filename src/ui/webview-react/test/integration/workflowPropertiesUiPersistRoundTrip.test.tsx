/**
 * UI-driven persist/reload round trip for WorkflowPropertiesPanel-authored
 * workflow-level properties.
 *
 * Same rationale as promptStepUiPersistRoundTrip.test.tsx: the mocha
 * `*.integration.test.ts` suites hand-build `UPDATE_WORKFLOW_PROPERTY`
 * payloads and never render WorkflowPropertiesPanel, so a bug in how the
 * panel constructs that payload — or in how `setWorkflowProperties` (the
 * function the app calls when a workflow reloads) repopulates the panel's
 * controls — would pass them unnoticed.
 *
 * `vars` is deliberately included: its editor was recently relocated from the
 * Harness tab to the Context tab, which is exactly the kind of change that
 * tends to introduce this class of bug.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { WorkflowPropertiesPanel } from "@components/layout/WorkflowPropertiesPanel";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import {
  MESSAGE_TYPES,
  PERMISSION_MODES,
} from "@root/types/DashboardConstants";

const postMessage = vi.fn();

function resetStores(): void {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useUiStore.setState({ settingsCollapsed: false });
  useSecretRegistryStore.getState().resetSecretRegistry();
}

/** Last matching message — a field can post more than once as the user types. */
function findUpdatePropertyMessage(
  property: string
): Record<string, unknown> | undefined {
  const matches = postMessage.mock.calls.filter(
    ([msg]) =>
      (msg as { type?: string; property?: string }).type ===
        MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY &&
      (msg as { property?: string }).property === property
  );
  return matches[matches.length - 1]?.[0] as
    | Record<string, unknown>
    | undefined;
}

describe("WorkflowPropertiesPanel — workflow-property persist/reload round trip", () => {
  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  it("Variables (vars) survive a save -> reload cycle", () => {
    render(<WorkflowPropertiesPanel />);

    fireEvent.click(screen.getByTitle("Context"));
    const varsField = screen.getByLabelText("Variables");
    fireEvent.change(varsField, {
      target: { value: "region=us-east-1\nstage=prod" },
    });
    fireEvent.blur(varsField);

    const message = findUpdatePropertyMessage("vars");
    expect(message?.value).toEqual({ region: "us-east-1", stage: "prod" });

    // Simulate the workflow file being saved and reloaded — the real path a
    // WORKFLOW_STATE_UPDATE message drives via setWorkflowProperties.
    act(() =>
      useSettingsStore.getState().setWorkflowProperties({
        ...useSettingsStore.getState().workflowProperties,
        vars: message?.value as Record<string, string>,
      })
    );

    fireEvent.click(screen.getByTitle("Context"));
    expect(screen.getByLabelText("Variables")).toHaveValue(
      "region=us-east-1\nstage=prod"
    );
  });

  it("custom tool-permission lists survive a save -> reload cycle", () => {
    useSettingsStore.getState().updateWorkflowProperty("toolPermissions", {
      mode: PERMISSION_MODES.CUSTOM,
    });

    render(<WorkflowPropertiesPanel />);
    fireEvent.click(screen.getByTitle("Permissions"));

    fireEvent.change(screen.getByLabelText("Allowed Tools"), {
      target: { value: "shell(git:*)\nread" },
    });
    fireEvent.change(screen.getByLabelText("Denied Tools"), {
      target: { value: "shell(rm:*)" },
    });

    const message = findUpdatePropertyMessage("toolPermissions");
    expect(message?.value).toEqual({
      mode: PERMISSION_MODES.CUSTOM,
      allowedTools: ["shell(git:*)", "read"],
      deniedTools: ["shell(rm:*)"],
    });

    act(() =>
      useSettingsStore.getState().setWorkflowProperties({
        ...useSettingsStore.getState().workflowProperties,
        toolPermissions: message?.value as ReturnType<
          typeof useSettingsStore.getState
        >["workflowProperties"]["toolPermissions"],
      })
    );

    fireEvent.click(screen.getByTitle("Permissions"));
    expect(screen.getByLabelText("Allowed Tools")).toHaveValue(
      "shell(git:*)\nread"
    );
    expect(screen.getByLabelText("Denied Tools")).toHaveValue("shell(rm:*)");
  });
});
