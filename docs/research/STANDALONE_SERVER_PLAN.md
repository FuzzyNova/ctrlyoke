# Standalone FlightPath Server Plan

## Overview

Expose the existing `src/ui/webview-react/` React dashboard as a browser-accessible web app backed by a standalone HTTP/WebSocket server. The server replaces VS Code as the host environment, reusing all existing React components, Zustand stores, and core FlightPath business logic without forking or duplicating them.

## Goals

- Serve the existing React webview at `http://localhost:<port>` in any browser
- Replace VS Code-specific APIs (`acquireVsCodeApi`, `vscode.postMessage`, `vscode.getState/setState`) with browser-compatible equivalents
- Provide full `--vscode-*` CSS variable defaults so the UI renders correctly without a VS Code theme
- Reuse existing `PlatformAdapter` / `CliAdapter` for workflow execution (no new business logic)
- Require **zero changes** to existing React components, hooks, or stores
- Support light and dark themes out of the box

## Non-Goals

- Real-time multi-user collaboration
- Remote workflow execution beyond what the CLI already supports
- A full VS Code extension replacement (this is a developer/power-user tool)

---

## Architecture

```
Browser
  ↕ HTTP (React app assets)
  ↕ WebSocket (bidirectional messages, same protocol as VS Code postMessage)
Standalone FlightPath Server (Node.js)
  ↕ PlatformAdapter (StandaloneServerAdapter)
  ↕ FlightPathManager / WorkflowExecutor / CliIntegration (unchanged)
```

### Key Insight: The Shim Pattern

The React app already talks to VS Code through a single narrow interface:

```typescript
// All communication goes through this singleton
window.vscodeApi = acquireVsCodeApi(); // set once before React loads
```

`acquireVsCodeApi()` returns exactly three methods:
- `postMessage(msg)` — webview → extension
- `getState()` — read persisted UI state
- `setState(state)` — write persisted UI state

By injecting a **WebSocket shim** in place of `acquireVsCodeApi()`, we satisfy the entire contract without touching a single React file.

---

## Implementation Plan

### Phase 1 — WebSocket Shim (browser side)

**New file:** `src/server/standalone-shim.js` (plain JS, not TypeScript — injected directly into HTML)

```javascript
// Runs before React. Provides window.vscodeApi backed by a WebSocket.
(function () {
  let _state = JSON.parse(sessionStorage.getItem('fpState') || '{}');
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const pending = [];

  ws.addEventListener('open', () => {
    pending.forEach(m => ws.send(JSON.stringify(m)));
    pending.length = 0;
  });

  ws.addEventListener('message', e => {
    // Deliver incoming server → webview messages into the React message handler
    window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data) }));
  });

  window.vscodeApi = {
    postMessage(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else pending.push(msg);
    },
    getState() { return _state; },
    setState(s) {
      _state = s;
      sessionStorage.setItem('fpState', JSON.stringify(s));
    },
  };
})();
```

**Why `sessionStorage`?** The VS Code API only supports one `setState` object per webview session. `sessionStorage` matches that semantics exactly — cleared when the tab closes, persisted through refresh.

**Delivery into React:** The existing `useMessageHandler` hook listens on `window.addEventListener('message', ...)`. The shim reuses this via `dispatchEvent(new MessageEvent(...))`.

---

### Phase 2 — CSS Theme Defaults

The webview uses 50+ `--vscode-*` CSS variables. When served in a browser these are all `undefined`, causing invisible/broken UI.

**New file:** `src/server/themes/vscode-default-light.css`
**New file:** `src/server/themes/vscode-default-dark.css`

These files define every `--vscode-*` variable referenced in `tailwind.config.js` with values matching the VS Code Default Light+ and Default Dark+ themes. This is a one-time audit and copy — no build tooling required.

**Complete variable list** (derived from `tailwind.config.js` audit):

| Group | Variables |
|-------|-----------|
| Editor | `--vscode-editor-background`, `--vscode-editor-foreground` |
| Button | `--vscode-button-background`, `--vscode-button-foreground`, `--vscode-button-hoverBackground`, `--vscode-button-secondaryBackground`, `--vscode-button-secondaryForeground`, `--vscode-button-secondaryHoverBackground` |
| Input | `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, `--vscode-input-placeholderForeground` |
| Dropdown | `--vscode-dropdown-background`, `--vscode-dropdown-foreground`, `--vscode-dropdown-border` |
| List | `--vscode-list-hoverBackground`, `--vscode-list-activeSelectionBackground`, `--vscode-list-activeSelectionForeground` |
| Panel | `--vscode-panel-background`, `--vscode-panel-border`, `--vscode-sideBar-background`, `--vscode-sideBarSectionHeader-background`, `--vscode-sideBarSectionHeader-border` |
| Scrollbar | `--vscode-scrollbarSlider-background`, `--vscode-scrollbarSlider-hoverBackground`, `--vscode-scrollbarSlider-activeBackground` |
| Badge | `--vscode-badge-background`, `--vscode-badge-foreground` |
| Progress | `--vscode-progressBar-background` |
| Focus border | `--vscode-focusBorder` |
| Diff | `--vscode-diffEditor-insertedLineBackground`, `--vscode-diffEditor-removedLineBackground`, `--vscode-diffEditor-insertedTextBackground`, `--vscode-diffEditor-removedTextBackground` |
| Terminal ANSI | `--vscode-terminal-ansiGreen`, `--vscode-terminal-ansiRed`, `--vscode-terminal-ansiYellow`, `--vscode-terminal-ansiBlue`, `--vscode-terminal-ansiMagenta`, `--vscode-terminal-ansiCyan`, `--vscode-terminal-ansiWhite`, `--vscode-terminal-ansiBlack`, `--vscode-terminal-ansiBrightGreen`, `--vscode-terminal-ansiBrightRed`, `--vscode-terminal-ansiBrightYellow`, `--vscode-terminal-ansiBrightBlue`, `--vscode-terminal-ansiBrightMagenta`, `--vscode-terminal-ansiBrightCyan`, `--vscode-terminal-ansiBrightWhite`, `--vscode-terminal-ansiBrightBlack` |
| Foreground tokens | `--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-disabledForeground`, `--vscode-errorForeground`, `--vscode-icon-foreground` |
| Fonts | `--vscode-font-family`, `--vscode-font-size`, `--vscode-font-weight`, `--vscode-editor-font-family`, `--vscode-editor-font-size` |
| Codicons | `--vscode-codicon-font-path` |

**Loading strategy in the server HTML template:**

```html
<link rel="stylesheet" href="/theme/dark.css" id="theme-stylesheet">
<!-- toggled by ?theme=light / dark query param or user preference header -->
```

The server sets the theme stylesheet based on:
1. `?theme=light|dark` query parameter (explicit)
2. `prefers-color-scheme` media query hint from `Sec-CH-Prefers-Color-Scheme` header (if available)
3. Defaults to dark

---

### Phase 3 — HTTP / WebSocket Server

**New file:** `src/server/FlightPathServer.ts`

```typescript
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';

export class FlightPathServer {
  private app = express();
  private httpServer = createServer(this.app);
  private wss = new WebSocketServer({ server: this.httpServer });
  private adapter: StandaloneServerAdapter;
  private manager: FlightPathManager;

  constructor(private config: StandaloneServerConfig) {
    this.adapter = new StandaloneServerAdapter(config);
    this.manager = new FlightPathManager(this.adapter);
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupRoutes() {
    // Serve compiled React app (built by Vite with `npm run build:webview`)
    this.app.use('/assets', express.static(path.join(this.config.webviewDistDir, 'assets')));
    this.app.use('/static', express.static(path.join(this.config.webviewDistDir, 'static')));
    this.app.use('/theme', express.static(path.join(__dirname, 'themes')));

    // Main HTML — inject shim + theme, rewrite CSP for WebSocket
    this.app.get('/', (req, res) => {
      const theme = req.query.theme ?? this.detectTheme(req);
      res.send(this.buildHtml(theme));
    });
  }

  private buildHtml(theme: string): string {
    // Read the Vite-generated index.html, inject the shim, and fix up paths
    const indexHtml = fs.readFileSync(
      path.join(this.config.webviewDistDir, 'index.html'), 'utf8'
    );
    return indexHtml
      // Replace acquireVsCodeApi placeholder with WebSocket shim
      .replace('</head>',
        `<link rel="stylesheet" href="/theme/${theme}.css">
         <script src="/standalone-shim.js"></script>
         </head>`
      )
      // No CSP nonce needed in standalone mode — use a permissive policy
      // (or configure a proper nonce-free CSP for production use)
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws) => {
      // Register this connection with the adapter so it can push updates
      this.adapter.setConnection(ws);

      // Send initial state (equivalent to extension sending INIT message on webview ready)
      this.adapter.sendInitialState();

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        // Route webview → server messages into FlightPathManager (same as WebviewMessageRouter)
        this.handleWebviewMessage(msg);
      });

      ws.on('close', () => this.adapter.clearConnection());
    });
  }
}
```

---

### Phase 4 — StandaloneServerAdapter

**New file:** `src/server/StandaloneServerAdapter.ts`

Implements `PlatformAdapter` (reuses the existing interface) and adds server-specific plumbing.

```typescript
import type { WebSocket } from 'ws';
import type { PlatformAdapter } from '../platform/PlatformAdapter';

export class StandaloneServerAdapter implements PlatformAdapter {
  private ws: WebSocket | null = null;

  constructor(private config: StandaloneServerConfig) {}

  // PlatformAdapter implementation
  getConfig<T>(key: string, defaultValue: T): T {
    return (this.config.settings as any)[key] ?? defaultValue;
  }

  getWorkspaceRoot(): string {
    return this.config.cwd ?? process.cwd();
  }

  log(message: string): void { console.log(message); }
  warn(message: string): void { console.warn(message); }
  error(message: string): void { console.error(message); }
  showProgress(message: string): void { console.log(`[progress] ${message}`); }

  async showChoice(message: string, ...options: string[]): Promise<string | undefined> {
    // Headless: return undefined (no interactive prompt in server mode)
    return undefined;
  }

  getExtensionPath(): string {
    return path.dirname(require.main!.filename);
  }

  isVsCode(): boolean { return false; }

  // Server-specific: push messages to the connected browser
  setConnection(ws: WebSocket) { this.ws = ws; }
  clearConnection() { this.ws = null; }

  sendToWebview(message: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendInitialState() {
    // Sends the same INIT message that FlightPathWebviewProvider sends on ready
    // Reuses the existing WebviewSettingsSync.buildInitPayload() if exposed,
    // otherwise duplicates minimally
  }
}
```

---

### Phase 5 — WebSocket Message Router

**New file:** `src/server/WebSocketMessageRouter.ts`

Mirrors `src/ui/WebviewMessageRouter.ts` but for WebSocket connections. Handles the same set of webview → extension message types (RUN_WORKFLOW, PAUSE_WORKFLOW, etc.) and delegates to `FlightPathManager`.

This is the only significant new file beyond thin adapters. It can extend or delegate to the existing `WebviewMessageRouter` once that class is refactored to be platform-agnostic (optional — see Phase 7).

---

### Phase 6 — CLI Integration

Add a `server` command to the existing CLI binary:

```
flightpath server [options]
  --port <port>       Port to listen on (default: 3000)
  --cwd <dir>         Workspace root directory
  --theme <light|dark> Default theme (default: dark)
  --open              Open browser automatically
```

**New file:** `src/cli/ServerCommand.ts`

Instantiates `FlightPathServer` with config resolved from CLI args + env vars. Uses existing `CliAdapter` pattern.

---

### Phase 7 — Optional: Decouple WebviewMessageRouter (Refactor)

Currently `WebviewMessageRouter` is tightly coupled to `vscode.WebviewView`. If we extract a `IWebviewMessageRouter` interface and inject a `sendToWebview` callback, both the VS Code provider and the standalone server can share the same routing logic.

This is a clean-architecture improvement but not required for the initial implementation — the standalone server can have its own router that duplicates the dispatch logic.

**Defer this to after Phase 1–6 are working.**

---

## File Structure

```
src/server/
├── FlightPathServer.ts         ← HTTP + WebSocket server
├── StandaloneServerAdapter.ts  ← PlatformAdapter impl for server mode
├── WebSocketMessageRouter.ts   ← Handles webview → server messages
├── standalone-shim.js          ← Browser-side VS Code API shim (static file)
└── themes/
    ├── vscode-default-dark.css  ← Full --vscode-* variable definitions (dark)
    └── vscode-default-light.css ← Full --vscode-* variable definitions (light)

src/cli/ServerCommand.ts        ← `flightpath server` CLI command
```

---

## CSS Theme File Strategy

Each theme file follows this structure:

```css
/* vscode-default-dark.css — Default Dark+ equivalent */
:root {
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-button-background: #0e639c;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #1177bb;
  /* ... all 50+ variables ... */

  /* Codicon font path (served statically) */
  --vscode-codicon-font-path: url('/static/codicon.ttf');
}
```

VS Code's Default Light+ and Default Dark+ color values are well-documented in the VS Code source (`src/vs/platform/theme/common/colorRegistry.ts`). Values will be sourced directly from there to guarantee accuracy.

**Theme switching:** A small `<select>` or toggle button can be added to the server-rendered HTML (outside the React app) to switch themes by reloading with `?theme=light|dark`. Alternatively, we can dispatch a CSS class change to `document.body` and have themes scoped to `.theme-light` / `.theme-dark` selectors.

---

## Codicon Font

VS Code codiconss are bundled as a webfont. The React app already copies `codicon.ttf` to `dist/static/` via the Vite config. The standalone server needs to serve this file and update `--vscode-codicon-font-path` to point to `/static/codicon.ttf` (already correct from the Vite build output).

---

## Dependencies

Minimal new dependencies:

| Package | Purpose | Already present? |
|---------|---------|-----------------|
| `express` | HTTP server | No — add |
| `ws` | WebSocket server | No — add |
| `@types/ws` | TypeScript types | No — add |
| `@types/express` | TypeScript types | No — add |

All are small, well-maintained packages with no significant supply-chain risk. `express` and `ws` are the de-facto standard for this pattern in Node.js.

---

## Build Changes

### Vite Config (no changes needed)

The existing `vite.config.ts` already outputs:
- Predictable asset names (no hashes)
- Static file copies (codicons, dictionaries)
- Source maps

The server simply serves the existing `out/webview/` (or wherever the Vite build outputs) directory.

### package.json — new script

```json
"server": "node out/server/FlightPathServer.js"
```

### esbuild — server bundle

The server entry point needs to be bundled separately from the extension. Add a build target to `esbuild.config.js`:

```javascript
{
  entryPoints: ['src/server/FlightPathServer.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'out/server/FlightPathServer.js',
  external: ['express', 'ws'], // keep node_modules external for server
}
```

---

## Message Protocol Compatibility

The existing message protocol is fully compatible with WebSocket transport. No changes needed to:
- `src/types/DashboardConstants.ts` (MESSAGE_TYPES)
- `src/types/WebviewMessageTypes.ts` (payload types)
- Any React component, hook, or store

The only change is **transport**: `vscode.postMessage` → `ws.send` (handled entirely by the shim).

---

## State Persistence

| VS Code mechanism | Standalone replacement |
|-------------------|----------------------|
| `vscode.setState()` | `sessionStorage.setItem('fpState', ...)` |
| `vscode.getState()` | `sessionStorage.getItem('fpState')` |

The shim in Phase 1 already handles this. No changes to `uiStore.ts` or `editorStore.ts`.

---

## Security Considerations

- **Localhost only by default**: Bind to `127.0.0.1` unless `--host` is explicitly passed
- **No authentication in v1**: This is a developer tool, not a multi-user server
- **CORS**: Restrict to same-origin (default Express behavior)
- **WebSocket origin check**: Validate `Origin` header matches `localhost:<port>`
- **No eval / dynamic code**: The shim uses `JSON.parse`, not `eval`
- **CSP for standalone mode**: Relax `script-src` to allow inline scripts (needed for the shim), but set `connect-src ws://localhost:<port>` explicitly

---

## Completions and Document Links in Standalone Mode

### Background

`CompletionHelpers.ts` powers three completion types triggered in the CodeMirror prompt editor:

| Trigger | Source | VS Code API used |
|---------|--------|-----------------|
| `@path` | File/directory completions | `vscode.workspace.findFiles`, `vscode.workspace.asRelativePath`, Git extension for gitignore |
| `#symbol` | Workspace symbol completions | `vscode.executeWorkspaceSymbolProvider` (LSP) |
| `#selection:` | Current editor selections | `vscode.window.visibleTextEditors` |

`PromptLinkProvider.ts` provides Ctrl+Click navigation for those same references — but only for `.prompt.md` / `.flightpath.yaml` files opened in the VS Code text editor. The CodeMirror editor in the webview has its own separate link detection that is already pure client-side JS.

### What the Webview CodeMirror Already Does

The CodeMirror editor calls completions via the existing WebSocket/postMessage bridge — it sends a completion request message, the server responds with a list. Link detection in CodeMirror is regex-based and has no VS Code dependency. **Both work transparently in standalone mode once the server has a completions endpoint.**

### File and Directory Completions

**Replacement:** Node.js `fs` + `fast-glob` + `ignore` npm packages.

```
npm install fast-glob ignore
```

The server exposes a REST endpoint (or handles a WebSocket message):

```
GET /api/completions/files?q=<filter>
→ returns PlainCompletionItem[]
```

Server-side implementation in `src/server/CompletionService.ts`:

```typescript
import fg from 'fast-glob';
import ignore from 'ignore';
import fs from 'fs';
import path from 'path';

export class CompletionService {
  private ig = ignore();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    // Load .gitignore if present
    const gitignorePath = path.join(cwd, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      this.ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    }
  }

  async getFiles(filterText: string): Promise<PlainCompletionItem[]> {
    const allFiles = await fg('**/*', {
      cwd: this.cwd,
      dot: false,
      ignore: ['.git/**'],
      onlyFiles: false,   // include dirs too
      markDirectories: true,
    });

    const filtered = allFiles
      .filter(f => !this.ig.ignores(f))
      .filter(f => !filterText || f.toLowerCase().includes(filterText.toLowerCase()));

    return buildCompletionItems(filtered); // same logic as CompletionHelpers.getFileCompletions
  }
}
```

**Gitignore filtering:** The VS Code version uses the Git extension's `checkIgnore()` batch API. The `ignore` package is the standard Node.js replacement — it parses `.gitignore` syntax identically. One limitation: nested `.gitignore` files inside subdirectories. We handle this by scanning for all `.gitignore` files in the workspace and loading each one with the correct base path, matching how `fast-glob`'s built-in `ignore` option works.

**`PlainCompletionItem` is already framework-agnostic** — it was designed this way (`CompletionHelpers.ts` line 14). The same type can be serialized over WebSocket directly. No changes needed to the type or to the CodeMirror completion source in the webview.

### Symbol Completions

Symbol completions use `vscode.executeWorkspaceSymbolProvider`, which calls all registered Language Server Protocol providers. Outside VS Code, there is no built-in equivalent.

**Bundling all language servers is a non-starter** — FlightPath users work across TypeScript, Python, Go, Rust, Ruby, Java, C#, and more. Any single-language AST approach (e.g. TypeScript Compiler API) would deliver zero value for everyone else. The options that actually work across languages:

| Option | Fidelity | Effort | Multi-language? |
|--------|----------|--------|----------------|
| **A. Smart regex heuristic** — scan source files for declaration keywords per extension | ~60% of LSP coverage | Low | Yes — pattern table is extensible |
| **B. User-supplied LSP** — user points to an existing language server binary; we speak LSP stdio protocol | Same as VS Code | Medium | Yes — any LSP server works |
| **C. Omit entirely** — return empty array | None | Zero | N/A |

**Recommendation: Option A (smart regex) as the default, with Option B as an opt-in for users who already run a language server.**

This pairing means symbol completions work out of the box for common patterns, and power users who need full fidelity can wire in their own LSP without FlightPath shipping or managing any language servers.

#### Option A — Smart Regex Heuristic

Scan source files for top-level declaration patterns keyed by file extension. Results are cached per file by `mtime` — only changed files are rescanned.

```typescript
// src/server/CompletionService.ts
const SYMBOL_PATTERNS: Record<string, RegExp> = {
  // JS / TS family
  ts:   /^(?:export\s+)?(?:(?:abstract|default)\s+)?(?:class|function\*?|const|let|var|interface|type|enum|namespace|module)\s+(\w+)/gm,
  tsx:  /^(?:export\s+)?(?:(?:abstract|default)\s+)?(?:class|function\*?|const|let|var|interface|type|enum)\s+(\w+)/gm,
  js:   /^(?:export\s+)?(?:class|function\*?|const|let|var)\s+(\w+)/gm,
  mjs:  /^(?:export\s+)?(?:class|function\*?|const|let|var)\s+(\w+)/gm,
  // Python
  py:   /^(?:class|def|async\s+def)\s+(\w+)/gm,
  // Go
  go:   /^(?:func(?:\s+\([^)]+\))?\s+|type\s+|var\s+|const\s+)(\w+)/gm,
  // Rust
  rs:   /^(?:pub\s+)?(?:fn|struct|enum|trait|impl|type|const|static|mod)\s+(\w+)/gm,
  // Ruby
  rb:   /^(?:class|module|def)\s+(\w+)/gm,
  // Java / Kotlin / C#
  java: /^(?:public\s+|private\s+|protected\s+|static\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/gm,
  kt:   /^(?:(?:data|sealed|abstract|open|inner)\s+)?(?:class|object|interface|fun|val|var)\s+(\w+)/gm,
  cs:   /^(?:(?:public|private|protected|internal|static|abstract|sealed)\s+)*(?:class|interface|enum|struct|record|delegate|void|\w+)\s+(\w+)\s*[({]/gm,
  // C / C++
  c:    /^(?:\w[\w\s*]+)\s+(\w+)\s*\(/gm,
  cpp:  /^(?:\w[\w\s*:]+)\s+(\w+)\s*\(/gm,
  // PHP
  php:  /^(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum|function)\s+(\w+)/gm,
  // Swift
  swift:/^(?:(?:public|private|internal|open|fileprivate)\s+)?(?:class|struct|enum|protocol|func|var|let|extension|typealias)\s+(\w+)/gm,
};
```

Results from a scan:
```typescript
interface SymbolMatch {
  name: string;
  file: string;  // workspace-relative path
  line: number;
  kind: string;  // "class" | "function" | "const" etc — extracted from the keyword match
}
```

The regex approach never requires any additional dependencies and works identically across all languages in the table. New extensions can be added to the pattern table without touching any other code.

#### Option B — User-Supplied Language Server (LSP stdio)

For users who want full-fidelity completions and already run a language server (e.g. `typescript-language-server`, `pyright`, `rust-analyzer`, `gopls`), the standalone server can act as a minimal LSP client over stdio.

**Configuration (in `flightpath server` CLI or a config file):**

```yaml
# .flightpath/server.config.yaml
symbolLanguageServer:
  command: "typescript-language-server"
  args: ["--stdio"]
  # OR
  command: "pyright-langserver"
  args: ["--stdio"]
```

**Server-side LSP client** (`src/server/LspSymbolClient.ts`):
- Spawns the configured process via `child_process.spawn`
- Sends LSP `initialize` → `workspace/symbol` requests over stdio
- Parses the JSON-RPC response and maps `SymbolInformation[]` → `PlainCompletionItem[]`
- Falls back to Option A regex results if the LSP process is unavailable

This keeps FlightPath completely agnostic about which language server is used. The user brings their own; FlightPath just speaks the standard protocol.

**LSP client dependency:** The `vscode-jsonrpc` npm package handles the JSON-RPC framing. It is already part of the VS Code ecosystem, well-maintained, and has no VS Code runtime dependency.

```
npm install vscode-jsonrpc
```

**Updated file structure:**

```
src/server/
├── CompletionService.ts     ← Orchestrates both options; regex is default
├── LspSymbolClient.ts       ← NEW: LSP stdio client for user-supplied servers
```

`CompletionService` checks config at startup: if a language server command is configured, instantiate `LspSymbolClient`; otherwise fall back to the regex scanner. Both implement a shared `ISymbolProvider` interface so they are swappable.

### Selection Completions

`getSelectionCompletions()` returns the currently selected text in VS Code editors. **This concept does not exist in a browser context** — there is no "currently open file" on the server, and the user's cursor is inside the CodeMirror editor itself.

**Decision: Omit in standalone mode.** The server returns an empty array for selection completions. The `#selection:` syntax is still fully supported — users can type it manually or paste a path. The only loss is the autocomplete shortcut that pre-fills the current selection range.

If we wanted to support this in a future iteration, we could let the user explicitly select text in CodeMirror and expose a "copy as #selection reference" button — but that is a UX redesign, not a simple port.

### PromptLinkProvider

`PromptLinkProvider` is a `vscode.DocumentLinkProvider` registered for `.prompt.md` / `.flightpath.yaml` files in the VS Code text editor. It is **not used by the CodeMirror editor in the webview**.

The CodeMirror prompt editor already has its own link detection (pure client-side regex). This continues to work identically in standalone mode.

`PromptLinkProvider` as a VS Code class is simply irrelevant outside VS Code. **No action needed.**

### Updated File Structure

```
src/server/
├── FlightPathServer.ts
├── StandaloneServerAdapter.ts
├── WebSocketMessageRouter.ts
├── CompletionService.ts          ← NEW: file/dir/symbol completions (no VS Code)
├── standalone-shim.js
└── themes/
    ├── vscode-default-dark.css
    └── vscode-default-light.css
```

### Updated Dependencies

| Package | Purpose | Already present? |
|---------|---------|-----------------|
| `express` | HTTP server | No — add |
| `ws` | WebSocket server | No — add |
| `fast-glob` | Filesystem file enumeration | No — add |
| `ignore` | `.gitignore` parsing | No — add |
| `vscode-jsonrpc` | JSON-RPC framing for optional LSP client | No — add |
| `@types/ws` | TypeScript types | No — add |
| `@types/express` | TypeScript types | No — add |

`vscode-jsonrpc` is only loaded if the user configures a language server — import it lazily in `LspSymbolClient.ts` so it never adds to startup time when unused.

---

## Implementation Order

1. **Theme CSS files** — Audit all `--vscode-*` vars, create both theme files (2–3 hours)
2. **Shim** — `standalone-shim.js`, test in browser with a mock WS (1 hour)
3. **StandaloneServerAdapter** — Implement PlatformAdapter (2 hours)
4. **FlightPathServer** — HTTP + WS, serve built webview, inject shim (3 hours)
5. **WebSocketMessageRouter** — Wire webview messages to FlightPathManager (4 hours)
6. **CompletionService** — File/dir completions with fast-glob + ignore; multi-language regex symbol heuristic (3 hours)
6a. **LspSymbolClient** _(optional)_ — LSP stdio client for user-supplied language servers (2 hours)
7. **CLI ServerCommand** — `flightpath server` command (1 hour)
8. **Manual testing** — Run a workflow from the browser, verify UI state, completions, theme switching (2 hours)

Total: ~18 hours of implementation work.

---

## Open Questions

1. **Multi-tab support**: VS Code's `acquireVsCodeApi()` can only be called once. The shim doesn't have this restriction, so multiple browser tabs would each get their own WebSocket connection. The server should support this gracefully (separate state per connection) or explicitly reject second connections.

2. **File open/save dialogs**: VS Code provides file pickers. In standalone mode, `openTextFile` is a no-op. Should we wire this to a simple file path input, or leave it as unsupported?

3. **WebSocket reconnection**: If the server restarts, the shim should attempt to reconnect and re-request state. Add exponential backoff reconnect logic to the shim.

4. **Hot reload / watch mode**: During development of the server itself, integrating with `vite dev` proxy could provide HMR. This is a developer quality-of-life item, not required for MVP.

5. **Symbol completion fidelity**: The regex heuristic misses re-exported symbols, dynamic declarations, and decorator-wrapped classes. Users who need full fidelity can configure an LSP server — `LspSymbolClient.ts` is the only file involved. No changes to `CompletionService` or any other layer are needed when adding a new language server option.

6. **Nested .gitignore files**: The `ignore` package needs a separate instance per directory to correctly resolve nested `.gitignore` files. The MVP can scan for all `.gitignore` files at startup and merge them at the root level — this is slightly over-aggressive (may keep some ignored files) but never incorrectly hides a tracked file.
