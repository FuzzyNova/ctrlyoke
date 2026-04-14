# Developer Restart & Auto-Rebuild from Browser Dashboard

## Problem

When developing FlightPath using the browser dashboard (hosted server), changes to extension source code require:

1. Running `npm run compile` to rebuild
2. Restarting the VS Code Extension Host for changes to take effect
3. Any in-flight workflows get killed when the extension host restarts

There is no way to trigger this rebuild + restart cycle from the browser dashboard context.

## Research Findings

### VS Code Extension Host Restart Mechanisms

| Mechanism                  | Command ID                              | Works from Extension? | Preserves In-Flight Work? | Notes                                                             |
| -------------------------- | --------------------------------------- | --------------------- | ------------------------- | ----------------------------------------------------------------- |
| **Reload Window**          | `workbench.action.reloadWindow`         | ✅ Yes                | ❌ No                     | Full window reload; kills all extension state; simplest approach  |
| **Restart Extension Host** | `workbench.action.restartExtensionHost` | ⚠️ Limited            | ❌ No                     | May not exist in all VS Code versions; essentially same as reload |
| **Dynamic Config Reload**  | N/A (custom)                            | ⚠️ Partial            | ✅ Partial                | Only re-reads settings; doesn't pick up code changes              |

**Conclusion:** `workbench.action.reloadWindow` is the most reliable and universal mechanism. It reloads the entire VS Code window, which reinitializes all extensions. However, **it kills all in-flight state** — the extension host process is terminated.

### Build from Browser Context

The browser dashboard has no direct filesystem access or Node.js runtime. To trigger `npm run compile`, the extension itself must execute the build command on behalf of the browser client via WebSocket message routing.

### In-Flight Workflow Preservation

Since the extension host process is killed on reload, in-flight CLI sessions and workflow state **will be lost**. However, FlightPath already has infrastructure that can mitigate this:

- **`resumeSession`** prompt property — CLI harnesses support session resumption
- **`.flightpath/.queue/`** working files — runtime state is persisted to disk
- **WorkflowInstance restoration** — on activation, the extension can reload workflow state from disk

**Key insight:** If the extension saves workflow state to disk before the reload is triggered, and the harnesses support session resumption (they do for CLI harnesses), the workflows can potentially pick up where they left off after restart.

## Proposed Implementation

### 1. Add "Developer" Tab to Global Settings

Add a new tab to `GlobalSettingsDrawer.tsx` that is **only visible in dev mode**:

```typescript
// In GlobalSettingsDrawer.tsx
const TABS = [
  // ... existing tabs
  { id: "server", label: "Server", icon: "codicon-cloud" },
  // DEV-ONLY tab, conditionally rendered:
  { id: "developer", label: "Developer", icon: "codicon-tools" },
];
```

The tab is conditionally rendered based on a `devMode` flag passed from the extension via `MESSAGE_TYPES.INITIAL_STATE` or a dedicated `DEV_MODE_DETECTED` message.

### 2. Developer Tab UI

The Developer tab contains:

```tsx
function DeveloperSection({ settings, onUpdate }) {
  const vscode = useVsCodeApi();

  function handleRebuildAndRestart() {
    vscode.postMessage({ type: MESSAGE_TYPES.DEV_REBUILD_AND_RESTART });
  }

  function handleRebuildOnly() {
    vscode.postMessage({ type: MESSAGE_TYPES.DEV_REBUILD_ONLY });
  }

  function handleRestartOnly() {
    vscode.postMessage({ type: MESSAGE_TYPES.DEV_RESTART_EXTENSION_HOST });
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">Developer Tools</h2>
      <p className="text-sm text-description-fg">
        These tools are only available in development mode. They allow you to
        rebuild and restart the extension host from the browser dashboard.
      </p>

      {/* Rebuild + Restart */}
      <div className="p-4 rounded border border-panel-border bg-panel-bg">
        <h3 className="font-medium">Rebuild &amp; Restart Extension Host</h3>
        <p className="text-sm text-description-fg mt-1">
          Runs <code className="text-code-fg">npm run compile</code>, then
          reloads the VS Code window.{" "}
          <strong className="text-error-fg">
            Warning: This will terminate any in-flight workflows.
          </strong>
        </p>
        <button
          className="mt-3 px-4 py-2 rounded bg-btn-primary-bg text-btn-primary-fg hover:bg-btn-primary-hover"
          onClick={handleRebuildAndRestart}
        >
          Rebuild &amp; Restart
        </button>
      </div>

      {/* Rebuild Only */}
      <div className="p-4 rounded border border-panel-border bg-panel-bg">
        <h3 className="font-medium">Rebuild Only (Extension Only)</h3>
        <p className="text-sm text-description-fg mt-1">
          Runs <code className="text-code-fg">npm run compile:extension</code>{" "}
          (skips webview rebuild). Useful when only changing extension code.
        </p>
        <button
          className="mt-3 px-4 py-2 rounded bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover border border-btn-border"
          onClick={handleRebuildOnly}
        >
          Rebuild Extension
        </button>
      </div>

      {/* Restart Only */}
      <div className="p-4 rounded border border-panel-border bg-panel-bg">
        <h3 className="font-medium">Restart Extension Host</h3>
        <p className="text-sm text-description-fg mt-1">
          Reloads the VS Code window without rebuilding. Useful after manual
          builds.{" "}
          <strong className="text-error-fg">
            Warning: This will terminate any in-flight workflows.
          </strong>
        </p>
        <button
          className="mt-3 px-4 py-2 rounded bg-btn-secondary-bg text-btn-secondary-fg hover:bg-btn-secondary-hover border border-btn-border"
          onClick={handleRestartOnly}
        >
          Restart Extension Host
        </button>
      </div>

      {/* Optional: Save workflow state before restart */}
      <div className="flex items-center gap-2 mt-4">
        <input type="checkbox" id="preserveState" defaultChecked />
        <label htmlFor="preserveState" className="text-sm">
          Attempt to preserve workflow state before restart
        </label>
      </div>
    </div>
  );
}
```

### 3. Extension-Side Message Handler

In `WebviewMessageRouter.ts` or `FlightPathWebviewProvider.ts`, handle the new message types:

```typescript
case MESSAGE_TYPES.DEV_REBUILD_AND_RESTART:
  await this.handleDevRebuildAndRestart();
  break;
case MESSAGE_TYPES.DEV_REBUILD_ONLY:
  await this.handleDevRebuild();
  break;
case MESSAGE_TYPES.DEV_RESTART_EXTENSION_HOST:
  await this.handleDevRestartExtensionHost();
  break;
```

Implementation:

```typescript
// In FlightPathWebviewProvider or a dedicated DevToolsHandler class

private async handleDevRebuildAndRestart(): Promise<void> {
  // 1. Signal all browser clients that a restart is imminent
  this.postMessage({ type: MESSAGE_TYPES.DEV_RESTARTING });

  // 2. Save workflow state to disk (best-effort)
  await this.saveWorkflowStateToDisk();

  // 3. Run npm run compile
  const { exec } = require('child_process');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  await new Promise<void>((resolve, reject) => {
    exec('npm run compile', { cwd: workspaceRoot, timeout: 120_000 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });

  // 4. Reload the window (this kills the extension host)
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

private async handleDevRebuild(): Promise<void> {
  // Same as above but skip the reload step
  this.postMessage({ type: MESSAGE_TYPES.DEV_BUILD_STARTED });
  // ... run npm run compile ...
  this.postMessage({ type: MESSAGE_TYPES.DEV_BUILD_COMPLETED, success: true });
}

private async handleDevRestartExtensionHost(): Promise<void> {
  // Save state, then reload
  this.postMessage({ type: MESSAGE_TYPES.DEV_RESTARTING });
  await this.saveWorkflowStateToDisk();
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
```

### 4. Workflow State Preservation (Best-Effort)

Before triggering the reload:

1. **Persist WorkflowInstance state** — Write each active workflow's `PromptQueue` state, `WorkflowStateMachine` status, and `currentIndex` to `.flightpath/.queue/<workflowId>/state.json`
2. **Signal browser clients** — Send `DEV_RESTARTING` message so the browser UI shows a "Reconnecting..." state
3. **On extension re-activation** — In `extension.ts` `activate()`, check for saved state files and restore workflows:
   - Re-create `WorkflowInstance` from saved state
   - Re-attach to existing CLI sessions if the CLI processes survived the extension host kill (they likely won't, but harnesses already handle this via log-file-based session discovery)
   - Send `MESSAGE_TYPES.WORKFLOW_STATE_RESTORED` to browser clients

### 5. New Message Types (add to `DashboardConstants.ts`)

```typescript
// Browser → Extension (dev only)
DEV_REBUILD_AND_RESTART: "dev:rebuildAndRestart",
DEV_REBUILD_ONLY: "dev:rebuildOnly",
DEV_RESTART_EXTENSION_HOST: "dev:restartExtensionHost",

// Extension → Browser (dev only)
DEV_RESTARTING: "dev:restarting",
DEV_BUILD_STARTED: "dev:buildStarted",
DEV_BUILD_COMPLETED: "dev:buildCompleted",
DEV_MODE_DETECTED: "dev:modeDetected",
```

### 6. Dev Mode Detection

The extension already has `IS_DEV_MODE` from `BuildConfig.ts`. Forward this to the webview:

```typescript
// In FlightPathWebviewProvider, during initialization:
if (IS_DEV_MODE) {
  this.postMessage({ type: MESSAGE_TYPES.DEV_MODE_DETECTED });
}
```

The webview stores this in a Zustand store flag (`uiStore.devMode`) and conditionally renders the Developer tab.

### 7. File Changes Required

| File                                                              | Change                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `src/types/DashboardConstants.ts`                                 | Add 7 new message types                               |
| `src/types/WebviewMessageTypes.ts`                                | Add new message type declarations                     |
| `src/ui/webview-react/store/uiStore.ts`                           | Add `devMode` boolean state                           |
| `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx` | Add conditional Developer tab                         |
| `src/ui/webview-react/components/settings/DeveloperSection.tsx`   | New component (UI for dev tools)                      |
| `src/ui/WebviewMessageRouter.ts`                                  | Add 3 new message handlers                            |
| `src/ui/FlightPathWebviewProvider.ts`                             | Add `handleDev*` methods, `saveWorkflowStateToDisk()` |
| `src/extension.ts`                                                | Restore workflow state on activation (if saved)       |
| `src/utils/BuildConfig.ts`                                        | Export `IS_DEV_MODE` for use in provider              |

### 8. Browser Client UX During Restart

When `DEV_RESTARTING` is received:

1. Show a full-screen overlay: "Extension host is restarting. Reconnecting…"
2. WebSocket will disconnect (extension host dies)
3. Browser client attempts to reconnect to `/ws` on a loop with exponential backoff
4. On reconnect, client requests initial state (already implemented via `sendInitialState`)
5. Overlay dismissed once state is restored

### 9. Limitations & Risks

- **In-flight CLI processes WILL be killed** — the `node-pty` sessions and child processes are children of the extension host process. No way around this.
- **Harness session resumption** — CLI harnesses that use log-file monitoring (copilot-cli, qwen-cli, etc.) may be able to detect that a CLI session was interrupted and offer to resume from the log tail. This is a follow-up enhancement.
- **Only for dev use** — This is intentionally a developer-only feature. It should be gated behind `IS_DEV_MODE` checks and hidden from production builds via esbuild dead code elimination.
- **npm must be available** — The `npm run compile` execution assumes the workspace root has a valid `node_modules` and npm installed. This is always true for the FlightPath workspace during development.

### 10. Future Enhancements (Out of Scope for This Task)

- **HMR for webview** — Vite dev server with HMR already works for the webview; no restart needed for UI changes.
- **Extension watch mode** — `npm run watch:extension` (esbuild --watch) rebuilds on save, but still requires extension host reload for changes to take effect.
- **Graceful CLI process handoff** — If CLI processes could be orphaned and re-adopted by the new extension host instance, in-flight workflows could truly survive a restart. This would require a process supervisor/daemon architecture.

## Implementation Order

1. **Phase 1 (Core):** Add dev mode detection, message types, and the Developer tab with "Restart Extension Host" button
2. **Phase 2 (Build integration):** Add "Rebuild Only" and "Rebuild & Restart" buttons with `child_process.exec` for `npm run compile`
3. **Phase 3 (State preservation):** Implement best-effort workflow state save/restore so workflows can resume after restart
4. **Phase 4 (Browser UX):** Add reconnect overlay and backoff logic in the browser client
