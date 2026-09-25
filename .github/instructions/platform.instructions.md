---
applyTo: "src/platform/**"
---

<purpose>
Keep core workflow/runtime code platform-agnostic. `PlatformAdapter` is intentionally a small workspace/UI bridge; config still lives in `CtrlYokeConfigService` / `ConfigurationUtils`, with CLI compatibility hooks layered on top.
</purpose>

<architecture>
- `PlatformAdapter.ts` defines the small shared contract used by runtime code.
- `VsCodeAdapter.ts` wraps real `vscode` APIs and exposes `getExtensionContext()` for VS Code-only collaborators such as terminal setup.
- `CliAdapter.ts` adapts `ResolvedCliConfig` to the same contract and also exposes `getConfig()` as a non-interface compatibility hook.
- `vscode-shim.ts` is an esbuild alias used only in the CLI bundle so shared `import * as vscode from "vscode"` code can compile without pulling in the real extension host.
- `WorkspaceRootResolver.ts` owns `.ctrlyoke`-root/trusted-root resolution and `resolveNamedRelativePath` (prefix→absolute). `WorkspaceViewerPath.ts` is the **single source of the folder-name-prefixed viewer-path convention** (`root2/src/x.ts`) — pure-string primitives (`firstViewerSegment`/`stripViewerPrefix`/`joinViewerPath`), `rootForViewerPath`, and the `toViewerPath`⇄`fromViewerPath` absolute conversions (`ViewerRootContext`). The hosted SCM service (`relativePath`/`resolveAgainstRoots`) and the snapshot/undo layer (`segmentViewerPath`/`gitRelFromChange`) delegate here rather than re-deriving prefix slicing. Viewer paths are **always `/`-separated** — `toViewerPath` normalizes both the single-root and multi-root branches, so single-root output no longer leaks OS-native `\` on Windows. It imports `node:path`, so it must **not** be imported into the webview bundle; the store's one prefix read mirrors only `firstViewerSegment` and cross-references it.
</architecture>

<stateFlow>
- VS Code path: `extension.ts` / `WorkflowOrchestrator` create `VsCodeAdapter` instances and pass them into shared runtime classes.
- CLI path: `cli.ts` computes the effective execution mode, writes it and any explicitly passed setting flags (e.g. `--permission-mode`, `--allow-tool`) into `configService.setCliOverlay(...)`, then constructs `CliAdapter` and calls `registerCliAdapter(...)`. The CLI never resolves tool permissions itself; they resolve per step (step > workflow > settings) like in the extension, so execution mode must not change them.
- The CLI overlay is the primary path for modern config reads. Shim-backed `workspace.getConfiguration().get()` still matters for older shared code that reaches configuration through `ConfigurationUtils` or helper modules.
- `CommitMessageGenerator` also constructs a headless `CliAdapter` inside the extension host, so platform changes affect both the standalone CLI and AI commit-message generation.
</stateFlow>

<conventions>
- Do not add `vscode` imports to core workflow/runtime code. Prefer constructor injection of `PlatformAdapter`; only VS Code-specific layers should depend on `VsCodeAdapter` or `vscode` directly.
- Keep `PlatformAdapter` small. Add interface methods only for behavior that genuinely needs a cross-platform contract; otherwise prefer VS Code-only code to depend on `VsCodeAdapter` explicitly.
- `getConfig()` is intentionally **not** on `PlatformAdapter`. If shared CLI-bundled code needs a new config-backed behavior, update both the CLI overlay setup in `cli.ts` and any required `CliAdapter.getConfig()` compatibility mapping.
- **A Windows credential blob is capped at 2560 bytes, and `CredWrite` reports it as nothing but a boolean `false`.** The blob is UTF-16, so the real ceiling is exactly **1280 characters** per credential — measured, not inferred: 1280 stores, 1300 fails with Win32 1783. Nothing about `CredRead`/`CredWrite` hints at this, and macOS `security` / Linux `secret-tool` have no comparable limit, so a value that works on every other platform silently fails to persist only on Windows. This is not hypothetical: it broke Pro activation the moment `LicenseService` moved from `context.secrets` to `OsCredentialStore`, because a signed Keygen license file is several KB. `WindowsCredentialBackend` now transparently splits a long value across `<key>`, `<key>#1`, … with the count in `<key>#count`; a value that fits stays one plain credential so pre-chunking credentials still read back. Keep that single-credential shape for short values, and never assume a `SecretStore` will take an arbitrarily long value without the backend splitting it — PEM keys and long tokens hit the same wall.
- **`OsCredentialStore` spawns a `powershell.exe`/`security`/`secret-tool` subprocess per operation, at roughly 450–500 ms each on Windows.** There is no batching and no cache in the store itself, so any caller on a warm path needs its own (`LicenseService.getEntitlement` memoizes for `ENTITLEMENT_CACHE_TTL_MS`). Note that a single `store()` is already ~3 calls, because `addKeyToIndex` reads and rewrites the key index; budget accordingly before putting a credential read behind anything per-request.
- `PlatformAdapter` no longer carries host UI at all — `log`/`warn`/`error`/`showProgress`/`showChoice` were removed in favor of `UserFeedbackSink` and `UserInteractionPort`. Do not re-add a UI method here; a headless host answering "no client to ask" belongs in a port implementation (`NullUserInteractionPort`), where the caller's non-interactive fallback stays explicit.
- `getExtensionContext()` stays outside the interface on purpose; current callers rely on explicit `VsCodeAdapter` typing/casts.
</conventions>

<vscodeShim>
Keep the shim minimal and compatibility-focused:

- only stub APIs that CLI-bundled shared code actually imports;
- `window.createTerminal()` should keep throwing so accidental VS Code-terminal usage fails fast in CLI mode;
- `workspace.fs` / `openTextDocument` should remain backed by Node fs so shared file helpers behave predictably;
- `registerCliAdapter()` / `unregisterCliAdapter()` exist to bridge legacy config reads, not to replace the newer CLI overlay path.
  </vscodeShim>
