import { useEffect, useMemo, useState } from "react";
import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  type TerminalCursorStyle,
  type TerminalMobileControlBar,
} from "@root/types/DashboardConstants";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import type { TerminalShortcut } from "@root/types/FlightPathSettings";
import { CustomSelect } from "../shared/CustomSelect";

interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

const CURSOR_STYLE_OPTIONS = [
  { value: TERMINAL_CURSOR_STYLES.BLOCK, label: "Block" },
  { value: TERMINAL_CURSOR_STYLES.UNDERLINE, label: "Underline" },
  { value: TERMINAL_CURSOR_STYLES.BAR, label: "Bar" },
];

const CONTROL_BAR_OPTIONS = [
  { value: TERMINAL_MOBILE_CONTROL_BAR.AUTO, label: "Auto" },
  { value: TERMINAL_MOBILE_CONTROL_BAR.ALWAYS, label: "Always show" },
  { value: TERMINAL_MOBILE_CONTROL_BAR.NEVER, label: "Never show" },
];

const WINDOWS_SHELL_OPTIONS = [
  { value: "", label: "Auto-detect" },
  { value: "pwsh.exe", label: "PowerShell 7 (pwsh)" },
  { value: "powershell.exe", label: "Windows PowerShell" },
  {
    value: "C:\\Program Files\\Git\\bin\\bash.exe",
    label: "Git Bash",
  },
  { value: "C:\\Windows\\System32\\wsl.exe", label: "WSL" },
  { value: "__custom__", label: "Custom path..." },
];

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-focus-border cursor-pointer shrink-0"
      />
      <span className="flex flex-col">
        <span className="text-sm text-foreground group-hover:text-foreground">
          {label}
        </span>
        {description && (
          <span className="text-xs text-description-fg mt-0.5">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

function detectPlatform(): "windows" | "mac" | "linux" {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || userAgent.includes("windows")) {
    return "windows";
  }
  if (platform.includes("mac")) {
    return "mac";
  }
  return "linux";
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  note,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  note?: string;
}) {
  const isInvalid = value < min || value > max;
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-description-fg mb-1">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) {
            onChange(next);
          }
        }}
        onBlur={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) {
            onChange(clampNumber(next, min, max));
          }
        }}
        className={`w-full bg-input-bg border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border ${
          isInvalid ? "border-input-error-border" : "border-input-border"
        }`}
      />
      {isInvalid && (
        <p className="text-xs text-error-fg mt-1">
          Enter a value from {min} to {max}.
        </p>
      )}
      {note && <p className="text-xs text-description-fg mt-1">{note}</p>}
    </div>
  );
}

function FontStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const min = 8;
  const max = 24;
  const setSize = (next: number) => onChange(clampNumber(next, min, max));

  return (
    <div>
      <span className="block text-xs text-description-fg mb-1">Font size</span>
      <div className="flex items-center">
        <button
          className="icon-btn py-0 px-1"
          title="Decrease terminal font size"
          aria-label="Decrease terminal font size"
          onClick={() => setSize(value - 1)}
          disabled={value <= min}
          type="button"
        >
          <i className="codicon codicon-sm codicon-remove" />
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
          <i className="codicon codicon-sm codicon-add" />
        </button>
      </div>
    </div>
  );
}

function updateShortcut(
  shortcuts: TerminalShortcut[],
  index: number,
  patch: Partial<TerminalShortcut>
): TerminalShortcut[] {
  return shortcuts.map((shortcut, shortcutIndex) =>
    shortcutIndex === index ? { ...shortcut, ...patch } : shortcut
  );
}

export function TerminalSection({ settings, onUpdate }: Props) {
  const terminal = settings.settings.terminal;
  const s = "user" as const;
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

  return (
    <div className="space-y-5">
      <section className="space-y-4">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Terminal Appearance
        </h3>

        <FontStepper
          value={terminal.fontSize}
          onChange={(v) => onUpdate("terminal.fontSize", v, s)}
        />

        <NumberField
          id="terminal-line-height"
          label="Line height"
          value={terminal.lineHeight}
          min={1}
          max={2}
          step={0.1}
          onChange={(v) => onUpdate("terminal.lineHeight", v, s)}
        />

        <NumberField
          id="terminal-scrollback"
          label="Scrollback lines"
          value={terminal.scrollback}
          min={1000}
          max={50000}
          step={1000}
          onChange={(v) => onUpdate("terminal.scrollback", v, s)}
          note="Higher values use more memory. Changes apply to new sessions."
        />

        <div>
          <label
            htmlFor="terminal-cursor-style"
            className="block text-xs text-description-fg mb-1"
          >
            Cursor style
          </label>
          <CustomSelect
            id="terminal-cursor-style"
            value={terminal.cursorStyle}
            onChange={(v) =>
              onUpdate("terminal.cursorStyle", v as TerminalCursorStyle, s)
            }
            options={CURSOR_STYLE_OPTIONS}
          />
        </div>

        <ToggleRow
          label="Cursor blink"
          description="Blink the terminal cursor."
          checked={terminal.cursorBlink}
          onChange={(v) => onUpdate("terminal.cursorBlink", v, s)}
        />
      </section>

      <section className="space-y-4 pt-3 border-t border-panel-border">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Terminal Behavior
        </h3>

        <ToggleRow
          label="macOS: Option key as Meta"
          description="Treat Option as Meta for Emacs and Vim alt-key shortcuts."
          checked={terminal.macOptionIsMeta}
          onChange={(v) => onUpdate("terminal.macOptionIsMeta", v, s)}
        />

        <div>
          <label
            htmlFor="terminal-word-separators"
            className="block text-xs text-description-fg mb-1"
          >
            Double-click word separators
          </label>
          <input
            id="terminal-word-separators"
            type="text"
            value={terminal.wordSeparators}
            placeholder={" ()[]{}',\"`"}
            onChange={(e) =>
              onUpdate("terminal.wordSeparators", e.target.value, s)
            }
            className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
          />
        </div>

        <NumberField
          id="terminal-replay-buffer"
          label="Replay buffer size (KB)"
          value={terminal.replayBufferKb}
          min={10}
          max={500}
          step={10}
          onChange={(v) => onUpdate("terminal.replayBufferKb", v, s)}
        />
      </section>

      <section className="space-y-4 pt-3 border-t border-panel-border">
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-3 tracking-wide">
          Shell
        </h3>

        {platform === "windows" ? (
          <>
            <div>
              <label
                htmlFor="terminal-shell"
                className="block text-xs text-description-fg mb-1"
              >
                Shell executable
              </label>
              <CustomSelect
                id="terminal-shell"
                value={
                  showCustomShell ? "__custom__" : terminal.shellExecutable
                }
                onChange={(v) => {
                  if (v === "__custom__") {
                    setShowCustomShell(true);
                    return;
                  }
                  setShowCustomShell(false);
                  onUpdate("terminal.shellExecutable", v, s);
                }}
                options={WINDOWS_SHELL_OPTIONS}
              />
            </div>

            {showCustomShell && (
              <input
                type="text"
                value={terminal.shellExecutable}
                placeholder="C:\\Program Files\\PowerShell\\7\\pwsh.exe"
                onChange={(e) =>
                  onUpdate("terminal.shellExecutable", e.target.value, s)
                }
                className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
              />
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
            <div>
              <label
                htmlFor="terminal-shell"
                className="block text-xs text-description-fg mb-1"
              >
                Shell executable override
              </label>
              <input
                id="terminal-shell"
                type="text"
                value={terminal.shellExecutable}
                placeholder={
                  platform === "mac"
                    ? "Auto-detected from $SHELL, then /bin/zsh"
                    : "Auto-detected from $SHELL, then /bin/bash"
                }
                onChange={(e) =>
                  onUpdate("terminal.shellExecutable", e.target.value, s)
                }
                className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
              />
            </div>

            <p className="text-xs text-description-fg">
              Use this only when VS Code was launched without inheriting your
              login shell environment.
            </p>

            {platform === "mac" && terminal.shellExecutable === "/bin/bash" && (
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

        <div>
          <label
            htmlFor="terminal-mobile-control-bar"
            className="block text-xs text-description-fg mb-1"
          >
            Control bar visibility
          </label>
          <CustomSelect
            id="terminal-mobile-control-bar"
            value={terminal.mobileControlBar}
            onChange={(v) =>
              onUpdate(
                "terminal.mobileControlBar",
                v as TerminalMobileControlBar,
                s
              )
            }
            options={CONTROL_BAR_OPTIONS}
          />
          <p className="text-xs text-description-fg mt-1">
            Auto shows the bar for touch browsers connected to the FlightPath
            server.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs text-description-fg">
              Custom shortcuts
            </span>
            <button
              type="button"
              className="text-xs text-link-fg hover:text-link-active-fg"
              onClick={() =>
                onUpdate(
                  "terminal.mobileCustomShortcuts",
                  [
                    ...terminal.mobileCustomShortcuts,
                    { label: "", sequence: "" },
                  ],
                  s
                )
              }
            >
              + Add shortcut
            </button>
          </div>

          <div className="space-y-2">
            {terminal.mobileCustomShortcuts.length === 0 ? (
              <p className="text-xs text-description-fg">
                Add shortcuts for commands that need escape sequences, such as
                \x1b[1;5A.
              </p>
            ) : (
              terminal.mobileCustomShortcuts.map((shortcut, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={shortcut.label}
                    placeholder="Label"
                    aria-label={`Shortcut ${index + 1} label`}
                    onChange={(e) =>
                      onUpdate(
                        "terminal.mobileCustomShortcuts",
                        updateShortcut(terminal.mobileCustomShortcuts, index, {
                          label: e.target.value,
                        }),
                        s
                      )
                    }
                    className="min-w-0 flex-1 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                  <input
                    type="text"
                    value={shortcut.sequence}
                    placeholder="\\x1b[1;5A"
                    aria-label={`Shortcut ${index + 1} sequence`}
                    title="Use literal escape notation such as \\x1b[A, \\t, or \\r."
                    onChange={(e) =>
                      onUpdate(
                        "terminal.mobileCustomShortcuts",
                        updateShortcut(terminal.mobileCustomShortcuts, index, {
                          sequence: e.target.value,
                        }),
                        s
                      )
                    }
                    className="min-w-0 flex-1 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                  <button
                    type="button"
                    className="icon-btn w-7 h-7 shrink-0"
                    title="Remove shortcut"
                    aria-label={`Remove shortcut ${index + 1}`}
                    onClick={() =>
                      onUpdate(
                        "terminal.mobileCustomShortcuts",
                        terminal.mobileCustomShortcuts.filter(
                          (_item, shortcutIndex) => shortcutIndex !== index
                        ),
                        s
                      )
                    }
                  >
                    <i className="codicon codicon-close" />
                  </button>
                </div>
              ))
            )}
          </div>
          <p className="text-xs text-description-fg mt-2">
            Sequences accept literal escapes like \x1b, \t, and \r.
          </p>
        </div>
      </section>
    </div>
  );
}
