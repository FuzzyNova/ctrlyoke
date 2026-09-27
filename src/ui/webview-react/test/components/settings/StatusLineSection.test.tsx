import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatusLineSection } from "@components/settings/StatusLineSection";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import {
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  STATUS_LINE_FIELD_IDS,
  type StatusLineSegment,
} from "@root/utils/StatuslineFormat";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

function createSettings(
  useDifferentFormatPerHarness = false,
  sharedFormat: StatusLineSegment[] = CTRLYOKE_SETTINGS_DEFAULTS.statusLine
    .sharedFormat
): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      permissions: { ...CTRLYOKE_SETTINGS_DEFAULTS.permissions },
      statusLine: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.statusLine,
        useDifferentFormatPerHarness,
        sharedFormat,
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

describe("StatusLineSection", () => {
  beforeEach(() => {
    vi.mocked(getVsCodeApi().postMessage).mockClear();
  });

  it("renders statusline controls for each tracked provider", () => {
    render(<StatusLineSection settings={createSettings()} />);

    expect(screen.getByText("Statusline Tracking")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Configure provider statusline integration to capture token, quota, and context-window metrics."
      )
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("textbox", {
        name: /^Custom statusline command, property /,
      })
    ).toHaveLength(4);
    expect(
      screen.getByRole("checkbox", {
        name: /^Enable Claude Code statusline tracking/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /^Enable Antigravity CLI statusline tracking/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /^Enable Copilot CLI statusline tracking/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /^Enable Qwen Code statusline tracking/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /^Use a different status line format per harness, property /,
      })
    ).not.toBeChecked();
    expect(
      screen.getAllByRole("region", { name: "Status line format" })
    ).toHaveLength(1);
    expect(screen.getAllByText("Live preview")).toHaveLength(4);
  });

  it("renders one editor per harness and no standalone shared editor in per-harness mode", () => {
    render(<StatusLineSection settings={createSettings(true)} />);

    expect(
      screen.getAllByRole("region", { name: "Status line format" })
    ).toHaveLength(4);
    expect(screen.queryAllByText("Live preview")).toHaveLength(4);
  });

  it("posts the coordinated mode message instead of a raw setting update", async () => {
    const user = userEvent.setup();
    render(<StatusLineSection settings={createSettings()} />);

    await user.click(
      screen.getByRole("checkbox", {
        name: /^Use a different status line format per harness, property /,
      })
    );

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.SET_STATUS_LINE_FORMAT_MODE,
      useDifferentFormatPerHarness: true,
    });
    expect(getVsCodeApi().postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING })
    );
  });

  it("updates every shared-mode preview while the shared editor is being edited", async () => {
    const user = userEvent.setup();
    render(<StatusLineSection settings={createSettings()} />);

    await user.click(
      screen.getByRole("button", { name: "Include CLI version" })
    );

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: SETTING_PATHS.STATUS_LINE_SHARED_FORMAT,
      value: [
        ...DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
        { type: "field", field: STATUS_LINE_FIELD_IDS.VERSION },
      ],
      scope: SETTING_SCOPES.USER,
    });
    expect(
      screen
        .getAllByText("Live preview")
        .map(
          (label) =>
            label.parentElement?.querySelector("code")?.textContent ?? ""
        )
    ).toEqual([
      expect.stringContaining("preview"),
      expect.stringContaining("preview"),
      expect.stringContaining("1.0.80"),
      expect.stringContaining("0.21.15"),
    ]);
  });

  it("resyncs previews when sharedFormat changes underneath the component", () => {
    const { rerender } = render(
      <StatusLineSection settings={createSettings()} />
    );
    const updatedFormat = [
      ...DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
      { type: "field" as const, field: STATUS_LINE_FIELD_IDS.VERSION },
    ];

    rerender(
      <StatusLineSection settings={createSettings(false, updatedFormat)} />
    );

    expect(
      screen
        .getAllByText("Live preview")
        .map(
          (label) =>
            label.parentElement?.querySelector("code")?.textContent ?? ""
        )
    ).toEqual([
      expect.stringContaining("preview"),
      expect.stringContaining("preview"),
      expect.stringContaining("1.0.80"),
      expect.stringContaining("0.21.15"),
    ]);
  });
});
