---
applyTo: "src/dev/**"
---

<purpose>
Development-only tooling only. `src/dev/` is currently a single module (`DevCommands.ts`) for diagnostics, VS Code API probes, model export, and dashboard-triggered build/test actions. Production builds must not import or ship this code.
</purpose>

<architecture>
Two entry points load this module, both behind `IS_DEV_MODE`:

- `src/extension.ts` calls `registerDevCommands(...)` during activation.
- `src/ui/CtrlYokeWebviewProvider.ts` lazily imports `handleDevDashboardAction(...)` for the dashboard dev panel.

Keep those two surfaces aligned. If you add or rename a dashboard action, update:

- `src/dev/DevCommands.ts`
- `src/types/WebviewMessageTypes.ts` (`DevDashboardAction`)
- any related `MESSAGE_TYPES` handling in the webview/provider path

`ctrlyoke.devMenu` is the only dev command contributed in `package.json`, gated by the `ctrlyoke.devMode` context key set inside `registerDevCommands()`. Every other dev command stays runtime-only and should be pushed into `context.subscriptions`.

`IS_DEV_MODE` comes from `src/utils/BuildConfig.ts` and is replaced at build time by esbuild. Dev builds keep this module reachable; production builds dead-strip it.

Dashboard build actions are intentionally in-process and serialized by the module-level `isBuilding` flag. `runNpmBuild()` always runs from the extension root, uses `npm.cmd` with `shell: true` on Windows, and only supports the existing scripts: `compile:extension`, `compile:webview`, `compile`, and `test`.
</architecture>

<highValueCommands>
Keep the command surface focused on a few categories:

- **VS Code API probes**: the `ctrlyoke.test.*` commands are exploratory/diagnostic helpers, not production features.
- **Reference artifact generation**: command dumps go to `dev/reference/`; discovered models go to `scripts/discovered-models.json`.
- **Dashboard dev actions**: build/test/restart actions stream `DEV_BUILD_*` / `DEV_RESTARTING` / `DEV_COMMAND_UNAVAILABLE` messages back to the UI.
- **Optional notification testing**: `ctrlyoke.dev.sendTestNotification` only exists when a handler is injected from `extension.ts`; keep server/notification dependencies out of `DevCommands.ts` itself.
  </highValueCommands>

<modelUpdateWorkflow>
`ctrlyoke.exportDiscoveredModels` is the front door for refreshing checked-in model lists:

1. Run extension (`F5`)
2. Run command: **ctrlyoke: Export Discovered Models** → writes `scripts/discovered-models.json`
3. `npm run sync-models -- --import` → updates `src/utils/ModelConstants.ts`
4. `npm run sync-models` → syncs `package.json` enums and `schemas/workflow-schema.json`
5. `npm run generate-schema` → regenerates YAML schema from JSON
6. Commit all updated files
   </modelUpdateWorkflow>

<conventions>
- Never register dev commands outside the `IS_DEV_MODE` guard.
- Keep `ctrlyoke.devMenu` as the only manifest-declared dev command.
- Use `Log` for diagnostic output; these commands are meant to leave a useful trace in the ctrlyoke output/log pipeline.
- Prefer optional handler injection (`DevCommandHandlers`) over importing higher-level runtime services into `DevCommands.ts`.
- Keep `DevBuildResult` private; the public contract here is message-based, not a reused shared type.
- If you touch restart/build messaging, preserve the current distinction between `reloadWindow` and `restartExtensionHost`; browser clients depend on the explicit `DEV_RESTARTING` signal.
</conventions>
