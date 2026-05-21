import { useEffect, useMemo, useRef, useState } from "react";
import { LocalTextInput } from "../shared/LocalInputs";
import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  type TerminalCursorStyle,
  type TerminalMobileControlBar,
} from "@root/types/DashboardConstants";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import type { TerminalShortcut } from "@root/types/FlightPathSettings";
import { CustomSelect } from "../shared/CustomSelect";
import { SettingInputRow } from "../shared/SettingInputRow";
import { SettingToggleRow } from "../shared/SettingToggleRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
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
  path,
  sources,
  onReset,
  activeScope,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  note?: string;
  path?: string;
  sources?: Record<string, SettingSource>;
  onReset?: (path: string) => void;
  activeScope?: SettingWriteScope;
}) {
  const [localValue, setLocalValue] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setLocalValue(String(value));
    }
  }, [value]);

  const displayNum = Number(localValue);
  const isInvalid =
    Number.isFinite(displayNum) && (displayNum < min || displayNum > max);

  return (
    <SettingInputRow
      label={label}
      id={id}
      path={path}
      sources={sources}
      onReset={onReset}
      activeScope={activeScope}
    >
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={(e) => {
          focused.current = false;
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
    </SettingInputRow>
  );
}

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
  const setSize = (next: number) => onChange(clampNumber(next, min, max));

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
    </SettingInputRow>
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

// xterm modifier number: shift=1, alt=2, ctrl=4 → sum + 1
function xtermModNum(e: KeyboardEvent): number {
  return (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + 1;
}

function keyEventToCapture(
  e: KeyboardEvent
): { sequence: string; humanLabel: string } | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;

  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  const shift = e.shiftKey;

  const modParts: string[] = [];
  if (ctrl) modParts.push("Ctrl");
  if (alt) modParts.push("Alt");
  if (shift) modParts.push("Shift");

  const label = (...extra: string[]) =>
    [...modParts, ...extra].join("+") || extra.join("+");

  // Arrow keys (any modifier combination)
  const ARROWS: Record<string, [string, string]> = {
    ArrowUp: ["A", "↑"],
    ArrowDown: ["B", "↓"],
    ArrowRight: ["C", "→"],
    ArrowLeft: ["D", "←"],
  };
  if (e.key in ARROWS) {
    const [code, glyph] = ARROWS[e.key];
    const mod = xtermModNum(e);
    const seq = mod > 1 ? `\\x1b[1;${mod}${code}` : `\\x1b[${code}`;
    return { sequence: seq, humanLabel: label(glyph) };
  }

  // Special keys
  if (e.key === "Escape" && !ctrl && !alt && !shift)
    return { sequence: "\\x1b", humanLabel: "Esc" };
  if (e.key === "Tab" && !ctrl && !alt)
    return shift
      ? { sequence: "\\x1b[Z", humanLabel: "Shift+Tab" }
      : { sequence: "\\t", humanLabel: "Tab" };
  if (e.key === "Enter" && !ctrl && !alt && !shift)
    return { sequence: "\\r", humanLabel: "Enter" };
  if (e.key === "Backspace" && !ctrl && !alt && !shift)
    return { sequence: "\\x7f", humanLabel: "Backspace" };
  if (e.key === "Delete") {
    const mod = xtermModNum(e);
    return {
      sequence: mod > 1 ? `\\x1b[3;${mod}~` : "\\x1b[3~",
      humanLabel: label("Del"),
    };
  }
  if (e.key === "Insert")
    return { sequence: "\\x1b[2~", humanLabel: label("Ins") };
  if (e.key === "Home")
    return { sequence: "\\x1b[H", humanLabel: label("Home") };
  if (e.key === "End") return { sequence: "\\x1b[F", humanLabel: label("End") };
  if (e.key === "PageUp")
    return { sequence: "\\x1b[5~", humanLabel: label("PgUp") };
  if (e.key === "PageDown")
    return { sequence: "\\x1b[6~", humanLabel: label("PgDn") };

  // Single printable character with modifiers
  if (e.key.length === 1) {
    const upper = e.key.toUpperCase();
    const charCode = upper.charCodeAt(0) - 64;

    if (ctrl && alt && charCode >= 1 && charCode <= 26) {
      return {
        sequence: `\\x1b\\x${charCode.toString(16).padStart(2, "0")}`,
        humanLabel: `Ctrl+Alt+${upper}`,
      };
    }
    if (ctrl && !alt && charCode >= 1 && charCode <= 26) {
      return {
        sequence: `\\x${charCode.toString(16).padStart(2, "0")}`,
        humanLabel: `Ctrl+${upper}`,
      };
    }
    if (alt && !ctrl) {
      return {
        sequence: `\\x1b${e.key}`,
        humanLabel: `Alt+${upper}`,
      };
    }
    if (!ctrl && !alt) {
      return { sequence: e.key, humanLabel: e.key };
    }
  }

  return null;
}

function sequenceToHumanLabel(seq: string): string | null {
  if (!seq) return null;
  if (seq === "\\t") return "Tab";
  if (seq === "\\r") return "Enter";
  if (seq === "\\x1b") return "Esc";
  if (seq === "\\x7f") return "Backspace";
  if (seq === "\\x1b[3~") return "Del";
  if (seq === "\\x1b[2~") return "Ins";
  if (seq === "\\x1b[H") return "Home";
  if (seq === "\\x1b[F") return "End";
  if (seq === "\\x1b[5~") return "PgUp";
  if (seq === "\\x1b[6~") return "PgDn";
  if (seq === "\\x1b[Z") return "Shift+Tab";

  // Ctrl+letter: \x01..\x1a
  const ctrlMatch = seq.match(/^\\x([01][0-9a-fA-F])$/);
  if (ctrlMatch) {
    const code = parseInt(ctrlMatch[1], 16);
    if (code >= 1 && code <= 26)
      return "Ctrl+" + String.fromCharCode(code + 64);
  }

  // Ctrl+Alt+letter: \x1b\xNN
  const ctrlAlt = seq.match(/^\\x1b\\x([01][0-9a-fA-F])$/);
  if (ctrlAlt) {
    const code = parseInt(ctrlAlt[1], 16);
    if (code >= 1 && code <= 26)
      return "Ctrl+Alt+" + String.fromCharCode(code + 64);
  }

  const ARROW_GLYPHS: Record<string, string> = {
    A: "↑",
    B: "↓",
    C: "→",
    D: "←",
  };

  // Arrow without modifier: \x1b[A..D
  const arrow = seq.match(/^\\x1b\[([ABCD])$/);
  if (arrow) return ARROW_GLYPHS[arrow[1]] ?? null;

  // Arrow with modifier: \x1b[1;<mod><dir>
  const arrowMod = seq.match(/^\\x1b\[1;(\d+)([ABCD])$/);
  if (arrowMod) {
    const mod = parseInt(arrowMod[1]) - 1;
    const glyph = ARROW_GLYPHS[arrowMod[2]];
    if (glyph) {
      const parts: string[] = [];
      if (mod & 4) parts.push("Ctrl");
      if (mod & 2) parts.push("Alt");
      if (mod & 1) parts.push("Shift");
      parts.push(glyph);
      return parts.join("+");
    }
  }

  // Delete with modifier: \x1b[3;<mod>~
  const delMod = seq.match(/^\\x1b\[3;(\d+)~$/);
  if (delMod) {
    const mod = parseInt(delMod[1]) - 1;
    const parts: string[] = [];
    if (mod & 4) parts.push("Ctrl");
    if (mod & 2) parts.push("Alt");
    if (mod & 1) parts.push("Shift");
    parts.push("Del");
    return parts.join("+");
  }

  // Alt+char: \x1b followed by single printable ASCII
  const altChar = seq.match(/^\\x1b([!-~])$/);
  if (altChar) return `Alt+${altChar[1].toUpperCase()}`;

  return null;
}

function KeyCaptureInput({
  sequence,
  ariaLabel,
  onSequenceChange,
  onCapture,
}: {
  sequence: string;
  ariaLabel?: string;
  onSequenceChange: (sequence: string) => void;
  onCapture: (sequence: string, humanLabel: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const captureButtonRef = useRef<HTMLButtonElement>(null);

  const humanLabel = sequenceToHumanLabel(sequence);

  const startCapture = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (capturing) {
      setCapturing(false);
      return;
    }
    setEditing(false);
    setCapturing(true);
    setTimeout(() => captureButtonRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    e.preventDefault();
    const result = keyEventToCapture(e.nativeEvent);
    if (result) {
      onCapture(result.sequence, result.humanLabel);
      setCapturing(false);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLButtonElement>) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setCapturing(false);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={sequence}
        placeholder="\\x1b[1;5A"
        aria-label={ariaLabel}
        title="Literal escape notation: \\x1b[A, \\t, \\r"
        onChange={(e) => onSequenceChange(e.target.value)}
        onBlur={() => setEditing(false)}
        className="min-w-0 flex-1 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground font-mono focus:outline-none focus:border-focus-border"
      />
    );
  }

  return (
    <div ref={containerRef} className="min-w-0 flex-1">
      <div
        className={`flex items-center gap-1 bg-input-bg border rounded px-2 py-1 text-sm h-[30px] ${
          capturing ? "border-focus-border" : "border-input-border"
        }`}
      >
        <button
          ref={captureButtonRef}
          type="button"
          aria-label={ariaLabel}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onClick={() => {
            if (!capturing) {
              setEditing(true);
            }
          }}
          title={humanLabel && sequence ? `Sequence: ${sequence}` : undefined}
          className={`flex-1 min-w-0 truncate text-left focus:outline-none ${
            capturing
              ? "text-description-fg italic text-xs"
              : sequence
                ? humanLabel
                  ? "text-foreground"
                  : "text-description-fg font-mono text-xs"
                : "text-input-placeholder italic text-xs"
          }`}
        >
          {capturing
            ? "Press a key combination…"
            : sequence
              ? (humanLabel ?? sequence)
              : "\\x1b[1;5A"}
        </button>
        <button
          type="button"
          className={`icon-btn w-5 h-5 shrink-0 p-0 ${capturing ? "text-focus-border" : ""}`}
          title={
            capturing
              ? "Press Esc to cancel"
              : "Click then press a key combination to capture"
          }
          aria-label="Capture key combination"
          onClick={startCapture}
        >
          <i className="codicon codicon-sm codicon-keyboard" />
        </button>
      </div>
    </div>
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
            options={CURSOR_STYLE_OPTIONS}
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

        {platform === "windows" ? (
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
                  showCustomShell ? "__custom__" : terminal.shellExecutable
                }
                onChange={(v) => {
                  if (v === "__custom__") {
                    setShowCustomShell(true);
                    return;
                  }
                  setShowCustomShell(false);
                  onUpdate("terminal.shellExecutable", v);
                }}
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
                  platform === "mac"
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

        <SettingInputRow
          label="Control bar visibility"
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
            options={CONTROL_BAR_OPTIONS}
          />
          <p className="text-xs text-description-fg mt-1">
            Auto shows the bar for touch browsers connected to the FlightPath
            server.
          </p>
        </SettingInputRow>

        <SettingInputRow
          label="Custom shortcuts"
          path="terminal.mobileCustomShortcuts"
          {...rowProps}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs text-description-fg">
              Custom shortcuts
            </span>
            <button
              type="button"
              className="text-xs text-link-fg hover:text-link-active-fg"
              onClick={() =>
                onUpdate("terminal.mobileCustomShortcuts", [
                  ...terminal.mobileCustomShortcuts,
                  { label: "", sequence: "" },
                ])
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
                  <LocalTextInput
                    value={shortcut.label}
                    placeholder="Label"
                    aria-label={`Shortcut ${index + 1} label`}
                    onCommit={(v) =>
                      onUpdate(
                        "terminal.mobileCustomShortcuts",
                        updateShortcut(terminal.mobileCustomShortcuts, index, {
                          label: v,
                        })
                      )
                    }
                    className="min-w-0 flex-1 bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border"
                  />
                  <KeyCaptureInput
                    sequence={shortcut.sequence}
                    ariaLabel={`Shortcut ${index + 1} sequence`}
                    onSequenceChange={(seq) =>
                      onUpdate(
                        "terminal.mobileCustomShortcuts",
                        updateShortcut(terminal.mobileCustomShortcuts, index, {
                          sequence: seq,
                        })
                      )
                    }
                    onCapture={(seq, humanLabel) =>
                      onUpdate(
                        "terminal.mobileCustomShortcuts",
                        updateShortcut(terminal.mobileCustomShortcuts, index, {
                          sequence: seq,
                          ...(shortcut.label === ""
                            ? { label: humanLabel }
                            : {}),
                        })
                      )
                    }
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
                        )
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
            Click the keyboard icon then press a key combination to capture it.
            Click the sequence display to edit the raw escape notation manually
            (e.g. \x1b[A, \t, \r).
          </p>
        </SettingInputRow>
      </section>
    </div>
  );
}
