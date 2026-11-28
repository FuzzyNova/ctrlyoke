import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUB_WORKFLOW_EDITOR_CONTROL_IDS,
  SubWorkflowFormBar,
  SubWorkflowStepFields,
} from "@components/editor/SubWorkflowStepFields";
import { useEditorStore } from "@store/editorStore";
import { useWorkflowStore } from "@store/workflowStore";
import { hostedFetch } from "@utils/hostedApi";
import { createMessageHandlers } from "@/messaging/inboundMessageRouter";
import {
  EDITOR_TARGET_KINDS,
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  STEP_TYPES,
  SUB_WORKFLOW_EDITOR_FORMS,
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
  useWorkflowStore.getState().resetWorkflow();
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

/** Replace a CodeMirror field's text and commit it with a blur. */
function setCodeMirrorField(label: string, value: string): void {
  const field = screen.getByLabelText(label);
  const view = EditorView.findFromDOM(field);
  if (!view) throw new Error(`${label} CodeMirror view was not rendered`);
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  });
  fireEvent.blur(field);
}

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

  it("renders the form switches and the inline worktree under their registered ids", () => {
    render(
      <>
        <SubWorkflowFormBar disabled={false} />
        <SubWorkflowStepFields disabled={false} />
      </>
    );
    const fileForm = document.getElementById(
      SUB_WORKFLOW_EDITOR_CONTROL_IDS.formFile
    );
    expect(fileForm).toBe(
      screen.getByRole("button", { name: SUB_WORKFLOW_EDITOR_LABELS.formFile })
    );
    expect(fileForm).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(
      screen.getByRole("button", {
        name: SUB_WORKFLOW_EDITOR_LABELS.formInline,
      })
    );
    expect(
      document.getElementById(SUB_WORKFLOW_EDITOR_CONTROL_IDS.formInline)
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      document.getElementById(SUB_WORKFLOW_EDITOR_CONTROL_IDS.inlinePrompt)
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      document.getElementById(SUB_WORKFLOW_EDITOR_CONTROL_IDS.inlineScript)
    ).toBe(screen.getByRole("button", { name: "Script" }));
    // The shared worktree editor, under this form's prefix.
    expect(
      document.getElementById(
        `${SUB_WORKFLOW_EDITOR_CONTROL_IDS.worktree}-worktree-mode`
      )
    ).not.toBeNull();
    expect(
      document.getElementById(SUB_WORKFLOW_EDITOR_CONTROL_IDS.file)
    ).toBeNull();
    expect(
      document.getElementById(SUB_WORKFLOW_EDITOR_CONTROL_IDS.onFail)
    ).not.toBeNull();
  });

  it("switches the inline step's kind and keeps its worktree", () => {
    useEditorStore
      .getState()
      .setSubWorkflowForm(SUB_WORKFLOW_EDITOR_FORMS.INLINE);
    useEditorStore.getState().setSubWorkflowWorktree({ mode: "managed" });
    render(<SubWorkflowFormBar disabled={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Script" }));
    expect(useEditorStore.getState().subWorkflowInline).toMatchObject({
      kind: STEP_TYPES.SCRIPT,
      worktree: { mode: "managed" },
    });
  });

  it("edits a managed inline worktree through the shared editor", () => {
    useEditorStore
      .getState()
      .setSubWorkflowForm(SUB_WORKFLOW_EDITOR_FORMS.INLINE);
    useEditorStore.getState().setSubWorkflowWorktree({ mode: "managed" });
    render(<SubWorkflowStepFields disabled={false} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Merge" }));
    expect(useEditorStore.getState().subWorkflowInline?.worktree).toEqual({
      mode: "managed",
      merge: true,
      keep: false,
    });
  });

  // A stored `base: ""` fails the schema's `minLength: 1`, so the file no
  // longer validates; blank optional fields are omitted instead.
  it("never stores an empty base or setup on an inline managed worktree", () => {
    useEditorStore
      .getState()
      .setSubWorkflowForm(SUB_WORKFLOW_EDITOR_FORMS.INLINE);
    render(<SubWorkflowStepFields disabled={false} />);
    const worktree = () =>
      useEditorStore.getState().subWorkflowInline?.worktree;

    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`^${SUB_WORKFLOW_EDITOR_LABELS.worktree}`),
      })
    );
    fireEvent.click(screen.getByRole("button", { name: /^Managed/ }));
    expect(worktree()).toEqual({ mode: "managed", merge: false, keep: false });

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep directory" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge" }));
    const toggled = { mode: "managed", merge: true, keep: true };
    expect(worktree()).toEqual(toggled);

    setCodeMirrorField("Worktree base", "main");
    expect(worktree()).toEqual({ ...toggled, base: "main" });
    setCodeMirrorField("Worktree base", "");
    expect(worktree()).toEqual(toggled);
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

  it("lands a pick on the step it was asked for after a reorder moves it", () => {
    const step = (name: string) => ({
      type: STEP_TYPES.WORKFLOW,
      workflow: `workflows/${name}.ctrlyoke.yaml`,
      _runtime: { stepId: `id-${name}` },
    });
    const [a, b, c] = [step("a"), step("b"), step("c")];
    useWorkflowStore.getState().setPrompts([a, b, c] as never);
    useEditorStore.getState().enterEditMode(2, c as never);
    render(<SubWorkflowStepFields disabled={false} />);

    fireEvent.click(
      screen.getByRole("button", { name: SUB_WORKFLOW_EDITOR_LABELS.browse })
    );
    const request = postMessage.mock.calls
      .map(([message]) => message as { type: string; targetKey: string })
      .find(
        (message) =>
          message.type === MESSAGE_TYPES.SELECT_SUB_WORKFLOW_STEP_FILE
      );
    if (!request) throw new Error("No picker request was posted");
    expect(request.targetKey).toBe("step:id-c");

    // Step c moves to the front while the picker is open; the editor follows
    // it, and step b now sits where c was.
    act(() => {
      createMessageHandlers(false)[MESSAGE_TYPES.REORDER_PROMPTS_CONFIRMED]({
        steps: [c, a, b],
      } as never);
    });
    expect(useEditorStore.getState().selectionTarget).toEqual({
      kind: FINAL_STEP_PHASES.QUEUE,
      index: 0,
    });

    act(() => replyWithReference("workflows/picked.ctrlyoke.yaml", "queue:2"));
    expect(useEditorStore.getState().subWorkflowPath).toBe(
      "workflows/c.ctrlyoke.yaml"
    );
    act(() =>
      replyWithReference("workflows/picked.ctrlyoke.yaml", request.targetKey)
    );
    expect(useEditorStore.getState().subWorkflowPath).toBe(
      "workflows/picked.ctrlyoke.yaml"
    );
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
