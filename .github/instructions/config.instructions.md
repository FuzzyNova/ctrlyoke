---
applyTo: "src/config/**"
---

<purpose>
Platform-agnostic configuration service layer that resolves settings across multiple scopes (CLI flags, workspace file, user file, and built-in defaults) into a single merged view. All config reads in the codebase go through the module-level `configService` singleton — there are no direct reads of `vscode.workspace.getConfiguration` or environment variables in core code.
</purpose>

<architecture>
```
FlightPathConfigService.ts   ← Singleton service + ConfigBackend interface
FileConfigBackend.ts         ← File-based backend (reads/writes JSON config files)
```

**Hierarchy (highest priority wins):**

```
CLI overlay           ← setCliOverlay()     — flags passed at CLI invocation
Workspace backend     ← setWorkspaceBackend() — <workspace>/.flightpath/settings.json
User backend          ← setUserBackend()    — ~/.flightpath/settings.json
Defaults              ← FLIGHTPATH_SETTINGS_DEFAULTS (from types/FlightPathSettings.ts)
```

`getAll()` deep-merges layers in ascending priority order. Objects are merged recursively; arrays and primitives are replaced outright.
</architecture>

<configService>
**`FlightPathConfigService`** — the singleton accessed via:

```typescript
import { configService } from "../config/FlightPathConfigService";
```

**Key methods:**

| Method                    | Purpose                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(key)`                | Get a top-level setting by key (type-safe, `keyof FlightPathGlobalSettings`)                                                                                                |
| `getNested(path)`         | Get a nested value using dot-notation (e.g. `"execution.mode"`) — returns `unknown`                                                                                         |
| `resolve(key)`            | Like `get()` but also returns the `SettingSource` (`"cli" \| "workspace" \| "user" \| "default"`)                                                                           |
| `getAll()`                | Full merged settings object                                                                                                                                                 |
| `getLeafSources()`        | Returns a dot-notation path → `SettingSource` map for every leaf in workspace/user backends; used by the settings UI to show per-setting source indicators and enable reset |
| `set(path, value, scope)` | Write to workspace or user backend via dot-notation; calls `notify()` automatically                                                                                         |
| `subscribe(listener)`     | Subscribe to change notifications; returns an unsubscribe function                                                                                                          |
| `notify()`                | Broadcast change to all subscribers (call after external mutations)                                                                                                         |

**Setup methods (called once during startup):**

- `setWorkspaceBackend(backend)` — attaches workspace-scoped `ConfigBackend`
- `setUserBackend(backend)` — attaches user-scoped `ConfigBackend`
- `setCliOverlay(overlay)` — applies `PartialFlightPathSettings` at highest priority

**`resolve()` limitation:** Only tracks sources for top-level keys. `getLeafSources()` provides granular per-leaf tracking for workspace/user backends but does not include CLI overlay values.
</configService>

<fileConfigBackend>
**`FileConfigBackend`** — `ConfigBackend` implementation backed by a JSON file on disk.

**File paths (via factory functions in `FileConfigBackend.ts`):**

```typescript
createUserConfigBackend(onChanged?)         // ~/.flightpath/settings.json
createWorkspaceConfigBackend(root, onChanged?)  // <root>/.flightpath/settings.json
```

**Behavior:**

- `filePath` getter — returns the resolved config file path (useful for diagnostics/logging)
- `getAll()` parses the JSON file with in-memory caching; returns `{}` if the file is missing or invalid JSON (fail-safe)
- `set(path, value)` writes using dot-notation (`"execution.mode"`), creates the directory and file if needed, uses an atomic write (temp file + rename) to prevent corruption, and invalidates the cache
- Setting `value = undefined` deletes the key from the JSON
- `startWatching()` / `stopWatching()` — use chokidar to watch the config directory for external file changes and call `onChanged` when the specific file changes. **These are not called during startup** — watching is available but currently unused. Cache invalidation on external edits is handled by passing an `onChanged` callback when the watcher is active.

**`onChanged` callback:**

- Passed at construction time by `extension.ts` and `cli.ts`
- Intended to call `configService.notify()` when the file changes externally
- Only fires if `startWatching()` has been called
- Programmatic changes via `configService.set()` trigger `notify()` directly (no watcher needed)
  </fileConfigBackend>

<wiring>
**`extension.ts`** — creates backends with notify callbacks:

```typescript
const userConfigBackend = createUserConfigBackend(() => configService.notify());
configService.setUserBackend(userConfigBackend);

const workspaceConfigBackend = createWorkspaceConfigBackend(
  workspaceFolders[0].uri.fsPath,
  () => configService.notify()
);
configService.setWorkspaceBackend(workspaceConfigBackend);
```

**`cli.ts`** — creates backends without callbacks, then builds a CLI overlay from explicitly provided flags (not Commander defaults):

```typescript
configService.setUserBackend(createUserConfigBackend());
configService.setWorkspaceBackend(createWorkspaceConfigBackend(workingDir));

const overlay: PartialFlightPathSettings = {};
if (options.headless) overlay.execution = { mode: "headless" };
// ... other explicit flags ...
configService.setCliOverlay(overlay);
```

Only flags that were explicitly passed by the user go into the overlay — Commander default values are excluded to avoid overriding the user/workspace config.
</wiring>

<settingsStructure>
**`FlightPathGlobalSettings`** top-level keys (see `src/types/FlightPathSettings.ts` for full details):

| Key                    | Type                             | Purpose                                                                                                                                                                                            |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `general`              | object                           | Global UX defaults: `defaultFormat`, `defaultTemplate`, `autoLoadRecentSession`, `omitAgentsSkillsOnResume`                                                                                        |
| `defaults`             | object                           | Workflow-step defaults mirrored from execution properties: harness, models, additional args, agent, skills, resume/prior context, MCP servers, hooks, tool permissions, default end/pre conditions |
| `permissions`          | object                           | Harness-specific advanced permission settings: allowed dirs, Copilot allow-all-paths, Codex sandbox + approval policy                                                                              |
| `execution`            | object                           | `mode`, `injectMode`, `maxPromptTimeout`, `scriptTimeout`, `closeTerminalOnComplete`, `autoDeleteTempFiles`                                                                                        |
| `chat`                 | object                           | Window location, inactivity timeout, timeout behavior, forced agent mode, native attachments                                                                                                       |
| `queue`                | object                           | Max size, max workflow execution time, unlimited mode, notify-on-extension behavior                                                                                                                |
| `history`              | object                           | Output saving and max run retention                                                                                                                                                                |
| `terminal`             | `TerminalSettings`               | Embedded terminal display: font, scrollback, cursor, shell executable, mobile control bar and shortcuts                                                                                            |
| `ui`                   | object                           | Display flags, gitignore filtering, confirmation dialogs, output focus, editor expansion, hidden-file toggle                                                                                       |
| `server`               | object                           | Hosted dashboard: enabled, ports, theme, bind address, TLS, icon colors                                                                                                                            |
| `notifications`        | `FlightPathNotificationSettings` | VS Code + browser notifications, per-event modes, hook-event toggles, naming/focus behavior                                                                                                        |
| `commit`               | object                           | Commit-message generation defaults: harness, model, prompt                                                                                                                                         |
| `enableDiagnosticLogs` | `boolean`                        | Global diagnostic logging toggle                                                                                                                                                                   |

**`PartialFlightPathSettings`** — shallow-partial version (top-level keys optional, nested objects also partial). Used for config file contents and the CLI overlay.

**`FLIGHTPATH_SETTINGS_DEFAULTS`** — canonical default for every setting; always used as the base layer in `getAll()`.
</settingsStructure>

<conventions>
- **Global settings are always editable** — never disable or hide global settings controls based on the current value of another global setting. Global settings are workflow-level defaults; a workflow can override any setting (e.g., `permissionMode: custom`), so a user must be able to pre-configure all related settings regardless of what the global default is set to. Conditional disabling belongs only in the workflow properties panel, where the active workflow's actual values are known.
- **Always read settings via `configService`** — never read config files directly or call `vscode.workspace.getConfiguration` in core code.
- **`ConfigurationUtils` is the canonical accessor** — it wraps `configService.get()` calls in named helper functions (e.g. `getScriptTimeoutMs()`, `getCliModel()`). Prefer adding a new helper there rather than calling `configService.get()` inline.
- **`set()` at the right scope** — workspace settings affect the current project; user settings are global across all workspaces. Use workspace scope by default for project-specific settings.
- **`notify()` after external mutations** — if you mutate the backend outside `configService.set()`, call `configService.notify()` to propagate the change to subscribers.
- **CLI overlay only for explicit flags** — never add Commander default values to the overlay; they would silently override user/workspace config.
- **`ConfigBackend` is the extension point** — to add a new backend (e.g. remote config, VS Code settings), implement `ConfigBackend` and call the appropriate `set*Backend()` method. The merge logic in `FlightPathConfigService` handles the rest.
- **Deep merge semantics** — objects at the same key path are merged recursively; an array or primitive at a given path in a higher-priority layer fully replaces the value from lower-priority layers.
</conventions>
