---
applyTo: "src/platform/**"
---

<purpose>
Platform abstraction layer that lets core workflow code (`WorkflowExecutor`, `WorkflowInstance`, `CliIntegration`, `EndConditionEvaluator`, `IntegrationFactory`) run identically in both the VS Code extension and the standalone CLI binary. No core module imports `vscode` directly — they accept a `PlatformAdapter` instance via constructor injection and call its methods for configuration, messaging, and workspace access.
</purpose>

<architecture>
**Interface + two implementations + a build-time shim:**

```
PlatformAdapter.ts          ← Abstract interface (the contract)
├── VsCodeAdapter.ts        ← VS Code implementation (delegates to vscode.* APIs)
├── CliAdapter.ts           ← CLI implementation (maps ResolvedCliConfig to the same contract)
└── vscode-shim.ts          ← Build-time stub replacing `import * as vscode` in CLI bundle
    index.ts                ← Barrel exports (PlatformAdapter, VsCodeAdapter, CliAdapter, ResolvedCliConfig)
```

**Dependency flow:**

- `extension.ts` creates `VsCodeAdapter(context)` → passes to `WorkflowOrchestrator` → propagates to all core classes
- `cli.ts` creates `CliAdapter(resolvedConfig)` → calls `registerCliAdapter(platform)` on the shim → passes to `WorkflowExecutor`
- Core classes only depend on the `PlatformAdapter` interface — never on a concrete adapter or `vscode`
  </architecture>

<platformAdapter>
**PlatformAdapter** (`PlatformAdapter.ts`) — the interface contract:

| Method                            | VS Code                                                                                 | CLI                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `getWorkspaceRoot()`              | `workspaceFolders[0].uri.fsPath` (falls back to `process.cwd()` when no folder is open) | `config.cwd ?? process.cwd()`                                         |
| `log(message)`                    | `showInformationMessage()`                                                              | `console.log()` (suppressed when `--quiet`)                           |
| `warn(message)`                   | `showWarningMessage()`                                                                  | `console.warn()` (suppressed when `--quiet`)                          |
| `error(message)`                  | `showErrorMessage()`                                                                    | `console.error()` (always shown)                                      |
| `showProgress(message)`           | No-op (status bar handles it)                                                           | `process.stdout.write("\r…")` (suppressed when `--quiet` or `--json`) |
| `showChoice(message, ...options)` | `showWarningMessage(message, ...options)`                                               | Returns `undefined` (headless — no interactive prompts)               |
| `getExtensionPath()`              | `context.extensionPath`                                                                 | Resolves package root from `__filename`                               |

> **Note:** `getConfig<T>(key, default)` is **not** part of the `PlatformAdapter` interface. In VS Code, config is read via `vscode.workspace.getConfiguration()` directly. In CLI, the vscode-shim intercepts that same call and delegates to `CliAdapter.getConfig()` (see `<vscodeShim>` and `<cliAdapter>`).

**Optional methods** (declared in the interface, implemented by VsCodeAdapter only):

- `openTextFile(path)` — opens editor tab
- `focusDashboard()` — executes `flightpath.dashboard.focus` command
- `isVsCode()` — returns `true`; used by `CliIntegration` to decide between VS Code terminal and `spawn` with `stdio: "inherit"`

**VsCodeAdapter-only extras** (not declared in the interface):

- `getExtensionContext()` — returns the underlying `vscode.ExtensionContext`; used by VS Code-only code (WorkflowOrchestrator, terminal creation, etc.) via a cast to `VsCodeAdapter`
  </platformAdapter>

<cliAdapter>
**CliAdapter** (`CliAdapter.ts`) — translates CLI flags into the `getConfig()` contract.

**`ResolvedCliConfig` interface** — the parsed CLI flags passed to the constructor:

- `harness`, `model`, `cwd`, `timeout`, `scriptTimeout`
- `permissionMode`, `allowedTools[]`, `deniedTools[]`
- `additionalDirs[]`, `sessionId?`, `resumeSession?`
- `verbose`, `quiet`, `json`, `color`, `headless?`
- `vars: Record<string, string>` — variables from `--var key=value` flags; merged over workflow `vars: defaults`; substituted as `{{key}}` in prompt text, model, additionalArgs, hook commands, and endCondition script paths
- `cliExecutionMode`: `"interactive" | "headless"` (detected from TTY or overridden by flags)

**Key `getConfig()` mappings:**

> `getConfig<T>(key, default)` is defined on `CliAdapter` (not on the `PlatformAdapter` interface). It is bridged into config consumers via the vscode-shim's `workspace.getConfiguration().get()`.

| Config Key                                             | Source                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `cliToolPermissions`                                   | Direct from `config.permissionMode`                                                   |
| `cliAllowedTools` / `cliDeniedTools`                   | Direct from `config.allowedTools` / `config.deniedTools`                              |
| `copilotCliAllowedDirs`                                | `config.additionalDirs` (for `--add-dir` flags)                                       |
| `cliExecutionMode`                                     | `config.cliExecutionMode`                                                             |
| `copilotCliModel` / `claudeCliModel` / `codexCliModel` | All map to `config.model` (single `--model` flag)                                     |
| `scriptTimeout` / `maxPromptExecutionTime`             | Stored in ms, converted to seconds (÷1000) to match `ConfigurationUtils` expectations |
| `resumeExistingSession`                                | `config.resumeSession ?? false`                                                       |
| Other keys                                             | Read from `configService.getNested(key)` first, then fall back to `defaultValue`      |

**Behavioral differences from VsCodeAdapter:**

- `log()` / `warn()` suppressed when `config.quiet` is true
- `showProgress()` suppressed when `config.quiet` or `config.json`
- `showChoice()` always returns `undefined` (no interactive prompts in CI/CD)
- `getExtensionPath()` climbs from `out/cli.js` to package root
  </cliAdapter>

<vscodeShim>
**vscode-shim.ts** — build-time module replacement for the CLI bundle.

**How it works:**

1. esbuild CLI config aliases `vscode` → `src/platform/vscode-shim.ts`
2. Any `import * as vscode from "vscode"` in shared code resolves to this shim
3. The shim exports no-op stubs matching the `vscode` API surface used by the codebase

**Adapter registration bridge:**

```typescript
registerCliAdapter(adapter); // Called in cli.ts after constructing CliAdapter
unregisterCliAdapter(); // Test/teardown only — clears the registered adapter
```

Once registered, `workspace.getConfiguration().get(key, default)` delegates to `adapter.getConfig(key, default)` instead of returning the default. This makes `ConfigurationUtils` calls inside CLI provider code (e.g. `getCliAllowedTools()`) transparently reflect CLI flags.

**Stubbed API surfaces:**

| Namespace    | Behavior                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window`     | `showInformationMessage/Warning/Error` return `undefined`; `createOutputChannel` returns no-op channel; `setStatusBarMessage` returns no-op disposable; `showQuickPick`/`showTextDocument`/`onDidChangeActiveTextEditor` are no-ops; `createTerminal()` throws (must never be called in CLI) |
| `workspace`  | `getConfiguration()` delegates to registered adapter; `fs` has `stat`, `readFile`, `writeFile`, `createDirectory`, `readDirectory` (all via Node.js `fs`); `openTextDocument` reads via `fs.readFile`; `createFileSystemWatcher` is a no-op                                                  |
| `commands`   | `executeCommand()` returns `undefined`                                                                                                                                                                                                                                                       |
| `Uri`        | `file()` wraps path in `{ fsPath, scheme, path }`; `joinPath()` uses `path.join`; `parse()` wraps URI string                                                                                                                                                                                 |
| `lm`         | `selectChatModels()` returns `[]`                                                                                                                                                                                                                                                            |
| `languages`  | `createDiagnosticCollection()` returns no-op                                                                                                                                                                                                                                                 |
| `extensions` | `getExtension()` returns `undefined`                                                                                                                                                                                                                                                         |

**Types and classes stubbed:** `Disposable`, `Position`, `Range`, `RelativePattern`, `EventEmitter<T>`, `FileType` enum, `ConfigurationTarget` enum — all match VS Code API signatures.

**Important:** This shim is ONLY used in the CLI bundle. The VS Code extension uses the real `vscode` module (marked external in esbuild).
</vscodeShim>

<conventions>
- **Never import `vscode` in core workflow code** — accept a `PlatformAdapter` via constructor injection instead. Only VS Code-specific code (`src/ui/`, `src/extension.ts`, `VsCodeAdapter.ts`) may import `vscode` directly.
- **Add new platform capabilities to the interface first** — implement in both adapters, keeping CLI behavior gracefully degraded (no-op or `undefined`).
- **Optional methods for VS Code-only features** — use `methodName?()` in the interface; CLI callers check existence before calling.
- **Config key mappings in CliAdapter must stay in sync with `ConfigurationUtils`** — when adding a new setting consumed via `getConfig()`, add a corresponding `case` in `CliAdapter.getConfig()`.
- **Keep vscode-shim minimal** — only stub APIs actually imported by shared code. Adding unused stubs increases bundle size and maintenance burden.
- **Timeout convention** — `ConfigurationUtils` stores timeouts in seconds; `CliAdapter` stores them in milliseconds and divides by 1000 in `getConfig()`.
- **Barrel exports** — `index.ts` exports the interface as a type and the two adapters as values. `vscode-shim.ts` is NOT exported here (it's wired via esbuild alias).
</conventions>
