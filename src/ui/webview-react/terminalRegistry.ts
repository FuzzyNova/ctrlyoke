/**
 * Terminal Registry — module-level owner of all xterm.js Terminal instances.
 *
 * Lives completely outside the React component tree so that xterm.js instances
 * (canvas, WebGL context, scrollback buffers) survive React unmounts.
 *
 * Two distinct switching scenarios:
 *  - Within-workflow (rail switching): TerminalInstance `isVisible` prop toggles
 *    `display: none`. No attach/detach calls.
 *  - Across-workflow (workflow tab switching): TerminalView unmounts →
 *    detach() removes DOM element from document (xterm survives in JS heap) →
 *    on return, attach() moves the existing DOM element back into the container.
 */
import type { Terminal, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
} from "@root/types/DashboardConstants";
import type { TerminalSettings } from "@root/types/WebviewMessageTypes";
import { WebviewLog } from "./utils/logger";

export type { Terminal, ITheme };

/**
 * Accumulates keystrokes from an AI CLI PTY session.
 * Only for ai-cli sessions (not shell sessions).
 * Detects user-typed long-form prompts and emits them for retroactive queue attribution.
 */
class InputCapture {
  private buffer = "";
  private readonly threshold: number;

  constructor(threshold = 10) {
    this.threshold = threshold;
  }

  /**
   * Feed a raw xterm data chunk into the capture buffer.
   * Returns captured text if Enter was pressed and text exceeds threshold, else null.
   */
  accumulate(data: string): string | null {
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        const captured = this.buffer.trim();
        this.buffer = "";
        if (captured.length > this.threshold) {
          return captured;
        }
        return null;
      } else if (char === "\x7f" || char === "\b") {
        // Backspace
        this.buffer = this.buffer.slice(0, -1);
      } else if (char === "\x03" || char === "\x04") {
        // Ctrl+C / Ctrl+D — discard buffer
        this.buffer = "";
      } else if (char >= " ") {
        // Printable chars only
        this.buffer += char;
      }
    }
    return null;
  }

  reset(): void {
    this.buffer = "";
  }
}

export interface RegistryEntry {
  term: Terminal;
  fitAddon: FitAddon;
  /** Root element xterm rendered into; may be detached from the document */
  domEl: HTMLElement;
  inputCapture: InputCapture;
  /** true for ended ai-cli sessions — onData is not registered when frozen */
  frozen: boolean;
  /** Disposable returned by term.onData (stored so we can dispose it when freezing) */
  onDataDisposable?: { dispose(): void };
  /** Deduplicates lazy WebGL addon loading across repeated attach calls. */
  webglAddonLoadPromise?: Promise<void>;
  /**
   * Controller's column count, set when this client is a viewer.
   * Used by the ResizeObserver to maintain fixed cols while allowing rows to adapt
   * to the local container height. Undefined when this client is the controller.
   */
  controllerCols?: number;
}

// key: `${workflowId}:${sessionId}`
const registry = new Map<string, RegistryEntry>();

let currentTerminalSettings: TerminalSettings = {
  fontSize: 14,
  lineHeight: 1.2,
  scrollback: 5000,
  cursorStyle: TERMINAL_CURSOR_STYLES.BLOCK,
  cursorBlink: true,
  macOptionIsMeta: false,
  wordSeparators: " ()[]{}',\"`",
  replayBufferKb: 50,
  shellExecutable: "",
  mobileControlBar: TERMINAL_MOBILE_CONTROL_BAR.AUTO,
  mobileCustomShortcuts: [],
};

function makeKey(workflowId: string, sessionId: string): string {
  return `${workflowId}:${sessionId}`;
}

function ensureWebglAddonLoaded(entry: RegistryEntry): Promise<void> {
  if (entry.webglAddonLoadPromise) {
    return entry.webglAddonLoadPromise;
  }

  entry.webglAddonLoadPromise = (async () => {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const webgl = new WebglAddon();
      // On context loss (e.g. Chromium's 16-context limit hit), let xterm
      // fall back to its built-in renderer. @xterm/addon-canvas currently
      // peers on xterm v5 and is not compatible with our xterm v6 package.
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      entry.term.loadAddon(webgl);
    } catch {
      // WebGL unavailable at startup — xterm uses its built-in renderer.
    }
  })();

  return entry.webglAddonLoadPromise;
}

/**
 * Read VS Code terminal CSS variables for xterm.js theming.
 * Called once per create() — theme updates handled via THEME_CHANGED message.
 */
function readVsCodeTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const get = (v: string) => style.getPropertyValue(v).trim() || undefined;
  return {
    background:
      get("--vscode-terminal-background") ?? get("--vscode-editor-background"),
    foreground:
      get("--vscode-terminal-foreground") ?? get("--vscode-editor-foreground"),
    cursor:
      get("--vscode-terminalCursor-foreground") ??
      get("--vscode-terminal-foreground") ??
      get("--vscode-editor-foreground"),
    cursorAccent:
      get("--vscode-terminal-background") ?? get("--vscode-editor-background"),
    selectionBackground: get("--vscode-terminal-selectionBackground"),
    black: get("--vscode-terminal-ansiBlack"),
    red: get("--vscode-terminal-ansiRed"),
    green: get("--vscode-terminal-ansiGreen"),
    yellow: get("--vscode-terminal-ansiYellow"),
    blue: get("--vscode-terminal-ansiBlue"),
    magenta: get("--vscode-terminal-ansiMagenta"),
    cyan: get("--vscode-terminal-ansiCyan"),
    white: get("--vscode-terminal-ansiWhite"),
    brightBlack: get("--vscode-terminal-ansiBrightBlack"),
    brightRed: get("--vscode-terminal-ansiBrightRed"),
    brightGreen: get("--vscode-terminal-ansiBrightGreen"),
    brightYellow: get("--vscode-terminal-ansiBrightYellow"),
    brightBlue: get("--vscode-terminal-ansiBrightBlue"),
    brightMagenta: get("--vscode-terminal-ansiBrightMagenta"),
    brightCyan: get("--vscode-terminal-ansiBrightCyan"),
    brightWhite: get("--vscode-terminal-ansiBrightWhite"),
  };
}

export const terminalRegistry = {
  /**
   * Create a new xterm.js Terminal instance for a session.
   * The terminal is not yet rendered — call attach() to add it to the DOM.
   */
  async create(workflowId: string, sessionId: string): Promise<RegistryEntry> {
    const key = makeKey(workflowId, sessionId);
    const existing = registry.get(key);
    if (existing) return existing;

    // Dynamic imports so xterm is only loaded when actually needed
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);

    const theme = readVsCodeTheme();
    const settings = this.getTerminalSettings();
    // Read the resolved font family from VS Code CSS variables — xterm passes fontFamily
    // directly to the canvas 2D context, which cannot resolve CSS var() expressions.
    const fontFamily =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-font-family")
        .trim() || '"Cascadia Code", "Courier New", monospace';
    const term = new Terminal({
      theme,
      scrollback: settings.scrollback,
      fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: 0,
      allowTransparency: false,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      macOptionIsMeta: settings.macOptionIsMeta,
      wordSeparator: settings.wordSeparators,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const domEl = document.createElement("div");
    domEl.style.cssText = "width:100%;height:100%;";

    const entry: RegistryEntry = {
      term,
      fitAddon,
      domEl,
      inputCapture: new InputCapture(),
      frozen: false,
    };

    registry.set(key, entry);
    return entry;
  },

  /**
   * Attach an xterm Terminal to a DOM container.
   * Safe to call multiple times — opens the terminal on first call, moves DOM on subsequent calls.
   * On first open, loads the WebGL addon for gap-free box-drawing and better TUI color fidelity.
   */
  async attach(
    workflowId: string,
    sessionId: string,
    container: HTMLElement
  ): Promise<void> {
    const entry = registry.get(makeKey(workflowId, sessionId));
    const isFirstRender = !entry?.term.element;
    WebviewLog.debug(
      `[terminalRegistry.attach] wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
        `entryExists=${!!entry} firstRender=${isFirstRender} ` +
        `containerConnected=${container.isConnected} containerSize=${container.offsetWidth}x${container.offsetHeight}`
    );
    if (!entry) return;
    if (!entry.term.element) {
      // First render — open the terminal into the domEl synchronously so React
      // remounts cannot leave the terminal attached to a stale container while
      // the optional WebGL addon is still loading in the background.
      container.appendChild(entry.domEl);
      entry.term.open(entry.domEl);
      void ensureWebglAddonLoaded(entry);
    } else {
      // Subsequent attach — move the existing DOM element back in
      container.appendChild(entry.domEl);
    }
    requestAnimationFrame(() => {
      try {
        const containerSize = `${container.offsetWidth}x${container.offsetHeight}`;
        const containerDisplay = getComputedStyle(container).display;
        WebviewLog.debug(
          `[terminalRegistry.attach] rAF resize — container display=${containerDisplay} size=${containerSize} ` +
            `domElConnected=${entry.domEl.isConnected} controllerCols=${entry.controllerCols ?? "none"}`
        );
        if (entry.controllerCols != null) {
          // Viewer mode: lock to controller's cols, derive rows from container height
          const dims = entry.fitAddon.proposeDimensions();
          const rows = Math.max(1, dims?.rows ?? entry.term.rows);
          entry.term.resize(entry.controllerCols, rows);
          entry.domEl.style.width = "fit-content";
          entry.domEl.style.marginLeft = "auto";
          entry.domEl.style.marginRight = "auto";
        } else {
          entry.fitAddon.fit();
        }
      } catch {
        // May throw if container has no dimensions yet — safe to ignore
      }
    });
  },

  /**
   * Detach the terminal DOM element from the document.
   * The xterm instance and scrollback remain alive in JS heap.
   * Called when the workflow tab is switched away from.
   */
  detach(workflowId: string, sessionId: string): void {
    const entry = registry.get(makeKey(workflowId, sessionId));
    WebviewLog.debug(
      `[terminalRegistry.detach] wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
        `entryExists=${!!entry} domElConnected=${entry?.domEl.isConnected ?? false}`
    );
    entry?.domEl.remove();
  },

  /**
   * Freeze an ended ai-cli session.
   * Disposes the onData disposable so keystrokes no longer route to the dead PTY.
   * TerminalInstance checks entry.frozen on (re)mount and skips onData registration.
   */
  freeze(workflowId: string, sessionId: string): void {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) return;
    entry.frozen = true;
    entry.onDataDisposable?.dispose();
    entry.onDataDisposable = undefined;
  },

  /**
   * Unfreeze a previously frozen ai-cli session for inject-mode resume.
   * Clears the frozen flag so TerminalInstance can re-register onData on next
   * mount, and so future TERMINAL_OUTPUT writes render immediately.
   * The FrozenOverlay disappears when the store's session status is set back
   * to RUNNING by the caller.
   */
  unfreeze(workflowId: string, sessionId: string): void {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) return;
    entry.frozen = false;
  },

  get(workflowId: string, sessionId: string): RegistryEntry | undefined {
    return registry.get(makeKey(workflowId, sessionId));
  },

  /**
   * Update xterm theme for all live registry entries.
   * Called when VS Code color theme changes.
   */
  updateTheme(theme: ITheme): void {
    for (const entry of registry.values()) {
      entry.term.options.theme = theme;
    }
  },

  getTerminalSettings(): TerminalSettings {
    return currentTerminalSettings;
  },

  updateTerminalOptions(settings: TerminalSettings): void {
    currentTerminalSettings = { ...settings };
    for (const entry of registry.values()) {
      entry.term.options.scrollback = settings.scrollback;
      entry.term.options.lineHeight = settings.lineHeight;
      entry.term.options.cursorStyle = settings.cursorStyle;
      entry.term.options.cursorBlink = settings.cursorBlink;
      entry.term.options.macOptionIsMeta = settings.macOptionIsMeta;
      entry.term.options.wordSeparator = settings.wordSeparators;
      entry.term.options.fontSize = settings.fontSize;
      try {
        entry.fitAddon.fit();
      } catch {
        // Ignore — terminal may not be attached
      }
    }
  },

  /**
   * Update font size for all live registry entries and future creates.
   * Called when the user adjusts the terminal font size stepper.
   */
  updateFontSize(size: number): void {
    currentTerminalSettings = {
      ...currentTerminalSettings,
      fontSize: size,
    };
    for (const entry of registry.values()) {
      entry.term.options.fontSize = size;
      try {
        entry.fitAddon.fit();
      } catch {
        // Ignore — terminal may not be attached
      }
    }
  },

  /**
   * Apply the controller's column count to a viewer's xterm instance.
   * - Resizes the terminal to controllerCols × (rows derived from container height)
   *   so line-wrapping matches the controller's PTY exactly.
   * - Shrinks domEl to fit-content width (sized by the xterm canvas) so the
   *   container's overflow-x:auto scrollbar fires when the viewer is narrower.
   * - Centers domEl with auto margins when the viewer is wider.
   * Called when TERMINAL_SIZE_CHANGED arrives for a non-controller client,
   * and when isController transitions from true→false.
   */
  applyControllerSize(
    workflowId: string,
    sessionId: string,
    cols: number
  ): void {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) return;
    entry.controllerCols = cols;

    // Compute rows from the current container height so the viewer fills vertically
    const dims = entry.fitAddon.proposeDimensions();
    const rows = dims?.rows ?? entry.term.rows;
    try {
      entry.term.resize(cols, Math.max(1, rows));
    } catch {
      // May throw if terminal isn't fully initialized yet — safe to ignore
    }

    // Shrink domEl to canvas width so parent overflow-x:auto triggers correctly
    entry.domEl.style.width = "fit-content";
    entry.domEl.style.marginLeft = "auto";
    entry.domEl.style.marginRight = "auto";
  },

  /**
   * Restore fit-to-container sizing when this client becomes the controller.
   * Undoes the fit-content width and auto margins set by applyControllerSize.
   */
  clearControllerSize(workflowId: string, sessionId: string): void {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) return;
    entry.controllerCols = undefined;
    entry.domEl.style.width = "100%";
    entry.domEl.style.marginLeft = "";
    entry.domEl.style.marginRight = "";
    try {
      entry.fitAddon.fit();
    } catch {
      // Ignore — terminal may not be visible
    }
  },

  /**
   * Dispose and remove ai-cli sessions for a workflow.
   * Shell sessions survive run boundaries — call clearSession() to close them.
   * Called when a new run starts.
   */
  clearAiCliSessions(workflowId: string, sessionIds: string[]): void {
    WebviewLog.debug(
      `[terminalRegistry.clearAiCliSessions] wf=${workflowId.slice(0, 8)} clearing ${sessionIds.length} session(s): ` +
        `[${sessionIds.map((id) => id.slice(0, 8)).join(", ")}]`
    );
    for (const sessionId of sessionIds) {
      const key = makeKey(workflowId, sessionId);
      const entry = registry.get(key);
      if (entry) {
        entry.term.dispose();
        registry.delete(key);
      }
    }
  },

  /**
   * Dispose and remove a single session (explicit user close for shell sessions).
   */
  clearSession(workflowId: string, sessionId: string): void {
    const key = makeKey(workflowId, sessionId);
    const entry = registry.get(key);
    if (entry) {
      WebviewLog.debug(
        `[terminalRegistry.clearSession] wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
      );
      entry.term.dispose();
      registry.delete(key);
    }
  },
};
