---
applyTo: "src/platform/**"
---

<purpose>
Keep core workflow/runtime code platform-agnostic. `PlatformAdapter` is intentionally a small workspace/UI bridge; config still lives in `CtrlYokeConfigService` / `ConfigurationUtils`, with CLI compatibility hooks layered on top.
</purpose>

<architecture>
- `PlatformAdapter.ts` defines the small shared contract used by runtime code.
- `VsCodeAdapter.ts` wraps real `vscode` APIs and exposes `getExtensionContext()` for VS Code-only collaborators such as `VsCodeIntegrationFactory` and terminal setup.
- `CliAdapter.ts` adapts `ResolvedCliConfig` to the same contract and also exposes `getConfig()` as a non-interface compatibility hook.
- `vscode-shim.ts` is an esbuild alias used only in the CLI bundle so shared `import * as vscode from "vscode"` code can compile without pulling in the real extension host.
</architecture>

<stateFlow>
- VS Code path: `extension.ts` / `WorkflowOrchestrator` create `VsCodeAdapter` instances and pass them into shared runtime classes.
- CLI path: `cli.ts` computes the effective execution mode and permissions, writes them into `configService.setCliOverlay(...)`, then constructs `CliAdapter` and calls `registerCliAdapter(...)`.
- The CLI overlay is the primary path for modern config reads. Shim-backed `workspace.getConfiguration().get()` still matters for older shared code that reaches configuration through `ConfigurationUtils` or helper modules.
- `CommitMessageGenerator` also constructs a headless `CliAdapter` inside the extension host, so platform changes affect both the standalone CLI and AI commit-message generation.
</stateFlow>

<conventions>
- Do not add `vscode` imports to core workflow/runtime code. Prefer constructor injection of `PlatformAdapter`; only VS Code-specific layers should depend on `VsCodeAdapter` or `vscode` directly.
- Keep `PlatformAdapter` small. Add interface methods only for behavior that genuinely needs a cross-platform contract; otherwise prefer VS Code-only code to depend on `VsCodeAdapter` explicitly.
- `getConfig()` is intentionally **not** on `PlatformAdapter`. If shared CLI-bundled code needs a new config-backed behavior, update both the CLI overlay setup in `cli.ts` and any required `CliAdapter.getConfig()` compatibility mapping.
- `CliAdapter.showChoice()` always returns `undefined`; callers like `EndConditionHandler` must keep a safe non-interactive fallback path.
- `getExtensionContext()` stays outside the interface on purpose; current callers rely on explicit `VsCodeAdapter` typing/casts.
</conventions>

<vscodeShim>
Keep the shim minimal and compatibility-focused:

- only stub APIs that CLI-bundled shared code actually imports;
- `window.createTerminal()` should keep throwing so accidental VS Code-terminal usage fails fast in CLI mode;
- `workspace.fs` / `openTextDocument` should remain backed by Node fs so shared file helpers behave predictably;
- `registerCliAdapter()` / `unregisterCliAdapter()` exist to bridge legacy config reads, not to replace the newer CLI overlay path.
  </vscodeShim>
