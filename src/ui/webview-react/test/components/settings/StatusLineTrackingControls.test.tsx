import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatusLineTrackingControls } from "@components/settings/stats/StatusLineTrackingControls";
import { StatusLineSection } from "@components/settings/StatusLineSection";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import {
  HARNESS_IDS,
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
  STATUS_LINE_HARNESS_IDS,
} from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { StatusLineHarnessSettings } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import type { StatusLineHarnessId } from "@root/types/DashboardConstants";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  STATUS_LINE_FIELD_IDS,
} from "@root/utils/StatuslineFormat";

function makeSettings(
  harnessId: StatusLineHarnessId,
  overrides: Partial<StatusLineHarnessSettings> = {}
): FullGlobalSettings {
  const provider =
    harnessId === HARNESS_IDS.CLAUDE_CLI
      ? STATUS_LINE_HARNESS_IDS.CLAUDE
      : harnessId === HARNESS_IDS.ANTIGRAVITY_CLI
        ? STATUS_LINE_HARNESS_IDS.ANTIGRAVITY
        : harnessId === HARNESS_IDS.COPILOT_CLI
          ? STATUS_LINE_HARNESS_IDS.COPILOT
          : STATUS_LINE_HARNESS_IDS.QWEN;
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      permissions: { ...CTRLYOKE_SETTINGS_DEFAULTS.permissions },
      statusLine: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.statusLine,
        useDifferentFormatPerHarness: true,
        byHarness: {
          ...CTRLYOKE_SETTINGS_DEFAULTS.statusLine.byHarness,
          [provider]: {
            ...CTRLYOKE_SETTINGS_DEFAULTS.statusLine.byHarness[provider],
            ...overrides,
          },
        },
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

function getStatuslineToggle(harnessName: string): HTMLElement {
  return screen.getByRole("checkbox", {
    name: new RegExp(`^Enable ${harnessName} statusline tracking`),
  });
}

describe("StatusLineTrackingControls", () => {
  beforeEach(() => {
    vi.mocked(getVsCodeApi().postMessage).mockClear();
  });

  it.each([
    [
      HARNESS_IDS.CLAUDE_CLI,
      "Claude",
      "Disabling Claude statusline tracking loses token/quota data.",
    ],
    [
      HARNESS_IDS.ANTIGRAVITY_CLI,
      "Antigravity",
      "Disabling Antigravity statusline tracking loses token/quota and context-window data.",
    ],
    [
      HARNESS_IDS.COPILOT_CLI,
      "Copilot CLI",
      "Disabling Copilot statusline tracking loses token and context-window data.",
    ],
    [
      HARNESS_IDS.QWEN_CLI,
      "Qwen Code",
      "Disabling Qwen statusline tracking loses token and context-window data.",
    ],
  ] as const)(
    "shows the %s loss warning",
    (harnessId, providerName, warning) => {
      render(
        <StatusLineTrackingControls
          harnessId={harnessId}
          settings={makeSettings(harnessId)}
        />
      );

      expect(screen.getByText(warning)).toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", {
          name: new RegExp(
            `^Enable ${providerName === "Claude" ? "Claude Code" : providerName === "Antigravity" ? "Antigravity CLI" : providerName} statusline tracking`
          ),
        })
      ).toBeInTheDocument();
    }
  );

  it("writes enabling through the user-scoped global setting message", async () => {
    const user = userEvent.setup();
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        settings={makeSettings(HARNESS_IDS.CLAUDE_CLI, { enabled: false })}
      />
    );

    await user.click(getStatuslineToggle("Claude Code"));

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: SETTING_PATHS.STATUS_LINE_CLAUDE_ENABLED,
      value: true,
      scope: SETTING_SCOPES.USER,
    });
  });

  it("edits the custom command and writes the style setting only when a command exists", async () => {
    const user = userEvent.setup();
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.ANTIGRAVITY_CLI}
        settings={makeSettings(HARNESS_IDS.ANTIGRAVITY_CLI, {
          customCommand: "agy-line.js",
          useCtrlyokeStyle: false,
        })}
      />
    );

    const input = screen.getByRole("textbox", {
      name: /^Custom statusline command, property /,
    });
    expect(
      screen.getByRole("checkbox", {
        name: /^Use ctrlyoke-style statusline/,
      })
    ).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "node agy-line.js --compact");
    await user.tab();
    await user.click(
      screen.getByRole("checkbox", {
        name: /^Use ctrlyoke-style statusline/,
      })
    );

    expect(getVsCodeApi().postMessage).toHaveBeenNthCalledWith(1, {
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: SETTING_PATHS.STATUS_LINE_ANTIGRAVITY_CUSTOM_COMMAND,
      value: "node agy-line.js --compact",
      scope: SETTING_SCOPES.USER,
    });
    expect(getVsCodeApi().postMessage).toHaveBeenNthCalledWith(2, {
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: SETTING_PATHS.STATUS_LINE_ANTIGRAVITY_USE_CTRLYOKE_STYLE,
      value: true,
      scope: SETTING_SCOPES.USER,
    });
  });

  it("shows the style toggle when no custom command is configured", () => {
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        settings={makeSettings(HARNESS_IDS.CLAUDE_CLI)}
      />
    );

    expect(
      screen.getByRole("checkbox", {
        name: /^Use ctrlyoke-style statusline/,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Show ctrlyoke's branded statusline. Turn off to show your custom command's output instead — or leave the statusline blank when no custom command is set. Usage tracking keeps collecting data either way."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Status line format" })
    ).toBeInTheDocument();
  });

  it("hides the format editor when ctrlyoke-style output is disabled", () => {
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        settings={makeSettings(HARNESS_IDS.CLAUDE_CLI, {
          customCommand: "claude-line.js",
          useCtrlyokeStyle: false,
        })}
      />
    );

    expect(
      screen.queryByRole("region", { name: "Status line format" })
    ).not.toBeInTheDocument();
  });

  it.each([true, false])(
    "renders neither a format editor nor a preview when ctrlyoke style is disabled in %s mode",
    (useDifferentFormatPerHarness) => {
      const settings = makeSettings(HARNESS_IDS.CLAUDE_CLI, {
        useCtrlyokeStyle: false,
      });

      render(
        <StatusLineTrackingControls
          harnessId={HARNESS_IDS.CLAUDE_CLI}
          settings={settings}
          sharedDraft={settings.settings.statusLine.sharedFormat}
          useDifferentFormatPerHarness={useDifferentFormatPerHarness}
        />
      );

      expect(
        screen.queryByRole("region", { name: "Status line format" })
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Live preview")).not.toBeInTheDocument();
    }
  );

  it("persists an editor field edit as one whole-array user setting update", async () => {
    const user = userEvent.setup();
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        settings={makeSettings(HARNESS_IDS.CLAUDE_CLI)}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: "Include CLI version",
      })
    );

    expect(getVsCodeApi().postMessage).toHaveBeenCalledTimes(1);
    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_SETTING,
      path: SETTING_PATHS.STATUS_LINE_CLAUDE_FORMAT,
      value: [
        ...DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment })),
        { type: "field", field: STATUS_LINE_FIELD_IDS.VERSION },
      ],
      scope: SETTING_SCOPES.USER,
    });
  });

  it("opens the modal from disable, cancels without sending a message, and defaults restore on reopen", async () => {
    const user = userEvent.setup();
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        settings={makeSettings(HARNESS_IDS.CLAUDE_CLI, {
          customCommand: "/tools/ctrlyoke-old-line.js",
        })}
      />
    );

    await user.click(getStatuslineToggle("Claude Code"));
    expect(
      screen.getByRole("dialog", {
        name: "Disable Claude Code statusline tracking?",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: "Restore ctrlyoke-old-line.js as the statusline command",
      })
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getVsCodeApi().postMessage).not.toHaveBeenCalled();

    await user.click(getStatuslineToggle("Claude Code"));
    expect(
      screen.getByRole("checkbox", {
        name: "Restore ctrlyoke-old-line.js as the statusline command",
      })
    ).toBeChecked();
  });

  it("sends one disable message with restore false when the checkbox is cleared", async () => {
    const user = userEvent.setup();
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.ANTIGRAVITY_CLI}
        settings={makeSettings(HARNESS_IDS.ANTIGRAVITY_CLI, {
          customCommand: "node /tools/my-line.js --compact",
          useCtrlyokeStyle: true,
        })}
      />
    );

    await user.click(getStatuslineToggle("Antigravity CLI"));
    expect(
      screen.getByText(
        'Restore "node /tools/my-line.js --compact" as the statusline command'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The visible statusline text will change back too because ctrlyoke style is on."
      )
    ).toBeInTheDocument();

    const restore = screen.getByRole("checkbox", {
      name: 'Restore "node /tools/my-line.js --compact" as the statusline command',
    });
    await user.click(restore);
    await user.click(screen.getByRole("button", { name: "Disable tracking" }));

    expect(getVsCodeApi().postMessage).toHaveBeenCalledTimes(1);
    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
      harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
      restoreCustomCommand: false,
    });
  });

  it("sends restore false without a checkbox when no custom command exists", async () => {
    const user = userEvent.setup();
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        settings={makeSettings(HARNESS_IDS.CLAUDE_CLI)}
      />
    );

    await user.click(getStatuslineToggle("Claude Code"));
    expect(
      screen.queryByText(/Restore .*statusline command/)
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disable tracking" }));

    expect(getVsCodeApi().postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
      harnessId: HARNESS_IDS.CLAUDE_CLI,
      restoreCustomCommand: false,
    });
  });

  it("uses a tooltip for a truncated command label", async () => {
    const user = userEvent.setup();
    const command = `node /tools/my-line.js --profile ${"x".repeat(80)}`;
    render(
      <StatusLineTrackingControls
        harnessId={HARNESS_IDS.CLAUDE_CLI}
        settings={makeSettings(HARNESS_IDS.CLAUDE_CLI, {
          customCommand: command,
        })}
      />
    );

    await user.click(getStatuslineToggle("Claude Code"));
    expect(screen.getByTitle(command)).toBeInTheDocument();
    expect(
      screen.getByText(/Restore "node \/tools\/my-line\.js/)
    ).toBeInTheDocument();
  });

  it("renders controls for every statusline harness in the status line section", () => {
    const settings = makeSettings(HARNESS_IDS.CLAUDE_CLI);
    render(<StatusLineSection settings={settings} />);

    expect(
      screen.getAllByRole("textbox", {
        name: /^Custom statusline command, property /,
      })
    ).toHaveLength(4);
  });
});
