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
// xterm and the fit addon are statically imported: the terminal is a core
// feature, so there's no benefit to code-splitting them, and a static import
// folds them into the app bundle (whose load is covered by the bootstrap
// reconnect/reload watchdog) instead of a fragile runtime chunk fetch that could
// transiently fail and leave the terminal blank. The WebGL addon stays dynamic
// below — it's optional (DOM-renderer fallback) and best-effort.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
  /**
   * Controller's row count, recorded for diagnostics only. NOTE: viewer rows are
   * currently derived from the local container height (see applyControllerSize),
   * NOT synced to this value. Tracked so we can log controller-vs-viewer row
   * drift while evaluating whether rows should be synced like cols — TUI /
   * alternate-buffer output is positioned for the controller's exact row count.
   */
  controllerRows?: number;
}

interface FitSessionResult {
  cols: number;
  rows: number;
  proposedCols: number | null;
  proposedRows: number | null;
  mode: "controller" | "viewer";
}

// key: `${workflowId}:${sessionId}`
const registry = new Map<string, RegistryEntry>();

/**
 * Output chunks that arrive on the active workflow *before* its xterm entry
 * exists. The PTY can emit its first render in the brief gap between the
 * TERMINAL_STARTED message and the TerminalInstance mount that calls create()
 * — chunks in that window have no entry to write to and no session record to
 * hang off of, so without this they were silently dropped and only recoverable
 * by switching workflows away and back (which replays the server-side reconnect
 * buffer).
 *
 * Keyed by `${workflowId}:${sessionId}`. Drained into the terminal the moment
 * create() materializes the entry, then deleted. This is a *local* gap-filler,
 * distinct from the server reconnect buffer: the TERMINAL_OUTPUT handler only
 * feeds this for the active workflow, so the two never double up.
 */
const orphanOutput = new Map<string, string[]>();

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

/**
 * Letterbox a viewer's xterm element inside its container.
 *
 * The xterm is sized to the controller's exact cols×rows, so its rendered
 * element has a fixed pixel size that rarely matches the viewer's container.
 * Sizing domEl to `fit-content` in both axes makes it exactly the xterm canvas
 * size, so the container's overflow-x/y:auto scrollbars engage when the viewer
 * is smaller. Horizontal auto-margins center it when the viewer is wider; the
 * element stays top-aligned vertically so scrolling from the top always works
 * (auto top/bottom margins would clip the top in an overflow container).
 */
function applyViewerLetterbox(entry: RegistryEntry): void {
  entry.domEl.style.width = "fit-content";
  entry.domEl.style.height = "fit-content";
  entry.domEl.style.marginLeft = "auto";
  entry.domEl.style.marginRight = "auto";
}

function fitRegistryEntry(
  entry: RegistryEntry,
  mode: "controller" | "viewer"
): FitSessionResult {
  const dims = entry.fitAddon.proposeDimensions();
  const proposedCols = dims?.cols ?? null;
  const proposedRows = dims?.rows ?? null;

  if (mode === "viewer" && entry.controllerCols != null) {
    // Mirror the controller exactly: lock BOTH cols and rows to the controller's
    // PTY so the rendered grid (including TUI / alternate-buffer output) matches.
    // Fall back to the proposed/current rows only until controllerRows is known.
    const rows =
      entry.controllerRows ?? Math.max(1, proposedRows ?? entry.term.rows);
    entry.term.resize(entry.controllerCols, rows);
    applyViewerLetterbox(entry);
    return {
      cols: entry.term.cols,
      rows: entry.term.rows,
      proposedCols,
      proposedRows,
      mode,
    };
  }

  if (
    proposedCols != null &&
    proposedRows != null &&
    proposedCols > 0 &&
    proposedRows > 0
  ) {
    entry.term.resize(proposedCols, proposedRows);
  } else {
    entry.fitAddon.fit();
  }

  return {
    cols: entry.term.cols,
    rows: entry.term.rows,
    proposedCols,
    proposedRows,
    mode,
  };
}

function getFitMode(entry: RegistryEntry): "controller" | "viewer" {
  return entry.controllerCols != null ? "viewer" : "controller";
}

function ensureWebglAddonLoaded(entry: RegistryEntry): Promise<void> {
  if (entry.webglAddonLoadPromise) {
    return entry.webglAddonLoadPromise;
  }

  entry.webglAddonLoadPromise = (async () => {
    const startedAt = performance.now();
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
      WebviewLog.debug(
        `[terminalRegistry.ensureWebglAddonLoaded] WebGL ready in ${Math.round(
          performance.now() - startedAt
        )}ms`
      );
    } catch {
      // WebGL unavailable at startup — xterm uses its built-in renderer.
      WebviewLog.debug(
        `[terminalRegistry.ensureWebglAddonLoaded] WebGL unavailable after ${Math.round(
          performance.now() - startedAt
        )}ms — using built-in renderer`
      );
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

    // xterm/FitAddon are statically imported, so this runs synchronously with no
    // await — concurrent callers can't interleave, hence no pending-create dedup.
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

    // Flush output that arrived before this entry existed. Must happen here —
    // the single point where the entry materializes — and before attach()'s
    // optional async WebGL import, so buffered chunks render in order ahead of
    // any live chunks that now write directly via get().
    const buffered = orphanOutput.get(key);
    if (buffered?.length) {
      const totalChars = buffered.reduce((n, c) => n + c.length, 0);
      WebviewLog.debug(
        `[terminalRegistry.create] flushing ${buffered.length} buffered chunk(s) (${totalChars} chars) ` +
          `wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
      );
      for (const chunk of buffered) {
        term.write(chunk);
      }
      orphanOutput.delete(key);
    }

    WebviewLog.debug(
      `[terminalRegistry.create] created wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)}`
    );
    return entry;
  },

  /**
   * Buffer a chunk that arrived before create() — see orphanOutput. Callers
   * (the TERMINAL_OUTPUT handler) MUST gate this to the active workflow so it
   * never competes with the server reconnect-buffer replay for backgrounded
   * workflows.
   */
  bufferOrphanOutput(
    workflowId: string,
    sessionId: string,
    chunk: string
  ): void {
    const key = makeKey(workflowId, sessionId);
    const existing = orphanOutput.get(key);
    if (existing) {
      existing.push(chunk);
    } else {
      orphanOutput.set(key, [chunk]);
    }
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
        const fitResult = fitRegistryEntry(entry, getFitMode(entry));
        WebviewLog.debug(
          `[terminalRegistry.attach] rAF resize — container display=${containerDisplay} size=${containerSize} ` +
            `domElConnected=${entry.domEl.isConnected} controllerCols=${entry.controllerCols ?? "none"} ` +
            `proposed=${fitResult.proposedCols ?? "none"}x${fitResult.proposedRows ?? "none"} ` +
            `actual=${fitResult.cols}x${fitResult.rows} mode=${fitResult.mode}`
        );
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
    cols: number,
    rows?: number
  ): void {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) return;
    entry.controllerCols = cols;
    if (rows != null) entry.controllerRows = rows;

    // Mirror the controller exactly: lock the viewer's xterm to the controller's
    // cols AND rows. Rows are no longer derived from the local container — the
    // grid must match the controller so TUI / alternate-buffer output (positioned
    // for the controller's exact row count) renders identically. The viewer's
    // container letterboxes the fixed-size grid via overflow scrollbars / margins.
    const targetRows = Math.max(1, entry.controllerRows ?? entry.term.rows);
    try {
      entry.term.resize(cols, targetRows);
    } catch {
      // May throw if terminal isn't fully initialized yet — safe to ignore
    }

    applyViewerLetterbox(entry);

    WebviewLog.debug(
      `[terminalRegistry.applyControllerSize] wf=${workflowId.slice(0, 8)} sess=${sessionId.slice(0, 8)} ` +
        `controller=${cols}x${rows ?? "?"} viewer=${entry.term.cols}x${entry.term.rows}` +
        (rows != null && rows !== entry.term.rows ? " ROW MISMATCH" : "")
    );
  },

  /**
   * Restore fit-to-container sizing when this client becomes the controller.
   * Undoes the fit-content width and auto margins set by applyControllerSize.
   */
  clearControllerSize(workflowId: string, sessionId: string): void {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) return;
    entry.controllerCols = undefined;
    entry.controllerRows = undefined;
    entry.domEl.style.width = "100%";
    entry.domEl.style.height = "100%";
    entry.domEl.style.marginLeft = "";
    entry.domEl.style.marginRight = "";
    try {
      fitRegistryEntry(entry, "controller");
    } catch {
      // Ignore — terminal may not be visible
    }
  },

  fitSessionToContainer(
    workflowId: string,
    sessionId: string,
    mode: "controller" | "viewer"
  ): FitSessionResult | null {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) {
      return null;
    }

    return fitRegistryEntry(entry, mode);
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
      orphanOutput.delete(key);
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
    orphanOutput.delete(key);
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
