import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUB_WORKFLOW_EDITOR_CONTROL_IDS,
  SubWorkflowStepFields,
} from "@components/editor/SubWorkflowStepFields";
import { useEditorStore } from "@store/editorStore";
import { hostedFetch } from "@utils/hostedApi";
import { createMessageHandlers } from "@/messaging/inboundMessageRouter";
import {
  EDITOR_TARGET_KINDS,
  MESSAGE_TYPES,
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

/** Answer a pick as the extension does (`SUB_WORKFLOW_STEP_FILE_SELECTED`). */
function replyWithReference(path: string, targetKey: string | undefined) {
  createMessageHandlers(false)[MESSAGE_TYPES.SUB_WORKFLOW_STEP_FILE_SELECTED]({
    path,
    targetKey,
  } as never);
}

describe("SubWorkflowStepFields", () => {
  // The schema round-trip suite's content-control guard relies on this test:
  // a source scan sees the id constants, only a render sees them on controls.
  it("renders the file field and Browse button under their registered ids", () => {
    render(<SubWorkflowStepFields disabled={false} />);

    const file = document.getElementById(SUB_WORKFLOW_EDITOR_CONTROL_IDS.file);
    expect(file).toBe(screen.getByRole("textbox", { name: /Workflow file/ }));
    const browse = document.getElementById(
      SUB_WORKFLOW_EDITOR_CONTROL_IDS.browse
    );
    expect(browse).toBe(
      screen.getByRole("button", { name: SUB_WORKFLOW_EDITOR_LABELS.browse })
    );
  });

  it("sends a hosted modal list pick to the extension and stores the reference it returns", async () => {
    host.standalone = true;
    vi.mocked(hostedFetch).mockResolvedValueOnce({
      files: [
        {
          path: "/home/me/repo/workflows/verify.ctrlyoke.yaml",
          relativePath: "workflows/verify.ctrlyoke.yaml",
        },
      ],
      isGitRepo: false,
    });
    render(<SubWorkflowStepFields disabled={false} />);

    fireEvent.click(
      screen.getByRole("button", { name: SUB_WORKFLOW_EDITOR_LABELS.browse })
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "workflows/verify.ctrlyoke.yaml",
      })
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: SUB_WORKFLOW_EDITOR_LABELS.pickerAction,
      })
    );

    // The modal's absolute path goes to the backend, never into the step.
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.NORMALIZE_SUB_WORKFLOW_STEP_FILE,
      filePath: "/home/me/repo/workflows/verify.ctrlyoke.yaml",
      targetKey: EDITOR_TARGET_KINDS.NEW_PROMPT,
    });
    expect(useEditorStore.getState().subWorkflowPath).toBe("");

    replyWithReference(
      "workflows/verify.ctrlyoke.yaml",
      EDITOR_TARGET_KINDS.NEW_PROMPT
    );
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: /Workflow file/ })
      ).toHaveValue("workflows/verify.ctrlyoke.yaml")
    );
  });

  it("asks the native picker for the target being edited", () => {
    useEditorStore.getState().enterEditMode(2, {
      type: STEP_TYPES.WORKFLOW,
      workflow: "workflows/old.ctrlyoke.yaml",
    });
    render(<SubWorkflowStepFields disabled={false} />);

    fireEvent.click(
      screen.getByRole("button", { name: SUB_WORKFLOW_EDITOR_LABELS.browse })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SELECT_SUB_WORKFLOW_STEP_FILE,
      targetKey: "queue:2",
    });
  });

  it("spells a typed path with forward slashes", () => {
    render(<SubWorkflowStepFields disabled={false} />);

    fireEvent.change(screen.getByRole("textbox", { name: /Workflow file/ }), {
      target: { value: "workflows\\nested\\verify.ctrlyoke.yaml" },
    });

    expect(useEditorStore.getState().subWorkflowPath).toBe(
      "workflows/nested/verify.ctrlyoke.yaml"
    );
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
