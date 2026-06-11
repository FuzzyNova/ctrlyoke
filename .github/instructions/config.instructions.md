---
applyTo: "src/config/**"
---

<purpose>
Platform-agnostic settings resolution for shared core code. `src/config/` owns the merge logic and file-backed persistence; the rest of the repo should consume settings through `configService` and usually through `ConfigurationUtils`, not by reading files or VS Code settings directly.
</purpose>

<architecture>
- `FlightPathConfigService` is the singleton merge layer. Priority order is: defaults → user file → workspace file → CLI overlay.
- `FileConfigBackend` is the current persistence backend. `ConfigBackend` intentionally stays tiny (`getAll` + `set`) so other storage backends can plug in without changing merge logic.
- Merge semantics are recursive for plain objects; arrays and primitives replace lower-priority values wholesale.
</architecture>

<nonObviousBehavior>
- `resolve()` only reports the source for a **top-level** key. The webview settings UI uses `getLeafSources()` for per-path badges/reset state.
- `getLeafSources()` records both leaf paths **and object paths**. Do not “simplify” that away: aggregate editors in `WebviewSettingsSync` rely on object-path entries to show source/reset state for grouped settings.
- `getLeafSources()` only reflects user/workspace backends. CLI overlay values are intentionally excluded from that per-setting map.
- The main CLI mostly overlays only explicitly passed flags, but it **always** writes the effective `execution.mode` into the overlay so shared code sees the real interactive/headless mode even when that came from TTY detection instead of a flag.
- `FileConfigBackend.startWatching()` exists for external-edit invalidation but is not part of normal startup wiring today. Normal writes go through `configService.set(...)`, which already calls `notify()`.
</nonObviousBehavior>

<crossFileRelationships>
- `src/types/FlightPathSettings.ts` is the schema/defaults source of truth. Changes here usually require config-layer updates.
- `src/utils/ConfigurationUtils.ts` is the preferred accessor layer for the rest of the app. If a setting gains new behavior, add/update a helper there instead of spreading raw `configService.get(...)` calls.
- `src/ui/WebviewSettingsSync.ts` depends directly on `configService.getAll()`, `getNested()`, `set()`, and `getLeafSources()` for the global settings drawer.
- `src/extension.ts` and `src/cli.ts` must initialize config backends before code that depends on resolved settings (for example logging startup decisions).
</crossFileRelationships>

<changeChecklist>
- When adding/changing a setting, update the type and default in `FlightPathSettings.ts`, then verify the accessor path in `ConfigurationUtils` and any webview/settings sync code that exposes it.
- If you add a deeper nested settings object, verify `PartialFlightPathSettings` is still permissive enough for sparse file writes and CLI overlays.
- Preserve atomic writes in `FileConfigBackend`; interrupted writes must not leave `settings.json` truncated.
</changeChecklist>
