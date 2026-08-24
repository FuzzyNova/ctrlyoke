---
applyTo: "src/config/**"
---

<purpose>
Platform-agnostic settings resolution for shared core code. `src/config/` owns the merge logic and file-backed persistence; the rest of the repo should consume settings through `configService` and usually through `ConfigurationUtils`, not by reading files or VS Code settings directly.
</purpose>

<architecture>
- `CtrlYokeConfigService` is the singleton merge layer. Priority order is: defaults → user file → workspace file → CLI overlay.
- `FileConfigBackend` is the current persistence backend. `ConfigBackend` intentionally stays tiny (`getAll` + `set`) so other storage backends can plug in without changing merge logic.
- Merge semantics are recursive for plain objects; arrays and primitives replace lower-priority values wholesale.
</architecture>

<nonObviousBehavior>
- `resolve()` only reports the source for a **top-level** key. The webview settings UI uses `getLeafSources()` for per-path badges/reset state.
- `getLeafSources()` records both leaf paths **and object paths**. Do not “simplify” that away: aggregate editors in `WebviewSettingsSync` rely on object-path entries to show source/reset state for grouped settings.
- `set(path, value)` splits the path on `.` the whole way down, so a settings object whose **keys are user-supplied strings** can never be written key-by-key. Real model IDs contain dots, so `modelPricing.qwen-cli.qwen3.5-plus.inputPerMTok` would silently create a `qwen3` → `5-plus` nest instead of one `qwen3.5-plus` key. Freeform-keyed maps must be written as one whole object at their own path (`modelPricing` — see `ModelPricingEditor.tsx` and its `SettingInputRow path="modelPricing"`), which is one of the reasons `getLeafSources()` records object paths.
- `getLeafSources()` only reflects user/workspace backends. CLI overlay values are intentionally excluded from that per-setting map.
- The main CLI mostly overlays only explicitly passed flags, but it **always** writes the effective `defaults.executionMode` into the overlay so shared code sees the real interactive/headless mode even when that came from TTY detection instead of a flag.
- `FileConfigBackend.startWatching()` exists for external-edit invalidation but is not part of normal startup wiring today. Normal writes go through `configService.set(...)`, which already calls `notify()`.
- `FileConfigBackend.set()` serializes writes on an internal `writeQueue` promise chain. It must — `set()` does an unlocked read-modify-write (`load()` the whole file, mutate one path, `save()` the whole file back), so two `configService.set()` calls issued back-to-back (e.g. a UI handler that fires two `onUpdate()`s to different paths for one user action, like `TerminalControlBarEditor.addShortcut()` writing `mobileCustomShortcuts` then `mobileBarLayout`) become two overlapping `UPDATE_GLOBAL_SETTING` messages in `WebviewSettingsSync`; without the queue, the second call's `load()` can race ahead of the first call's `save()` and silently clobber it — the first write vanishes even though the second commit succeeds. Any caller issuing multiple settings writes for one logical action still relies on this queue for correctness, not on request ordering it doesn't control.
- `getScoped(key, scope)` reads exactly one backend (user or workspace) with no merge — added for `permissions.allowedExternalFileRoots`, which needs an explicit union of both scopes rather than the ordinary array-replace `deepMerge`. Its return type is `PartialCtrlYokeSettings[K]`, not `CtrlYokeGlobalSettings[K]`: array leaves under `Partial<>` type as `(T | undefined)[]`, so callers must filter, not just default with `?? []` (see `ConfigurationUtils.getAllowedExternalFileRootsByScope`'s `toStringArray` helper).
- `ExternalRootsTrustStore` (`src/config/ExternalRootsTrustStore.ts`) is a second, deliberately separate file-backed store (`~/.ctrlyoke/external-roots-trust.json`, sibling to the user `settings.json`) rather than a new `CtrlYokeConfigService` backend. It holds per-workspace-identity allow/deny decisions for workspace-scope `permissions.allowedExternalFileRoots` entries. It must stay separate from `configService`: those decisions are user-local trust state, not a setting, and must never be persisted into workspace-scope config (a workspace's own settings file only *requests* roots — approval is always a separate, local-only record, see dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md).
</nonObviousBehavior>

<crossFileRelationships>
- `src/types/CtrlYokeSettings.ts` is the schema/defaults source of truth. Changes here usually require config-layer updates.
- `src/utils/ConfigurationUtils.ts` is the preferred accessor layer for the rest of the app. If a setting gains new behavior, add/update a helper there instead of spreading raw `configService.get(...)` calls.
- `src/ui/WebviewSettingsSync.ts` depends directly on `configService.getAll()`, `getNested()`, `set()`, and `getLeafSources()` for the global settings drawer.
- `src/extension.ts` and `src/cli.ts` must initialize config backends before code that depends on resolved settings (for example logging startup decisions).
</crossFileRelationships>

<changeChecklist>
- When adding/changing a setting, update the type and default in `CtrlYokeSettings.ts`, then verify the accessor path in `ConfigurationUtils` and any webview/settings sync code that exposes it.
- If you add a deeper nested settings object, verify `PartialCtrlYokeSettings` is still permissive enough for sparse file writes and CLI overlays.
- Preserve atomic writes in `FileConfigBackend`; interrupted writes must not leave `settings.json` truncated.
</changeChecklist>
