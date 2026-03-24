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

export type { Terminal, ITheme };

/**
 * Accumulates keystrokes from an AI CLI PTY session.
 * Only for ai-cli sessions (not shell sessions).
 * Detects user-typed long-form prompts and emits them for retroactive queue attribution.
 */
export class InputCapture {
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
}

// key: `${workflowId}:${sessionId}`
const registry = new Map<string, RegistryEntry>();

// Current terminal font size — set by App.tsx via updateFontSize(), used by create()
let currentFontSize = 14;

function makeKey(workflowId: string, sessionId: string): string {
  return `${workflowId}:${sessionId}`;
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
    cursor: get("--vscode-terminalCursor-foreground"),
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
    // Read the resolved font family from VS Code CSS variables — xterm passes fontFamily
    // directly to the canvas 2D context, which cannot resolve CSS var() expressions.
    const fontFamily =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-font-family")
        .trim() || '"Cascadia Code", "Courier New", monospace';
    const term = new Terminal({
      theme,
      scrollback: 5000,
      fontFamily,
      fontSize: currentFontSize,
      lineHeight: 1.2,
      letterSpacing: 0,
      allowTransparency: false,
      cursorBlink: true,
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
  async attach(workflowId: string, sessionId: string, container: HTMLElement): Promise<void> {
    const entry = registry.get(makeKey(workflowId, sessionId));
    if (!entry) return;
    if (!entry.term.element) {
      // First render — open the terminal into the domEl, then load WebGL renderer
      container.appendChild(entry.domEl);
      entry.term.open(entry.domEl);
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        // Dispose gracefully if the WebGL context is lost (e.g. too many canvases open)
        webgl.onContextLoss(() => webgl.dispose());
        entry.term.loadAddon(webgl);
      } catch {
        // WebGL unavailable — fall back to canvas renderer silently
      }
    } else {
      // Subsequent attach — move the existing DOM element back in
      container.appendChild(entry.domEl);
    }
    requestAnimationFrame(() => {
      try {
        entry.fitAddon.fit();
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
    registry.get(makeKey(workflowId, sessionId))?.domEl.remove();
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

  /**
   * Update font size for all live registry entries and future creates.
   * Called when the user adjusts the terminal font size stepper.
   */
  updateFontSize(size: number): void {
    currentFontSize = size;
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
   * Dispose and remove ai-cli sessions for a workflow.
   * Shell sessions survive run boundaries — call clearSession() to close them.
   * Called when a new run starts.
   */
  clearAiCliSessions(workflowId: string, sessionIds: string[]): void {
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
      entry.term.dispose();
      registry.delete(key);
    }
  },
};
