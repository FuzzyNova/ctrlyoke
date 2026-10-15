import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateModal } from "@components/workflow/TemplateModal";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore, type TemplateInfo } from "@store/uiStore";
import {
  SETTING_SCOPES,
  TEMPLATE_VARIABLE_DEFAULT_SOURCES,
} from "@root/types/DashboardConstants";
import { MESSAGE_TYPES } from "@/types/messages";
import { createMessageHandlers } from "@hooks/useMessageHandler";

const postMessage = vi.fn();

function template(variables: TemplateInfo["variables"]): TemplateInfo {
  return {
    id: "example",
    name: "Example",
    description: "",
    isBuiltIn: true,
    variables,
  };
}

function openModal(
  value: TemplateInfo,
  workspaceRoot: string | null = "/repo"
) {
  useUiStore.setState({
    templates: [value],
    defaultTemplateId: value.id,
    defaultTemplateSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.TEMPLATE,
    defaultTemplateConfirmedId: value.id,
    currentTemplate: value,
  });
  const { globalSettings } = useSettingsStore.getState();
  useSettingsStore.setState({
    globalSettings: { ...globalSettings, workspaceRoot: workspaceRoot ?? "" },
  });
  render(<TemplateModal isOpen onClose={vi.fn()} />);
}

function scopeButton(scope: "User" | "Workspace"): HTMLElement {
  return within(
    screen.getByRole("group", { name: "Save defaults to" })
  ).getByRole("button", { name: scope });
}

function setSavedReply(
  value: TemplateInfo,
  scope: "user" | "workspace",
  variableNames: string[]
) {
  act(() => {
    useUiStore.setState({
      templates: [value],
      currentTemplate: value,
      templateVariableDefaultsSaved: {
        templateId: value.id,
        variableNames,
        scope,
      },
      lastSavedTemplateScope: scope,
    });
  });
}

describe("TemplateModal variable defaults", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    useSettingsStore.getState().resetSettings();
    postMessage.mockReset();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
  });

  afterEach(cleanup);

  it("shows pin only when a value differs and saves to the selected scope", () => {
    openModal(
      template([
        { name: "path", type: "text", default: "authored" },
        { name: "notes", type: "text", multiline: true, default: "lines" },
      ])
    );
    expect(scopeButton("Workspace")).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: "Save as default" })
    ).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "path" }), {
      target: { value: "custom" },
    });
    expect(
      screen.getAllByRole("button", { name: "Save as default" })
    ).toHaveLength(1);
    fireEvent.click(scopeButton("User"));
    expect(useUiStore.getState().lastSavedTemplateScope).toBe("workspace");
    fireEvent.click(
      within(
        screen.getByRole("textbox", { name: "path" }).closest(".form-group")!
      ).getByRole("button", {
        name: "Save as default",
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS,
        templateId: "example",
        scope: SETTING_SCOPES.USER,
        values: { path: "custom" },
      })
    );
    setSavedReply(
      template([
        {
          name: "path",
          type: "text",
          default: "custom",
          defaultSource: "user",
        },
      ]),
      "user",
      ["path"]
    );
    expect(scopeButton("User")).toHaveAttribute("aria-pressed", "true");
  });

  it("starts on Workspace and pins the control to User without a workspace", () => {
    openModal(
      template([{ name: "path", type: "text", default: "authored" }]),
      null
    );
    expect(scopeButton("User")).toHaveAttribute("aria-pressed", "true");
    expect(scopeButton("Workspace")).toBeDisabled();
  });

  it("shows the saved scope and clears from the scope that supplied the value", () => {
    openModal(
      template([
        {
          name: "path",
          type: "text",
          default: "workspace-value",
          defaultSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE,
        },
      ])
    );
    expect(screen.getByText("Saved (Workspace)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear saved value" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS,
        scope: SETTING_SCOPES.WORKSPACE,
        values: { path: null },
      })
    );
  });

  it("falls back to the User value after clearing a Workspace value", () => {
    openModal(
      template([
        {
          name: "path",
          type: "text",
          default: "workspace-value",
          defaultSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE,
        },
      ])
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear saved value" }));
    setSavedReply(
      template([
        {
          name: "path",
          type: "text",
          default: "user-value",
          defaultSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER,
        },
      ]),
      "workspace",
      ["path"]
    );
    expect(screen.getByRole("textbox", { name: "path" })).toHaveValue(
      "user-value"
    );
    expect(screen.getByText("Saved (User)")).toBeInTheDocument();
  });

  it("re-seeds only saved fields when the template list is returned", async () => {
    const initial = template([
      { name: "saved", type: "text", default: "before" },
      { name: "typed", type: "text", default: "initial" },
    ]);
    openModal(initial);
    fireEvent.change(screen.getByRole("textbox", { name: "saved" }), {
      target: { value: "pinned" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "typed" }), {
      target: { value: "keep me" },
    });
    fireEvent.click(
      within(
        screen.getByRole("textbox", { name: "saved" }).closest(".form-group")!
      ).getByRole("button", {
        name: "Save as default",
      })
    );
    setSavedReply(
      template([
        {
          name: "saved",
          type: "text",
          default: "pinned",
          defaultSource: "workspace",
        },
        { name: "typed", type: "text", default: "initial" },
      ]),
      "workspace",
      ["saved"]
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "saved" })).toHaveValue(
        "pinned"
      );
      expect(screen.getByRole("textbox", { name: "typed" })).toHaveValue(
        "keep me"
      );
    });
  });

  it("sends Set as Default to the toggle scope and labels the acknowledged source", () => {
    openModal(template([{ name: "path", type: "text", default: "authored" }]));
    act(() => useUiStore.setState({ defaultTemplateId: "other" }));
    fireEvent.click(scopeButton("User"));
    const setDefault = screen.getByRole("button", { name: "Set as Default" });
    // It sits on the Template label row, not in the footer beside Create.
    expect(
      document
        .querySelector('label[for="template-select"]')
        ?.parentElement?.contains(setDefault)
    ).toBe(true);
    fireEvent.click(setDefault);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.SET_DEFAULT_TEMPLATE,
        templateId: "example",
        scope: SETTING_SCOPES.USER,
      })
    );
    act(() => {
      useUiStore.setState({
        defaultTemplateSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.USER,
        defaultTemplateConfirmedId: "example",
        lastSavedTemplateScope: SETTING_SCOPES.USER,
      });
    });
    expect(screen.getByText("Default template (User)")).toBeInTheDocument();
    expect(scopeButton("User")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows one pin for a harness/model pair and saves both values together", () => {
    openModal(
      template([
        { name: "harness", type: "harness", default: "claude-cli" },
        { name: "model", type: "model", harness: "harness", default: "opus" },
      ])
    );
    useSettingsStore.getState().setModelOptions({
      "claude-cli": [
        { value: "opus", label: "Opus" },
        { value: "sonnet", label: "Sonnet" },
      ],
    });
    fireEvent.click(document.getElementById("var-model")!);
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Sonnet"));
    expect(
      screen.getAllByRole("button", { name: "Save as default" })
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Save as default" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS,
        values: { harness: "claude-cli", model: "sonnet" },
      })
    );
  });

  it("shows one marker and one clear action for a saved harness/model pair", () => {
    openModal(
      template([
        {
          name: "harness",
          type: "harness",
          default: "claude-cli",
          defaultSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE,
        },
        {
          name: "model",
          type: "model",
          harness: "harness",
          default: "opus",
          defaultSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE,
        },
      ])
    );
    expect(screen.getAllByText("Saved (Workspace)")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Clear saved value" })
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear saved value" }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS,
        scope: SETTING_SCOPES.WORKSPACE,
        values: { harness: null, model: null },
      })
    );
  });

  it("keeps the saved model when a refreshed pair is re-seeded", async () => {
    const initial = template([
      { name: "harness", type: "harness", default: "claude-cli" },
      { name: "model", type: "model", harness: "harness", default: "opus" },
    ]);
    openModal(initial);
    useSettingsStore.getState().setModelOptions({
      "claude-cli": [{ value: "opus", label: "Opus" }],
      "codex-cli": [
        { value: "gpt-6-sol", label: "GPT 6 Sol" },
        { value: "gpt-6-luna", label: "GPT 6 Luna" },
      ],
    });
    fireEvent.click(document.getElementById("var-harness")!);
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("button", {
        name: /vars\.harness: codex-cli$/,
      })
    );
    await waitFor(() =>
      expect(document.getElementById("var-model")).toHaveTextContent(
        "GPT 6 Sol"
      )
    );
    fireEvent.click(document.getElementById("var-model")!);
    fireEvent.click(
      within(screen.getByRole("listbox")).getByText("GPT 6 Luna")
    );
    fireEvent.click(screen.getByRole("button", { name: "Save as default" }));
    setSavedReply(
      template([
        {
          name: "harness",
          type: "harness",
          default: "codex-cli",
          defaultSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE,
        },
        {
          name: "model",
          type: "model",
          harness: "harness",
          default: "gpt-6-luna",
          defaultSource: TEMPLATE_VARIABLE_DEFAULT_SOURCES.WORKSPACE,
        },
      ]),
      "workspace",
      ["harness", "model"]
    );
    await waitFor(() =>
      expect(document.getElementById("var-model")).toHaveTextContent(
        "GPT 6 Luna"
      )
    );
  });

  it("renders a schema default label without adding a scope", () => {
    openModal(template([{ name: "path", type: "text", default: "authored" }]));
    expect(screen.getByText("Default template")).toBeInTheDocument();
    expect(
      screen.queryByText(/Default template \((User|Workspace)\)/)
    ).toBeNull();
  });

  it("keeps both create actions disabled until required values are filled", () => {
    openModal(template([{ name: "feature", type: "text", required: true }]));
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow Name" }), {
      target: { value: "new-workflow" },
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create & Run" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "feature" }), {
      target: { value: "  Build a feature  " },
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create & Run" })).toBeEnabled();
  });

  it("posts only one create request when Create & Run is double-clicked", () => {
    openModal(template([]));
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow Name" }), {
      target: { value: "new-workflow" },
    });
    const button = screen.getByRole("button", { name: "Create & Run" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(
      postMessage.mock.calls.filter(
        ([message]) => message.type === MESSAGE_TYPES.CREATE_WORKFLOW
      )
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Creating…" })).toHaveLength(
      2
    );
  });

  it("ignores repeated Ctrl+Enter and allows retry after an error reply", () => {
    openModal(template([]));
    const name = screen.getByRole("textbox", { name: "Workflow Name" });
    fireEvent.change(name, { target: { value: "new-workflow" } });
    fireEvent.keyDown(name, { key: "Enter", ctrlKey: true, repeat: false });
    fireEvent.keyDown(name, { key: "Enter", ctrlKey: true, repeat: true });
    expect(
      postMessage.mock.calls.filter(
        ([message]) => message.type === MESSAGE_TYPES.CREATE_WORKFLOW
      )
    ).toHaveLength(1);

    act(() => {
      createMessageHandlers()[MESSAGE_TYPES.WORKFLOW_CREATED]({
        error: "failed",
      });
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(
      postMessage.mock.calls.filter(
        ([message]) => message.type === MESSAGE_TYPES.CREATE_WORKFLOW
      )
    ).toHaveLength(2);
  });

  it("marks required fields and satisfies a required default immediately", () => {
    openModal(
      template([
        { name: "feature", type: "text", required: true, default: "Build it" },
      ])
    );
    expect(screen.getByRole("textbox", { name: "feature" })).toHaveAttribute(
      "aria-required",
      "true"
    );
    expect(screen.getByText("*")).toHaveAttribute("aria-hidden", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow Name" }), {
      target: { value: "new-workflow" },
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create & Run" })).toBeEnabled();
  });

  it("shows required errors on blur and clears them when a value is entered", () => {
    openModal(template([{ name: "feature", type: "text", required: true }]));
    const field = screen.getByRole("textbox", { name: "feature" });
    fireEvent.blur(field);
    expect(screen.getByText("This field is required")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "Build it" } });
    expect(screen.queryByText("This field is required")).toBeNull();
  });

  it("does not block creation for optional fields", () => {
    openModal(template([{ name: "notes", type: "text" }]));
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow Name" }), {
      target: { value: "new-workflow" },
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create & Run" })).toBeEnabled();
  });

  it("clears required errors when switching templates", () => {
    const requiredTemplate = template([
      { name: "feature", type: "text", required: true },
    ]);
    const optionalTemplate = {
      ...template([{ name: "notes", type: "text" }]),
      id: "optional",
    };
    openModal(requiredTemplate);
    act(() => {
      useUiStore.setState({ templates: [requiredTemplate, optionalTemplate] });
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "feature" }));
    expect(screen.getByText("This field is required")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "optional" },
    });
    expect(screen.queryByText("This field is required")).toBeNull();
  });
});
