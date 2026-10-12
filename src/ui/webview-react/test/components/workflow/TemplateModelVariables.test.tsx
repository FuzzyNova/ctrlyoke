import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateModal } from "@components/workflow/TemplateModal";
import { useUiStore, type TemplateInfo } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { MESSAGE_TYPES } from "@/types/messages";

const postMessage = vi.fn();

function openWithTemplate(template: TemplateInfo): void {
  useUiStore.setState({
    templates: [template],
    defaultTemplateId: template.id,
    currentTemplate: template,
  });
  render(<TemplateModal isOpen onClose={vi.fn()} />);
}

function modelTrigger(name: string): HTMLElement {
  return document.getElementById(`var-${name}`)!;
}

describe("template model variables", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    useSettingsStore.getState().resetSettings();
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
    useSettingsStore.getState().setModelOptions({
      "claude-cli": [
        { value: "opus", label: "Opus" },
        { value: "sonnet", label: "Sonnet" },
      ],
      "codex-cli": [
        { value: "gpt-6-luna", label: "GPT 6 Luna" },
        { value: "gpt-6-sol", label: "GPT 6 Sol" },
      ],
    });
    const { globalSettings } = useSettingsStore.getState();
    useSettingsStore.setState({
      globalSettings: {
        ...globalSettings,
        harnessDefaultModels: {
          "claude-cli": "sonnet",
          "codex-cli": "gpt-6-sol",
        },
      },
    });
  });

  afterEach(cleanup);

  it("lists the paired harness's models and resets the model when the harness changes", () => {
    openWithTemplate({
      id: "loop",
      name: "Loop",
      description: "",
      isBuiltIn: true,
      variables: [
        { name: "fixerHarness", type: "harness", default: "claude-cli" },
        {
          name: "fixerModel",
          type: "model",
          harness: "fixerHarness",
          default: "opus",
        },
      ],
    });

    expect(modelTrigger("fixerModel")).toHaveTextContent("Opus");

    fireEvent.click(document.getElementById("var-fixerHarness")!);
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("button", {
        name: /vars\.fixerHarness: codex-cli$/,
      })
    );
    expect(modelTrigger("fixerModel")).toHaveTextContent("GPT 6 Sol");

    fireEvent.click(modelTrigger("fixerModel"));
    fireEvent.click(
      within(screen.getByRole("listbox")).getByText("GPT 6 Luna")
    );

    fireEvent.change(screen.getByLabelText("Workflow Name"), {
      target: { value: "bugs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.CREATE_WORKFLOW,
        variables: { fixerHarness: "codex-cli", fixerModel: "gpt-6-luna" },
      })
    );
  });

  it("starts a model with no default on its harness's default model", () => {
    openWithTemplate({
      id: "loop",
      name: "Loop",
      description: "",
      isBuiltIn: true,
      variables: [
        { name: "harness", type: "harness" },
        { name: "model", type: "model", harness: "harness" },
      ],
    });

    expect(modelTrigger("model")).toHaveTextContent("Sonnet");
  });

  it("renders an unpaired model variable as a text input", () => {
    openWithTemplate({
      id: "loop",
      name: "Loop",
      description: "",
      isBuiltIn: true,
      variables: [{ name: "model", type: "model", default: "opus" }],
    });

    expect(screen.getByRole("textbox", { name: "model" })).toHaveValue("opus");
  });

  it("renders a plain text variable input at full width", () => {
    openWithTemplate({
      id: "text-input",
      name: "Text input",
      description: "",
      isBuiltIn: true,
      variables: [
        {
          name: "planDocument",
          type: "text",
          default: ".ctrlyoke/plans/plan.md",
        },
      ],
    });

    expect(screen.getByRole("textbox", { name: "planDocument" })).toHaveClass(
      "w-full"
    );
  });
});
