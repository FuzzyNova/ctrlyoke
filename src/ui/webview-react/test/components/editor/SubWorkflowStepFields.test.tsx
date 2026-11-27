import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubWorkflowStepFields } from "@components/editor/SubWorkflowStepFields";
import { useEditorStore } from "@store/editorStore";
import {
  STEP_TYPES,
  SUB_WORKFLOW_EDITOR_LABELS,
} from "@root/types/DashboardConstants";

const host = vi.hoisted(() => ({ standalone: false }));

vi.mock("@hooks/useVsCodeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hooks/useVsCodeApi")>();
  return {
    ...actual,
    get isStandalone() {
      return host.standalone;
    },
  };
});

vi.mock("@utils/hostedApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/hostedApi")>();
  return {
    ...actual,
    hostedFetch: vi.fn().mockResolvedValue({ files: [], isGitRepo: false }),
  };
});

const postMessage = vi.fn();

beforeEach(() => {
  useEditorStore.getState().resetEditor();
  useEditorStore.getState().setStepType(STEP_TYPES.WORKFLOW);
  (
    window.vscodeApi as unknown as { postMessage: typeof postMessage }
  ).postMessage = postMessage;
  postMessage.mockClear();
});

afterEach(() => {
  host.standalone = false;
});

describe("SubWorkflowStepFields", () => {
  it("picks the file through the hosted modal in the browser", async () => {
    host.standalone = true;
    render(<SubWorkflowStepFields disabled={false} />);

    fireEvent.click(
      screen.getByRole("button", { name: SUB_WORKFLOW_EDITOR_LABELS.browse })
    );
    await waitFor(() =>
      expect(
        screen.getByText(SUB_WORKFLOW_EDITOR_LABELS.pickerTitle)
      ).toBeInTheDocument()
    );
    fireEvent.change(screen.getByLabelText("Or enter a path"), {
      target: { value: "workflows/verify.ctrlyoke.yaml" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: SUB_WORKFLOW_EDITOR_LABELS.pickerAction,
      })
    );

    expect(useEditorStore.getState().subWorkflowPath).toBe(
      "workflows/verify.ctrlyoke.yaml"
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("edits onFail through the script step's action options", () => {
    render(<SubWorkflowStepFields disabled={false} />);
    expect(screen.getByText(SUB_WORKFLOW_EDITOR_LABELS.onFail)).toBeVisible();
    expect(useEditorStore.getState().subWorkflowOnFail).toBe("stopWorkflow");
  });

  it("disables the fields for an externally managed workflow", () => {
    render(<SubWorkflowStepFields disabled />);
    expect(
      screen.getByRole("textbox", { name: /Workflow file/ })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: SUB_WORKFLOW_EDITOR_LABELS.browse })
    ).toBeDisabled();
  });
});
