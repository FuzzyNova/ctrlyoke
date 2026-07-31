import {
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
});
