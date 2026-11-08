/**
 * The step-level picker shortcut, end to end through a real footer quick
 * picker: Alt+Shift+M opens the popup, the list inside takes focus on the
 * current value, and Enter applies the highlighted model and hands focus back.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ModelQuickPicker } from "@components/editor/ModelQuickPicker";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import {
  FOOTER_PICKERS,
  HARNESS_IDS,
  INHERIT_DEFAULT_OPTION,
  PICKER_SHORTCUT_TARGETS,
} from "@root/types/DashboardConstants";

describe("ModelQuickPicker — Alt+Shift+M", () => {
  beforeEach(() => {
    useEditorStore.getState().resetEditor();
    useSettingsStore.getState().resetSettings();
    useUiStore.getState().resetUi();
    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.CLAUDE_CLI);
    useSettingsStore.getState().setModelOptions({
      [HARNESS_IDS.CLAUDE_CLI]: [
        { value: "sonnet", label: "Sonnet" },
        { value: "opus", label: "Opus" },
      ],
    });
  });

  it("opens, focuses the list on Inherit, and commits the next model", async () => {
    render(
      <>
        <textarea aria-label="Prompt editor" />
        <ModelQuickPicker isNarrow={false} showLabel={true} />
      </>
    );
    const editor = screen.getByRole("textbox", { name: "Prompt editor" });
    editor.focus();

    act(() => {
      useUiStore
        .getState()
        .requestPickerShortcut(PICKER_SHORTCUT_TARGETS.STEP_MODEL, {
          mobile: false,
        });
    });

    expect(useUiStore.getState().footerOpenPicker).toBe(FOOTER_PICKERS.MODEL);
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());
    expect(
      document
        .querySelector(".cy-dropdown-row-active")
        ?.getAttribute("data-listbox-value")
    ).toBe(INHERIT_DEFAULT_OPTION);

    // A repeat press advances the highlight, as ArrowDown would.
    act(() => {
      useUiStore
        .getState()
        .requestPickerShortcut(PICKER_SHORTCUT_TARGETS.STEP_MODEL, {
          mobile: false,
        });
    });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(useEditorStore.getState().properties.model).toBe("opus");
    expect(useUiStore.getState().footerOpenPicker).toBeNull();
    expect(editor).toHaveFocus();
  });

  it("starts a model the harness hides in the hidden section until unhidden", async () => {
    useUiStore.setState({
      hiddenDropdownOptions: {},
      shownDropdownOptions: {},
    });
    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.CODEX_CLI);
    useSettingsStore.getState().setModelOptions({
      [HARNESS_IDS.CODEX_CLI]: [
        { value: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
        { value: "gpt-reserve", label: "GPT-Reserve", hidden: true },
      ],
    });
    render(<ModelQuickPicker isNarrow={false} showLabel={true} />);

    act(() => {
      useUiStore
        .getState()
        .requestPickerShortcut(PICKER_SHORTCUT_TARGETS.STEP_MODEL, {
          mobile: false,
        });
    });
    await screen.findByRole("listbox");
    const row = (value: string) =>
      document.querySelector(`[data-listbox-value="${value}"]`);
    expect(row("gpt-6.1-sol")).not.toBeNull();
    expect(row("gpt-reserve")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Show hidden/i })
    ).toBeInTheDocument();

    act(() => {
      useUiStore
        .getState()
        .unhideDropdownOption("model:codex-cli", "gpt-reserve");
    });
    await waitFor(() => expect(row("gpt-reserve")).not.toBeNull());
  });

  it("closes the popup on Escape without changing the model", async () => {
    render(<ModelQuickPicker isNarrow={false} showLabel={true} />);

    act(() => {
      useUiStore
        .getState()
        .requestPickerShortcut(PICKER_SHORTCUT_TARGETS.STEP_MODEL, {
          mobile: false,
        });
    });
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());
    fireEvent.keyDown(listbox, { key: "Escape" });

    expect(useUiStore.getState().footerOpenPicker).toBeNull();
    expect(useEditorStore.getState().properties.model).toBeUndefined();
  });
});
