import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplatesSection } from "@components/settings/TemplatesSection";
import { useUiStore, type TemplateInfo } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import { MESSAGE_TYPES, SETTING_SCOPES } from "@/types/messages";

const postMessage = vi.fn();
const onUpdate = vi.fn();
const onReset = vi.fn();

function makeSettings(
  overrides: Partial<FullGlobalSettings> = {}
): FullGlobalSettings {
  return {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
    isMultiRoot: false,
    templateVariableDefaultsByScope: { user: {}, workspace: {} },
    ...overrides,
  };
}

function template(overrides: Partial<TemplateInfo> = {}): TemplateInfo {
  return {
    id: "sample",
    name: "Sample",
    description: "",
    isBuiltIn: true,
    variables: [{ name: "path", type: "text", default: "src" }],
    ...overrides,
  };
}

function mount(
  options: {
    scope?: "user" | "workspace";
    values?: FullGlobalSettings["templateVariableDefaultsByScope"];
    templates?: TemplateInfo[];
    workspaceRoot?: string;
  } = {}
) {
  const { globalSettings } = useSettingsStore.getState();
  useSettingsStore.setState({
    globalSettings: {
      ...globalSettings,
      workspaceRoot: options.workspaceRoot ?? "/repo",
    },
  });
  useUiStore.setState({ templateCatalog: options.templates ?? [template()] });
  const settings = makeSettings({
    templateVariableDefaultsByScope: options.values ?? {
      user: {},
      workspace: {},
    },
  });
  return render(
    <TemplatesSection
      settings={settings}
      activeScope={options.scope ?? "user"}
      onUpdate={onUpdate}
      onReset={onReset}
    />
  );
}

function writes() {
  return postMessage.mock.calls
    .map(([message]) => message)
    .filter(
      (message) => message.type === MESSAGE_TYPES.SET_TEMPLATE_VARIABLE_DEFAULTS
    );
}
function lastWrite() {
  const all = writes();
  return all[all.length - 1];
}

describe("TemplatesSection", () => {
  beforeEach(() => {
    postMessage.mockReset();
    onUpdate.mockReset();
    onReset.mockReset();
    useUiStore.getState().resetUi();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
    const { globalSettings } = useSettingsStore.getState();
    useSettingsStore.setState({
      globalSettings: { ...globalSettings, workspaceRoot: "/repo" },
    });
  });
  afterEach(() => cleanup());

  it("requests the template catalog and shows only values at the active scope", () => {
    mount({
      values: {
        user: { sample: { path: "user-path" } },
        workspace: { sample: { path: "workspace-path" } },
      },
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.TEMPLATE_CATALOG_REQUEST,
    });
    expect(screen.getByDisplayValue("user-path")).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("workspace-path")
    ).not.toBeInTheDocument();
  });

  it("clears an individual saved value and all values in one active-scope write", () => {
    const multiple = template({
      variables: [
        { name: "path", type: "text" },
        { name: "task", type: "text" },
      ],
    });
    mount({
      scope: "workspace",
      templates: [multiple],
      values: { user: {}, workspace: { sample: { path: "a", task: "b" } } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear path" }));
    expect(lastWrite()).toMatchObject({
      templateId: "sample",
      scope: SETTING_SCOPES.WORKSPACE,
      values: { path: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all sample" }));
    expect(lastWrite()).toMatchObject({
      scope: "workspace",
      values: { path: null, task: null },
    });
  });

  it("renders a harness and linked models as one row and writes the pair together", () => {
    const paired = template({
      variables: [
        { name: "runner", type: "harness" },
        { name: "model", type: "model", harness: "runner" },
      ],
    });
    mount({
      templates: [paired],
      values: {
        user: { sample: { runner: "claude-cli", model: "opus" } },
        workspace: {},
      },
    });
    const card = screen.getByTestId("template-card-sample");
    expect(within(card).getAllByText("runner")).toHaveLength(2);
    expect(within(card).getAllByText("model")).toHaveLength(2);
    const harness = within(card).getByRole("button", { name: /claude-cli/i });
    fireEvent.click(harness);
    const option = screen.getByText("Codex");
    fireEvent.click(option);
    expect(lastWrite()).toMatchObject({
      values: { runner: "codex-cli", model: expect.any(String) },
    });
  });

  it("adds a template card, excludes multiline and model variables from Add value, and saves blank as clear", () => {
    const valueTemplate = template({
      variables: [
        { name: "text", type: "text", default: "seed" },
        { name: "notes", type: "text", multiline: true },
        { name: "runner", type: "harness" },
        { name: "model", type: "model", harness: "runner" },
      ],
    });
    mount({ templates: [valueTemplate] });
    fireEvent.change(screen.getByRole("combobox", { name: "Add template" }), {
      target: { value: "sample" },
    });
    const add = screen.getByRole("combobox", { name: "Add value" });
    expect(
      within(add).getByRole("option", { name: "text" })
    ).toBeInTheDocument();
    expect(
      within(add).queryByRole("option", { name: "notes" })
    ).not.toBeInTheDocument();
    expect(
      within(add).queryByRole("option", { name: "model" })
    ).not.toBeInTheDocument();
    expect(
      within(add).getByRole("option", { name: "runner" })
    ).toBeInTheDocument();
    fireEvent.change(add, { target: { value: "text" } });
    const input = screen.getByRole("textbox", { name: "text" });
    expect(input).toHaveValue("seed");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(lastWrite()).toMatchObject({ values: { text: null } });
  });

  it("keeps an unedited added row when the next value is added", () => {
    const three = template({
      variables: [
        { name: "first", type: "text", default: "a" },
        { name: "second", type: "text", default: "b" },
        { name: "third", type: "text", default: "c" },
      ],
    });
    mount({ templates: [three] });
    fireEvent.change(screen.getByRole("combobox", { name: "Add template" }), {
      target: { value: "sample" },
    });
    const add = () => screen.getByRole("combobox", { name: "Add value" });
    fireEvent.change(add(), { target: { value: "first" } });
    fireEvent.change(add(), { target: { value: "second" } });
    const second = screen.getByRole("textbox", { name: "second" });
    fireEvent.focus(second);
    fireEvent.blur(second);
    expect(
      within(add()).queryByRole("option", { name: "second" })
    ).not.toBeInTheDocument();
    fireEvent.change(add(), { target: { value: "third" } });
    expect(writes()).toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "first" })).toHaveValue("a");
    expect(screen.getByRole("textbox", { name: "second" })).toHaveValue("b");
    expect(screen.getByRole("textbox", { name: "third" })).toHaveValue("c");
  });

  it("edits a saved value and shows refreshed settings once committed", () => {
    const { rerender } = mount({
      values: { user: { sample: { path: "lib" } }, workspace: {} },
    });
    const input = screen.getByRole("textbox", { name: "path" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "app" } });
    expect(input).toHaveValue("app");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(lastWrite()).toMatchObject({ values: { path: "app" } });

    for (const path of ["app", "hand-edited"]) {
      rerender(
        <TemplatesSection
          settings={makeSettings({
            templateVariableDefaultsByScope: {
              user: { sample: { path } },
              workspace: {},
            },
          })}
          activeScope="user"
          onUpdate={onUpdate}
          onReset={onReset}
        />
      );
    }
    expect(screen.getByRole("textbox", { name: "path" })).toHaveValue(
      "hand-edited"
    );
  });

  it("clears saved and unsaved rows with Clear all", () => {
    const two = template({
      variables: [
        { name: "path", type: "text", default: "src" },
        { name: "task", type: "text", default: "build" },
      ],
    });
    mount({
      templates: [two],
      values: { user: { sample: { path: "lib" } }, workspace: {} },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Add value" }), {
      target: { value: "task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all sample" }));
    expect(lastWrite()).toMatchObject({ values: { path: null } });
    expect(lastWrite().values).not.toHaveProperty("task");
    expect(
      screen.queryByRole("textbox", { name: "task" })
    ).not.toBeInTheDocument();
  });

  it("removes an unsaved card with Clear all without writing", () => {
    mount();
    fireEvent.change(screen.getByRole("combobox", { name: "Add template" }), {
      target: { value: "sample" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Add value" }), {
      target: { value: "path" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all sample" }));
    expect(writes()).toHaveLength(0);
    expect(
      screen.queryByTestId("template-card-sample")
    ).not.toBeInTheDocument();
  });

  it("saves the harness with a changed paired model", () => {
    const paired = template({
      variables: [
        { name: "runner", type: "harness" },
        { name: "model", type: "model", harness: "runner" },
      ],
    });
    useSettingsStore.setState({
      modelOptions: {
        ...useSettingsStore.getState().modelOptions,
        "codex-cli": [
          { value: "gpt-a", label: "GPT A" },
          { value: "gpt-b", label: "GPT B" },
        ],
      },
    });
    mount({
      templates: [paired],
      values: {
        user: { sample: { runner: "codex-cli", model: "gpt-a" } },
        workspace: {},
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^model/ }));
    fireEvent.click(screen.getByText("GPT B"));
    expect(lastWrite()).toMatchObject({
      values: { runner: "codex-cli", model: "gpt-b" },
    });
  });

  it("shows cross-scope hints, stale values and invalid dropdown entries", () => {
    const invalid = template({
      variables: [
        { name: "choice", type: "select", options: ["one", "two"] },
        { name: "runner", type: "harness" },
      ],
    });
    mount({
      templates: [invalid],
      values: {
        user: {
          sample: { choice: "bad", runner: "unknown", removed: "stale" },
        },
        workspace: { sample: { choice: "one" } },
      },
    });
    expect(
      screen.getByText(
        "Workspace also saves this; its value wins in this workspace."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("Not a known harness; the value is ignored")
    ).toBeInTheDocument();
    expect(
      screen.getByText("This value is not an option; the value is ignored")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This template no longer has this variable; the value is ignored"
      )
    ).toBeInTheDocument();
  });

  it("explains the inherited User value at Workspace scope and warns about unavailable models", () => {
    const paired = template({
      variables: [
        { name: "runner", type: "harness" },
        { name: "model", type: "model", harness: "runner" },
      ],
    });
    const { globalSettings } = useSettingsStore.getState();
    useSettingsStore.setState({
      globalSettings: { ...globalSettings, workspaceRoot: "/repo" },
      modelOptions: {
        ...useSettingsStore.getState().modelOptions,
        "claude-cli": [{ value: "sonnet", label: "Sonnet" }],
      },
    });
    mount({
      scope: "workspace",
      templates: [paired],
      values: {
        user: { sample: { runner: "claude-cli", model: "old-model" } },
        workspace: { sample: { runner: "claude-cli", model: "old-model" } },
      },
    });
    expect(
      screen.getByText("Overrides your User value: claude-cli")
    ).toBeInTheDocument();
    expect(
      screen.getByText('Model "old-model" is not available for claude-cli.')
    ).toBeInTheDocument();
  });

  it("shows missing templates as clearable cards and reports a workspace without a folder", () => {
    mount({
      scope: "workspace",
      templates: [],
      values: { user: {}, workspace: { retired: { key: "value" } } },
    });
    expect(
      screen.getByRole("heading", { level: 4, name: /retired/ })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear all retired" }));
    expect(lastWrite()).toMatchObject({
      templateId: "retired",
      values: { key: null },
    });
    cleanup();
    mount({ scope: "workspace", workspaceRoot: "", templates: [] });
    expect(
      screen.getByText("Open a workspace to edit Workspace template values.")
    ).toBeInTheDocument();
  });

  it("writes the default template to the selected scope", () => {
    mount({ scope: "workspace" });
    fireEvent.change(
      screen.getByRole("combobox", { name: /Default template/ }),
      { target: { value: "sample" } }
    );
    expect(onUpdate).toHaveBeenCalledWith("general.defaultTemplate", "sample");
  });
});
