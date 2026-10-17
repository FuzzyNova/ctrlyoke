---
applyTo: "src/platform/**"
---

<purpose>
Keep core workflow/runtime code platform-agnostic. `PlatformAdapter` is intentionally a small workspace/UI bridge; config lives in `CtrlYokeConfigService` / `ConfigurationUtils`.
</purpose>

<architecture>
- `PlatformAdapter.ts` defines the small shared contract used by runtime code.
- `VsCodeAdapter.ts` wraps real `vscode` APIs and exposes `getExtensionContext()` for VS Code-only collaborators such as terminal setup.
- `CliAdapter.ts` adapts `ResolvedCliConfig` to the same contract and supplies the CLI execution mode through `PlatformAdapter.getConfig()`.
- `VsCodeLogOutputChannel.ts` and `VsCodeTelemetry.ts` are the VS Code halves of `Log` and telemetry: `extension.ts` installs them as the host-neutral `LogOutputSink`/`TelemetrySink`.
- `WorkspaceRootResolver.ts` owns `.ctrlyoke`-root/trusted-root resolution and `resolveNamedRelativePath` (prefix→absolute). `WorkspaceViewerPath.ts` is the **single source of the folder-name-prefixed viewer-path convention** (`root2/src/x.ts`) — pure-string primitives (`firstViewerSegment`/`stripViewerPrefix`/`joinViewerPath`), `rootForViewerPath`, and the `toViewerPath`⇄`fromViewerPath` absolute conversions (`ViewerRootContext`). The hosted SCM service (`relativePath`/`resolveAgainstRoots`) and the snapshot/undo layer (`segmentViewerPath`/`gitRelFromChange`) delegate here rather than re-deriving prefix slicing. Viewer paths are **always `/`-separated** — `toViewerPath` normalizes both the single-root and multi-root branches, so single-root output no longer leaks OS-native `\` on Windows. It imports `node:path`, so it must **not** be imported into the webview bundle; the store's one prefix read mirrors only `firstViewerSegment` and cross-references it.
</architecture>

<stateFlow>
- VS Code path: `extension.ts` / `WorkflowOrchestrator` create `VsCodeAdapter` instances and pass them into shared runtime classes.
- CLI path: `cli.ts` computes the effective execution mode, writes it and any explicitly passed setting flags (e.g. `--permission-mode`, `--allow-tool`) into `configService.setCliOverlay(...)`, then constructs `CliAdapter`. The CLI never resolves tool permissions itself; they resolve per step (step > workflow > settings) like in the extension, so execution mode must not change them.
- `CommitMessageGenerator` also constructs a headless `CliAdapter` inside the extension host, so platform changes affect both the standalone CLI and AI commit-message generation.
</stateFlow>

<conventions>
- Do not add `vscode` imports to core workflow/runtime code. Prefer constructor injection of `PlatformAdapter`; only VS Code-specific layers should depend on `VsCodeAdapter` or `vscode` directly.
- Keep `PlatformAdapter` small. Add interface methods only for behavior that genuinely needs a cross-platform contract; otherwise prefer VS Code-only code to depend on `VsCodeAdapter` explicitly.
- Shared CLI configuration reads go through `ConfigurationUtils` / `configService`; explicit CLI setting flags enter through the overlay in `cli.ts`.
- **A Windows credential blob is capped at 2560 bytes, and `CredWrite` reports it as nothing but a boolean `false`.** The blob is UTF-16, so the real ceiling is exactly **1280 characters** per credential — measured, not inferred: 1280 stores, 1300 fails with Win32 1783. Nothing about `CredRead`/`CredWrite` hints at this, and macOS `security` / Linux `secret-tool` have no comparable limit, so a value that works on every other platform silently fails to persist only on Windows. This is not hypothetical: it broke Pro activation the moment `LicenseService` moved from `context.secrets` to `OsCredentialStore`, because a signed Keygen license file is several KB. `WindowsCredentialBackend` now transparently splits a long value across `<key>`, `<key>#1`, … with the count in `<key>#count`; a value that fits stays one plain credential so pre-chunking credentials still read back. Keep that single-credential shape for short values, and never assume a `SecretStore` will take an arbitrarily long value without the backend splitting it — PEM keys and long tokens hit the same wall.
- **`OsCredentialStore` spawns a `powershell.exe`/`security`/`secret-tool` subprocess per operation, at roughly 450–500 ms each on Windows.** There is no batching and no cache in the store itself, so any caller on a warm path needs its own (`LicenseService.getEntitlement` memoizes for `ENTITLEMENT_CACHE_TTL_MS`). Note that a single `store()` is already ~3 calls, because `addKeyToIndex` reads and rewrites the key index; budget accordingly before putting a credential read behind anything per-request.
- **Node hosts get their secret store from `createNodeSecretStore()` (`NodeSecretStore.ts`), never `new OsCredentialStore()`.** It falls back to `FileSecretStore` (plaintext `<ctrlyokeStateHome>/secrets.json`, `0600`) where the OS store is unavailable, as in containers and on headless Linux. A host that builds a bare `OsCredentialStore` fails outright there, or reads nothing while another host writes to the file. That is how the server's pre-start `--https` license check once read Free for a licensed server. The file is unencrypted on purpose: a key kept beside it, or in an env var that every spawned harness inherits, would protect nothing (see the resolved bug `dev/bugs/implemented/headless-linux-has-no-persistent-secret-store.md`).
- `PlatformAdapter` no longer carries host UI at all — `log`/`warn`/`error`/`showProgress`/`showChoice` were removed in favor of `UserFeedbackSink` and `UserInteractionPort`. Do not re-add a UI method here; a headless host answering "no client to ask" belongs in a port implementation (`NullUserInteractionPort`), where the caller's non-interactive fallback stays explicit.
- `getExtensionContext()` stays outside the interface on purpose; current callers rely on explicit `VsCodeAdapter` typing/casts.
- **In VS Code, `getWorkspaceRoot()` is `undefined` when no folder is open, and nothing may fall back to `process.cwd()`.** The extension host's cwd is the editor's install directory, never the open folder; falling back to it once put `.ctrlyoke/` and run history inside `…\Programs\Microsoft VS Code`. Code that only runs inside a run uses `requireWorkspaceRoot()`; constructors that need a path anyway get `noWorkspacePlaceholderRoot()` through `createNoWorktreeExecutionWorkspace`. Anything that spawns a process unrelated to a workspace (model discovery) must pass an explicit `cwd`, for the same reason.
</conventions>
