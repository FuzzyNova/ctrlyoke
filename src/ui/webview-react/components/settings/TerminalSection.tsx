import { useEffect, useMemo, useState } from "react";
import { LocalTextInput } from "../shared/LocalInputs";
import {
  CUSTOM_SHELL_OPTION,
  UI_PLATFORMS,
  type TerminalCursorStyle,
  type TerminalMobileControlBar,
} from "@root/types/DashboardConstants";
import { detectPlatform } from "@utils/platform";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { CustomSelect } from "../shared/CustomSelect";
import { NumberField, SettingInputRow, SettingToggleRow } from "../shared";
import { clamp } from "@utils/number";
import { TerminalControlBarEditor } from "./TerminalControlBarEditor";
import { Icon } from "../shared/Icon";
import {
  TERMINAL_CURSOR_STYLE_OPTIONS_META,
  TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

const WINDOWS_SHELL_OPTIONS = [
  { value: "", label: "Auto-detect" },
  { value: "pwsh.exe", label: "PowerShell 7 (pwsh)" },
  { value: "powershell.exe", label: "Windows PowerShell" },
  {
    value: "C:\\Program Files\\Git\\bin\\bash.exe",
    label: "Git Bash",
  },
  { value: "C:\\Windows\\System32\\wsl.exe", label: "WSL" },
  {
    value: CUSTOM_SHELL_OPTION,
    label: "Custom path...",
    pseudo: { writes: 'terminal.shellExecutable: "<custom path>"' },
  },
];

function FontStepper({
  value,
  onChange,
  path,
  sources,
  onReset,
  activeScope,
}: {
  value: number;
  onChange: (value: number) => void;
  path?: string;
  sources?: Record<string, SettingSource>;
  onReset?: (path: string) => void;
  activeScope?: SettingWriteScope;
}) {
  const min = 8;
  const max = 24;
  const setSize = (next: number) => onChange(clamp(next, min, max));

  return (
    <SettingInputRow
      label="Font size"
      path={path}
      sources={sources}
      onReset={onReset}
      activeScope={activeScope}
    >
      <div className="flex items-center">
        <button
          className="icon-btn py-0 px-1"
          title="Decrease terminal font size"
          aria-label="Decrease terminal font size"
          onClick={() => setSize(value - 1)}
          disabled={value <= min}
          type="button"
        >
          <Icon name="remove" className="codicon-sm" />
        </button>
        <span className="text-xs text-description-fg tabular-nums w-[28px] text-center select-none">
          {value}
        </span>
        <button
          className="icon-btn py-0 px-1"
          title="Increase terminal font size"
          aria-label="Increase terminal font size"
          onClick={() => setSize(value + 1)}
          disabled={value >= max}
          type="button"
        >
          <Icon name="add" className="codicon-sm" />
        </button>
      </div>
    </SettingInputRow>
  );
}

export function TerminalSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const terminal = settings.settings.terminal;
  const sources = settings.sources as Record<string, SettingSource>;
  const platform = useMemo(() => detectPlatform(), []);
  const knownWindowsShell = WINDOWS_SHELL_OPTIONS.some(
    (option) => option.value === terminal.shellExecutable
  );
  const [showCustomShell, setShowCustomShell] = useState(
    Boolean(terminal.shellExecutable && !knownWindowsShell)
  );

  useEffect(() => {
    setShowCustomShell(Boolean(terminal.shellExecutable && !knownWindowsShell));
  }, [knownWindowsShell, terminal.shellExecutable]);

  const shellWarning = terminal.shellExecutable
    .split(/[/\\]/)
    .pop()
    ?.toLowerCase();

  const rowProps = { sources, onReset, activeScope };

  return (
    <div className="space-y-5">
      <section className="space-y-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Terminal Appearance
        </h3>

        <FontStepper
          value={terminal.fontSize}
          onChange={(v) => onUpdate("terminal.fontSize", v)}
          path="terminal.fontSize"
          {...rowProps}
        />

        <NumberField
          id="terminal-line-height"
          label="Line height"
          value={terminal.lineHeight}
          min={1}
          max={2}
          step={0.1}
          onChange={(v) => onUpdate("terminal.lineHeight", v)}
          path="terminal.lineHeight"
          {...rowProps}
        />

        <NumberField
          id="terminal-scrollback"
          label="Scrollback lines"
          value={terminal.scrollback}
          min={1000}
          max={50000}
          step={1000}
          onChange={(v) => onUpdate("terminal.scrollback", v)}
          note="Higher values use more memory. Changes apply to new sessions."
          path="terminal.scrollback"
          {...rowProps}
        />

        <SettingInputRow
          label="Cursor style"
          id="terminal-cursor-style"
          path="terminal.cursorStyle"
          {...rowProps}
        >
          <CustomSelect
            id="terminal-cursor-style"
            value={terminal.cursorStyle}
            onChange={(v) =>
              onUpdate("terminal.cursorStyle", v as TerminalCursorStyle)
            }
            schemaPath="terminal.cursorStyle"
            options={toSelectOptions(
              TERMINAL_CURSOR_STYLE_OPTIONS_META,
              "terminal.cursorStyle"
            )}
          />
        </SettingInputRow>

        <SettingToggleRow
          label="Cursor blink"
          description="Blink the terminal cursor."
          checked={terminal.cursorBlink}
          onChange={(v) => onUpdate("terminal.cursorBlink", v)}
          path="terminal.cursorBlink"
          {...rowProps}
        />
      </section>

      <section className="space-y-4 pt-3 border-t border-panel-border">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Terminal Behavior
        </h3>

        <SettingToggleRow
          label="macOS: Option key as Meta"
          description="Treat Option as Meta for Emacs and Vim alt-key shortcuts."
          checked={terminal.macOptionIsMeta}
          onChange={(v) => onUpdate("terminal.macOptionIsMeta", v)}
          path="terminal.macOptionIsMeta"
          {...rowProps}
        />

        <SettingInputRow
          label="Double-click word separators"
          id="terminal-word-separators"
          path="terminal.wordSeparators"
          {...rowProps}
        >
          <LocalTextInput
            id="terminal-word-separators"
            value={terminal.wordSeparators}
            placeholder={" ()[]{}',\"`"}
            onCommit={(v) => onUpdate("terminal.wordSeparators", v)}
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </SettingInputRow>

        <NumberField
          id="terminal-replay-buffer"
          label="Replay buffer size (KB)"
          value={terminal.replayBufferKb}
          min={10}
          max={500}
          step={10}
          onChange={(v) => onUpdate("terminal.replayBufferKb", v)}
          path="terminal.replayBufferKb"
          {...rowProps}
        />
      </section>

      <section className="space-y-4 pt-3 border-t border-panel-border">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Shell
        </h3>

        {platform === UI_PLATFORMS.WINDOWS ? (
          <>
            <SettingInputRow
              label="Shell executable"
              id="terminal-shell"
              path="terminal.shellExecutable"
              {...rowProps}
            >
              <CustomSelect
                id="terminal-shell"
                value={
                  showCustomShell
                    ? CUSTOM_SHELL_OPTION
                    : terminal.shellExecutable
                }
                onChange={(v) => {
                  if (v === CUSTOM_SHELL_OPTION) {
                    setShowCustomShell(true);
                    return;
                  }
                  setShowCustomShell(false);
                  onUpdate("terminal.shellExecutable", v);
                }}
                schemaPath="terminal.shellExecutable"
                options={WINDOWS_SHELL_OPTIONS}
              />
            </SettingInputRow>

            {showCustomShell && (
              <SettingInputRow
                label="Custom shell path"
                path="terminal.shellExecutable"
                {...rowProps}
              >
                <LocalTextInput
                  value={terminal.shellExecutable}
                  placeholder="C:\\Program Files\\PowerShell\\7\\pwsh.exe"
                  onCommit={(v) => onUpdate("terminal.shellExecutable", v)}
                  className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                />
              </SettingInputRow>
            )}

            {shellWarning === "cmd.exe" && (
              <p className="text-xs text-warning-fg">
                cmd.exe is not recommended for interactive terminal sessions.
                Use PowerShell, Git Bash, or WSL.
              </p>
            )}

            <p className="text-xs text-description-fg">
              AI harness sessions always run natively on Windows regardless of
              this setting.
            </p>
          </>
        ) : (
          <>
            <SettingInputRow
              label="Shell executable override"
              id="terminal-shell"
              path="terminal.shellExecutable"
              {...rowProps}
            >
              <LocalTextInput
                id="terminal-shell"
                value={terminal.shellExecutable}
                placeholder={
                  platform === UI_PLATFORMS.MAC
                    ? "Auto-detected from $SHELL, then /bin/zsh"
                    : "Auto-detected from $SHELL, then /bin/bash"
                }
                onCommit={(v) => onUpdate("terminal.shellExecutable", v)}
                className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
              />
            </SettingInputRow>

            <p className="text-xs text-description-fg">
              Use this only when VS Code was launched without inheriting your
              login shell environment.
            </p>

            {platform === UI_PLATFORMS.MAC &&
              terminal.shellExecutable === "/bin/bash" && (
                <p className="text-xs text-warning-fg">
                  The system bash on macOS may fail with Permission denied under
                  SIP. Use Homebrew bash (/usr/local/bin/bash) instead.
                </p>
              )}
          </>
        )}
      </section>

      <section className="space-y-4 pt-3 border-t border-panel-border">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Mobile Control Bar
        </h3>

        <SettingInputRow
          label="Mobile control bar"
          id="terminal-mobile-control-bar"
          path="terminal.mobileControlBar"
          {...rowProps}
        >
          <CustomSelect
            id="terminal-mobile-control-bar"
            value={terminal.mobileControlBar}
            onChange={(v) =>
              onUpdate(
                "terminal.mobileControlBar",
                v as TerminalMobileControlBar
              )
            }
            schemaPath="terminal.mobileControlBar"
            options={toSelectOptions(
              TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META,
              "terminal.mobileControlBar"
            )}
          />
          <p className="text-xs text-description-fg mt-1">
            Auto shows the bar for touch browsers connected to the ctrlyoke
            server.
          </p>
        </SettingInputRow>

        <TerminalControlBarEditor
          settings={settings}
          activeScope={activeScope}
          onUpdate={onUpdate}
          onReset={onReset}
        />
      </section>
    </div>
  );
}
