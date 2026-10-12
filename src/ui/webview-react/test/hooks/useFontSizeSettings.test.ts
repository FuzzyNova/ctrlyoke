import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@store/settingsStore";
import { useFontSizeControls } from "@hooks/useFontSizeControls";
import { useFontSizeSync } from "@hooks/useFontSizeSync";
import { EDITOR_FONT_SIZE_CSS_VAR } from "@utils/codemirrorTheme";
import {
  EDITOR_FONT_SIZE_VSCODE,
  MESSAGE_TYPES,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("@hooks/useVsCodeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hooks/useVsCodeApi")>()),
  getVsCodeApi: () => ({ postMessage }),
}));

const updateFontSize = vi.hoisted(() => vi.fn());
vi.mock("../../terminalRegistry", () => ({
  terminalRegistry: { updateFontSize },
}));

function patchGlobalSettings(
  patch: Partial<ReturnType<typeof useSettingsStore.getState>["globalSettings"]>
) {
  const { globalSettings, setGlobalSettings } = useSettingsStore.getState();
  setGlobalSettings({ ...globalSettings, ...patch });
}

beforeEach(() => {
  postMessage.mockClear();
  updateFontSize.mockClear();
});

afterEach(() => {
  document.documentElement.style.removeProperty("--cy-output-font-size");
  document.documentElement.style.removeProperty(EDITOR_FONT_SIZE_CSS_VAR);
});

describe("useFontSizeControls", () => {
  it("writes the output setting and steps from the patched value", () => {
    patchGlobalSettings({ outputFontSize: 13, settingSources: {} });
    const { result } = renderHook(() => useFontSizeControls());

    act(() => result.current.setOutputFontSize(14));
    act(() =>
      result.current.setOutputFontSize(result.current.outputFontSize + 1)
    );

    expect(useSettingsStore.getState().globalSettings.outputFontSize).toBe(15);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: "ui.outputFontSize",
      value: 15,
      scope: SETTING_SCOPES.USER,
    });
  });

  it("clamps to the output bounds", () => {
    patchGlobalSettings({ outputFontSize: 24 });
    const { result } = renderHook(() => useFontSizeControls());

    act(() => result.current.setOutputFontSize(30));

    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "ui.outputFontSize", value: 24 })
    );
  });

  it("keeps a workspace-owned terminal size in the workspace", () => {
    const { globalSettings } = useSettingsStore.getState();
    patchGlobalSettings({
      terminal: { ...globalSettings.terminal!, fontSize: 14 },
      settingSources: { "terminal.fontSize": SETTING_SCOPES.WORKSPACE },
    });
    const { result } = renderHook(() => useFontSizeControls());

    act(() => result.current.setTerminalFontSize(15));

    expect(useSettingsStore.getState().globalSettings.terminal?.fontSize).toBe(
      15
    );
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: "terminal.fontSize",
      value: 15,
      scope: SETTING_SCOPES.WORKSPACE,
    });
  });
});

describe("useFontSizeSync", () => {
  it("applies the output, editor and terminal sizes", () => {
    const { globalSettings } = useSettingsStore.getState();
    patchGlobalSettings({
      outputFontSize: 16,
      editorFontSize: 18,
      terminal: { ...globalSettings.terminal!, fontSize: 12 },
    });
    renderHook(() => useFontSizeSync());

    const root = document.documentElement.style;
    expect(root.getPropertyValue("--cy-output-font-size")).toBe("16px");
    expect(root.getPropertyValue(EDITOR_FONT_SIZE_CSS_VAR)).toBe("18px");
    expect(updateFontSize).toHaveBeenLastCalledWith(12);
  });

  it("removes the editor override when following VS Code", () => {
    patchGlobalSettings({ editorFontSize: 18 });
    renderHook(() => useFontSizeSync());

    act(() => patchGlobalSettings({ editorFontSize: EDITOR_FONT_SIZE_VSCODE }));

    expect(
      document.documentElement.style.getPropertyValue(EDITOR_FONT_SIZE_CSS_VAR)
    ).toBe("");
  });
});
