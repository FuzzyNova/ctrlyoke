import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateModal } from "@components/workflow/TemplateModal";
import { SaveWorkflowDialog } from "@components/workflow/SaveWorkflowDialog";
import { useUiStore } from "@store/uiStore";
import { MESSAGE_TYPES, WORKFLOW_FILE_FORMATS } from "@/types/messages";

const postMessage = vi.fn();

describe("template saving", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
  });

  afterEach(cleanup);

  it("clones the selected base template and defaults new templates to YAML", () => {
    const base = {
      id: "simple-feature",
      name: "Simple Feature",
      description: "A base template",
      variables: [],
      isBuiltIn: true,
    };
    useUiStore.setState({
      templates: [base],
      defaultTemplateId: base.id,
      currentTemplate: base,
    });

    render(<TemplateModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New template..." }));

    expect(screen.getByText(/Starts from Simple Feature/)).toBeInTheDocument();
    const formatGroup = screen.getByRole("group", { name: "Template format" });
    expect(
      within(formatGroup).getByRole("button", { name: "YAML" })
    ).toHaveClass("fp-mode-switch-btn-active");

    fireEvent.change(screen.getByLabelText("Template Name"), {
      target: { value: "feature-copy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Template" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CREATE_CUSTOM_TEMPLATE,
      name: "feature-copy",
      scope: "workspace",
      format: WORKFLOW_FILE_FORMATS.YAML,
      baseTemplateId: "simple-feature",
    });
  });

  it("renders the New template form pre-expanded when requested", () => {
    const base = {
      id: "simple-feature",
      name: "Simple Feature",
      description: "A base template",
      variables: [],
      isBuiltIn: true,
    };
    useUiStore.setState({
      templates: [base],
      defaultTemplateId: base.id,
      currentTemplate: base,
      openCreateTemplateForm: true,
    });

    render(<TemplateModal isOpen onClose={vi.fn()} />);

    expect(screen.getByLabelText("Template Name")).toBeInTheDocument();
    expect(screen.getByText(/Starts from Simple Feature/)).toBeInTheDocument();
  });

  it("shows a template collision as an inline name error", () => {
    const base = {
      id: "simple-feature",
      name: "Simple Feature",
      description: "A base template",
      variables: [],
      isBuiltIn: true,
    };
    useUiStore.setState({
      templates: [base],
      defaultTemplateId: base.id,
      currentTemplate: base,
      openCreateTemplateForm: true,
    });

    render(<TemplateModal isOpen onClose={vi.fn()} />);

    act(() => {
      useUiStore.getState().setCustomTemplateCreated({
        templates: [base],
        error: "Template already exists: feature-copy",
      });
    });

    expect(
      screen.getByText("Template already exists: feature-copy")
    ).toBeInTheDocument();
  });

  it("sends the selected template format when saving a workflow snapshot", () => {
    useUiStore.getState().openSaveWorkflowDialog({
      requestId: "save-1",
      address: {
        workflowKey: "workflow-a" as never,
        kind: "draft",
      },
      title: "Save workflow",
      defaultPath: "workflow.ctrlyoke.yaml",
      defaultFormat: WORKFLOW_FILE_FORMATS.YAML,
    });

    render(<SaveWorkflowDialog />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /^Save as Template/ })
    );
    fireEvent.change(screen.getByLabelText("Template Name"), {
      target: { value: "snapshot" },
    });
    const formatGroup = screen.getByRole("group", { name: "Template format" });
    fireEvent.click(within(formatGroup).getByRole("button", { name: "JSON" }));

    expect(screen.getByText(/snapshot\.ctrlyoke\.json/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SAVE_WORKFLOW_AS_TEMPLATE,
      requestId: "save-1",
      address: {
        workflowKey: "workflow-a",
        kind: "draft",
      },
      name: "snapshot",
      scope: "workspace",
      format: WORKFLOW_FILE_FORMATS.JSON,
    });
  });

  it("shows the bundle plan and disables Save for pending or blocked previews", () => {
    const address = {
      workflowKey: "workflow-a" as never,
      kind: "draft" as const,
    };
    useUiStore.getState().openSaveWorkflowDialog({
      requestId: "save-preview",
      address,
      title: "Save workflow",
      defaultPath: "/workspace/fix-tests.ctrlyoke.yaml",
      defaultFormat: WORKFLOW_FILE_FORMATS.YAML,
    });

    render(<SaveWorkflowDialog />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    act(() => {
      useUiStore.setState({
        savePathCheck: {
          requestId: "save-preview:path:1",
          path: "/workspace/fix-tests.ctrlyoke.yaml",
          address,
          exists: false,
          checking: false,
          bundlePreview: {
            copyCount: 3,
            inlineCount: 2,
            pruneCount: 2,
            assetsDirectoryName: "fix-tests.assets",
            warnings: [{ code: "warning", message: "A portability warning" }],
            blockers: [],
            planFingerprint: "fingerprint-1",
          },
        },
      });
    });

    expect(
      screen.getByText(/3 attachments will be copied to/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 prompt files will be inlined/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 managed assets will be removed/)
    ).toBeInTheDocument();
    expect(screen.getByText(/A portability warning/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    act(() => {
      useUiStore.setState({
        savePathCheck: {
          ...useUiStore.getState().savePathCheck!,
          bundlePreview: {
            ...useUiStore.getState().savePathCheck!.bundlePreview!,
            blockers: [{ code: "blocked", message: "Missing attachment" }],
          },
        },
      });
    });
    expect(screen.getByText(/Missing attachment/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
