# Developer Rebuild & Restart from Browser Dashboard

## Problem

When developing FlightPath from the hosted browser dashboard, extension source changes still require a local developer loop:

1. Run a build command, usually `npm run compile:extension` or `npm run compile`.
2. Restart or reload VS Code so the Extension Development Host loads the new `out/` bundle.
3. Reopen or reconnect the dashboard.

The hosted browser dashboard cannot run `npm` directly. It must send a WebSocket message to the extension host, and the extension host must run the build and trigger the VS Code restart/reload command.

Restarting or reloading the extension host is expected to terminate active FlightPath workflows, PTY sessions, and CLI child processes. This feature is a developer convenience, not a workflow-resume feature.

## Current Repo Facts

- Browser dashboard messages already flow through `FlightPathHostedServer` -> `FlightPathWebviewProvider.routeExternalMessage()` -> `WebviewMessageRouter`.
- `WebviewMessageRouter` already handles both VS Code panel messages and hosted browser messages using scoped `postMessage` and `clientTag`.
- `IS_DEV_MODE` already exists in `src/utils/BuildConfig.ts`.
- Dev commands are registered only under the `IS_DEV_MODE` guard in `src/extension.ts`.
- `npm run compile:extension` and `npm run compile` both exist in `package.json`.
- `WorkflowOrchestrator.saveState()` intentionally clears stale persisted workflow state, and `restoreState()` is a no-op. Running/paused workflows are not meaningfully restorable after the extension host terminates.
- Working files under `.flightpath/.queue/` persist queue data and runtime fields for history/manual reload, but they are not an in-flight process handoff mechanism.

## Research Findings

### VS Code Commands

The generated command reference `dev/reference/VSCODE_COMMANDS.md` includes both restart-related commands:

- `workbench.action.reloadWindow`
- `workbench.action.restartExtensionHost`

Use them differently:

| Action | Command ID | Role | Notes |
| --- | --- | --- | --- |
| Reload Window | `workbench.action.reloadWindow` | Default restart path | Most reliable dev workflow. Reloads the VS Code window and reactivates extensions from disk. |
| Restart Extension Host | `workbench.action.restartExtensionHost` | Optional fast path | Available in the captured command list, but still verify at runtime with `vscode.commands.getCommands(false)` before showing or invoking it. |
| Reload With Extensions Disabled | `workbench.action.reloadWindowWithExtensionsDisabled` | Do not use | This disables extensions and is not useful for FlightPath development. |

The default "Rebuild & Reload" action should run the build and then call `workbench.action.reloadWindow`. A separate "Restart Extension Host" action can be offered only when `workbench.action.restartExtensionHost` is present.

### Build from Browser Context

The browser dashboard has no direct filesystem access or Node.js runtime. To trigger `npm run compile`, the extension itself must execute the build command on behalf of the browser client via WebSocket message routing.

### In-Flight Workflow Preservation

Do not implement preservation in this feature.

Since the extension host process is killed or restarted, in-flight CLI sessions and workflow state will be lost. This is expected and acceptable for developer restart tooling.

Do not add `.flightpath/.queue/<workflowId>/state.json`, startup restoration, process handoff, or any promise that workflows can continue automatically after restart.

## Proposed Implementation

### 1. Add Dev Message Types

Add shared constants in `src/types/DashboardConstants.ts`.

Browser/panel -> extension:

```typescript
DEV_BUILD_EXTENSION: "dev:buildExtension",
DEV_BUILD_ALL: "dev:buildAll",
DEV_RELOAD_WINDOW: "dev:reloadWindow",
DEV_RESTART_EXTENSION_HOST: "dev:restartExtensionHost",
DEV_BUILD_EXTENSION_AND_RELOAD: "dev:buildExtensionAndReload",
DEV_BUILD_ALL_AND_RELOAD: "dev:buildAllAndReload",
DEV_REQUEST_STATUS: "dev:requestStatus",
```

Extension -> browser/panel:

```typescript
DEV_STATUS: "dev:status",
DEV_BUILD_STARTED: "dev:buildStarted",
DEV_BUILD_OUTPUT: "dev:buildOutput",
DEV_BUILD_COMPLETED: "dev:buildCompleted",
DEV_RESTARTING: "dev:restarting",
DEV_COMMAND_UNAVAILABLE: "dev:commandUnavailable",
```

Add matching message declarations in `src/types/WebviewMessageTypes.ts`.

### 2. Dev Mode and Command Availability

Prefer including developer state in the existing `INIT` payload rather than adding a separate `DEV_MODE_DETECTED` message.

Suggested `INIT` addition:

```typescript
dev?: {
  enabled: boolean;
  buildDate: string;
  commands: {
    reloadWindow: boolean;
    restartExtensionHost: boolean;
  };
};
```

The extension should compute command availability with:

```typescript
const commands = await vscode.commands.getCommands(false);
const restartExtensionHostAvailable = commands.includes(
  "workbench.action.restartExtensionHost"
);
const reloadWindowAvailable = commands.includes("workbench.action.reloadWindow");
```

Only send `dev.enabled: true` when `IS_DEV_MODE` is true. Server-side handlers must still enforce this guard even if the UI is hidden.

### 3. Add "Developer" Tab to Global Settings

Add a new tab to `GlobalSettingsDrawer.tsx` that is only visible when `dev.enabled` is true.

Controls:

- **Rebuild Extension**: runs `npm run compile:extension`.
- **Rebuild All**: runs `npm run compile`.
- **Reload Window**: calls `workbench.action.reloadWindow`.
- **Rebuild Extension & Reload**: runs `npm run compile:extension`, then `workbench.action.reloadWindow`.
- **Rebuild All & Reload**: runs `npm run compile`, then `workbench.action.reloadWindow`.
- **Restart Extension Host**: calls `workbench.action.restartExtensionHost`, only if the command is available at runtime.

Every restart/reload action must show explicit copy that active workflows, PTY sessions, and CLI processes will be terminated.

Add the UI in:

```text
src/ui/webview-react/components/settings/DeveloperSection.tsx
```

Follow existing Global Settings section patterns:

- Use Tailwind tokens from `tailwind.config.js`.
- Use the shared `Button` component if it fits existing settings sections.
- Do not nest cards inside cards.
- Show build output in a scrollable preformatted region.
- Disable build/restart buttons while a build is running.
- Hide or disable "Restart Extension Host" when `dev.commands.restartExtensionHost` is false.

### 4. Add Dev Dashboard Action Handler

Add the build/restart implementation to `src/dev/DevCommands.ts` rather than creating another file under `src/dev/`. The repo's dev instructions keep development-only command logic centralized there.

Export a helper from `DevCommands.ts` and import it dynamically behind the `IS_DEV_MODE` guard so production builds can strip dev-only logic.

Suggested API:

```typescript
export type DevDashboardAction =
  | "buildExtension"
  | "buildAll"
  | "reloadWindow"
  | "restartExtensionHost"
  | "buildExtensionAndReload"
  | "buildAllAndReload";

export interface DevDashboardActionOptions {
  context: vscode.ExtensionContext;
  postMessage: (message: unknown) => void;
}

export async function handleDevDashboardAction(
  action: DevDashboardAction,
  options: DevDashboardActionOptions
): Promise<void>;
```

Responsibilities:

- Resolve the extension repo root from `context.extensionUri.fsPath`, not `vscode.workspace.workspaceFolders?.[0]`.
- Run `npm run compile:extension` or `npm run compile`.
- Stream stdout/stderr to the FlightPath log/output channel and `DEV_BUILD_OUTPUT`.
- Prevent concurrent builds with an in-memory `isBuilding` flag.
- Return structured success/failure results.
- Trigger `workbench.action.reloadWindow` or `workbench.action.restartExtensionHost` only after successful build for combined actions.

Use `child_process.spawn` rather than `exec`:

```typescript
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmCommand, ["run", scriptName], {
  cwd: context.extensionUri.fsPath,
  shell: false,
  env: process.env,
});
```

Reasons:

- Avoid `exec` output buffer limits.
- Stream logs live to the dashboard.
- Avoid shell command string parsing.
- Use the extension source directory even in multi-root workspaces or unusual Extension Development Host layouts.

### 5. Router Integration

Add handlers in `src/ui/WebviewMessageRouter.ts`.

Because `WebviewMessageRouter` currently does not receive `ExtensionContext`, add a callback to `WebviewRouterCallbacks` rather than storing context directly in the router:

```typescript
handleDevAction?: (
  action: DevDashboardAction,
  postMessage: PostMessageFn
) => Promise<void>;
```

Implement the callback in `FlightPathWebviewProvider`, where `context` already exists.

`handleDevAction()` should:

1. Check `IS_DEV_MODE`.
2. Dynamically import `handleDevDashboardAction` from `src/dev/DevCommands.ts`.
3. Pass `context`, scoped `postMessage`, and action kind.
4. Emit `DEV_COMMAND_UNAVAILABLE` if the requested VS Code command is not available.

### 6. Restart/Reconnect UX

For `DEV_RESTARTING`:

1. Show a clear overlay: `VS Code is reloading. Active workflows have been stopped. Reconnecting...`
2. Existing browser WebSocket reconnect behavior should handle server loss and reconnect after activation. Verify before adding a second reconnect loop.
3. The VS Code panel webview may be recreated by reload; no special persistence is required.
4. Dismiss the overlay after the next `INIT`/`STARTUP_COMPLETE`.

For build failures:

1. Do not reload.
2. Show `DEV_BUILD_COMPLETED` with `success: false`, `exitCode`, and a short error summary.
3. Keep the output visible so the developer can fix TypeScript/build errors.

### 7. Build Output Events

Suggested payloads:

```typescript
{
  type: MESSAGE_TYPES.DEV_BUILD_STARTED,
  script: "compile:extension",
  command: "npm run compile:extension",
}
```

```typescript
{
  type: MESSAGE_TYPES.DEV_BUILD_OUTPUT,
  stream: "stdout" | "stderr",
  chunk: string,
}
```

```typescript
{
  type: MESSAGE_TYPES.DEV_BUILD_COMPLETED,
  success: boolean,
  exitCode: number | null,
  signal?: string | null,
  durationMs: number,
}
```

## Non-Goals

- Do not implement in-flight workflow preservation.
- Do not create `.flightpath/.queue/<workflowId>/state.json`.
- Do not add startup workflow restoration in `extension.ts`.
- Do not attempt to orphan and re-adopt PTY or CLI child processes.
- Do not use `workbench.action.reloadWindowWithExtensionsDisabled`.

True in-flight survival would require a separate supervisor/daemon architecture outside the VS Code extension host. That is out of scope for this feature.

## File Changes

| File | Change |
| --- | --- |
| `src/types/DashboardConstants.ts` | Add dev message constants. |
| `src/types/WebviewMessageTypes.ts` | Add dev request/response message types. |
| `src/dev/DevCommands.ts` | Add exported dev dashboard action handler; keep dev-only logic centralized. |
| `src/ui/WebviewMessageRouter.ts` | Route dev dashboard messages through a callback. |
| `src/ui/FlightPathWebviewProvider.ts` | Provide dev callback with `ExtensionContext`; enforce `IS_DEV_MODE`; expose command availability to initial state. |
| `src/ui/WebviewSettingsSync.ts` | Include dev mode/status data in `INIT`. |
| `src/ui/webview-react/store/settingsStore.ts` or `src/ui/webview-react/store/uiStore.ts` | Store dev status/build state. |
| `src/ui/webview-react/hooks/useMessageHandler.ts` | Handle dev status/build/restarting messages. |
| `src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx` | Add conditional Developer tab. |
| `src/ui/webview-react/components/settings/DeveloperSection.tsx` | New settings UI. |
| Tests | Add focused tests for store/message handling if existing patterns make that cheap. |

No changes are required in `WorkflowOrchestrator.restoreState()` or `extension.ts` for workflow restoration.

## Limitations & Risks

- **In-flight CLI processes WILL be killed** — the `node-pty` sessions and child processes are children of the extension host process. No way around this.
- **Only for dev use** — This is intentionally a developer-only feature. It should be gated behind `IS_DEV_MODE` checks and hidden from production builds via esbuild dead code elimination.
- **npm must be available** — If `npm` is unavailable on `PATH`, the build will fail and should report that failure without reloading.
- **Current code remains loaded until restart** — A build can replace files in `out/`, but the running extension host continues using loaded modules until reload/restart.
- **Hosted server drops during restart** — The hosted browser server itself runs inside the extension host, so reload/restart temporarily drops HTTP/WebSocket connections.

## Implementation Order

1. Add message constants/types and dev state in `INIT`.
2. Add `handleDevDashboardAction()` in `DevCommands.ts` with build-only actions and runtime command detection.
3. Wire router/provider callbacks for dev actions, guarded by `IS_DEV_MODE`.
4. Add Developer settings tab with build-only buttons and output display.
5. Add reload/restart buttons and combined build-and-reload actions.
6. Add restart overlay handling for hosted browser and panel clients.
7. Run `npm run compile` and targeted UI tests.

## Acceptance Criteria

- Developer tab is hidden in production builds and visible in dev builds.
- Hosted browser dashboard can run `npm run compile:extension` through the extension host.
- Hosted browser dashboard can run `npm run compile` through the extension host.
- Build output streams to the dashboard and FlightPath output/log channel.
- Failed builds do not reload VS Code.
- Rebuild-and-reload actions use `workbench.action.reloadWindow` by default.
- Restart Extension Host action is only shown or enabled when `workbench.action.restartExtensionHost` is available.
- Active workflows are clearly warned as terminated on restart/reload.
- No workflow state restoration code is added.
- `npm run compile` passes after implementation.
