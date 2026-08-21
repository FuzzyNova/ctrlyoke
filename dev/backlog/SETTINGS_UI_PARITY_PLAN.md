# Settings Schema UI Parity Plan

> **Status:** Not implemented. Tracked by a deliberately-failing test:
> `src/test/integration/settingsSchemaUiParity.integration.test.ts`
> (`Settings schema -> Global Settings dashboard control parity` ›
> `every leaf settings-schema property has a live dashboard control`).
> Leave that test red until the gaps below are closed or reclassified — do not
> add a `KNOWN_MISSING` allowlist to silence it.

## Goal

`schemas/settings-schema.json` is the source of truth for what a person can put in
`.ctrlyoke/settings.json`, but most users configure ctrlyoke through
`GlobalSettingsDrawer.tsx` and its section components, not by hand-editing JSON. Every
schema-authorable setting should have a live dashboard control unless there's a written
reason it can't yet (e.g. the feature it configures isn't built).

## How the inventory was produced

`settingsSchemaUiParity.integration.test.ts` walks every leaf property in
`settings-schema.json` and checks the webview source for a live control:

- Direct match: the section component threads `path="dot.notation.path"` into
  `SettingInputRow`/`SettingToggleRow` (the convention used almost everywhere —
  see `GeneralSection.tsx`, `HarnessesSection.tsx`, etc.).
- Indirect match: a few controls reference a shared `SETTING_PATHS.SOME_KEY` constant from
  `DashboardConstants.ts` instead of writing the literal path inline (statusline tracking).
- Template match: per-harness maps (`defaults.models`, `defaults.additionalArgs`) and the
  hook-event toggle list (`notifications.events.hookEvents.*`) are rendered by looping over a
  fixed key set and building the path with a template literal
  (`` `defaults.models.${harnessId}` ``); those are matched by the template's literal prefix.

Re-run it after adding a control to confirm the gap closed:

```
npm run compile-tests
MOCHA_GREP="Settings schema" node ./out/test/runTest.js
```

## Current gaps (10)

| Setting | Section it belongs in | Disposition |
| --- | --- | --- |
| `defaults.secrets` | `WorkflowDefaultsSection` (harness/context page) | **Add control.** Default secret env-var names granted to new workflows. `HarnessesSection`/`DefaultsHarnessPage` already has `defaults.agent`/`defaults.skills` pickers right next to where this belongs; reuse `SecretGrantsEditor` (already used per-workflow in `PropertiesDrawer.tsx`/`PromptEditor.tsx`) instead of building a new editor. |
| `server.theme` | `ServerSection` | **Add control.** `auto`/`light`/`dark` for the hosted dashboard's own theme — straightforward `CustomSelect` next to bind address / port. |
| `usageTracking.enabled` | `StatsUsageSection` (or `AdvancedPermissionsSection`) | **Add control.** Master switch for workspace quota/observed-usage collection; currently only settable by hand-editing `settings.json`. |
| `usageTracking.providerRefreshEnabled` | `StatsUsageSection` | **Add control.** Gate for provider quota refresh calls. |
| `usageTracking.persistObservedUsage` | `StatsUsageSection` | **Add control.** Whether normalized observed usage is persisted to the workspace. |
| `usageTracking.enterpriseUsageApisEnabled` | `StatsUsageSection` | **Add control.** Opt-in for enterprise usage API calls — should probably sit near the provider-refresh toggle with a short explanation of what it contacts. |
| `usageTracking.warningPercentUsed` | `StatsUsageSection` | **Add control.** Numeric threshold (0–100) for quota warnings. |
| `usageTracking.preferredFallbackOrder` | `StatsUsageSection` | **Add control.** Ordered harness fallback list — needs a reorderable multi-select, more UI work than the others in this group; consider bundling all six `usageTracking.*` gaps into one PR since they share a section and a mental model. |
| `modelPricing` | none yet — needs a decision | **Needs a decision**, not a small add. Per-harness/per-model USD rate overrides (`inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok`, `cacheWritePerMTok`, `reasoningPerMTok`) keyed by an open-ended `harness -> model -> rates` map. There's no natural fixed-key list to render (unlike `defaults.models`, which iterates the 6 known harnesses) since model IDs are freeform strings. Needs its own small editor (add/remove harness, add/remove model, five rate fields per model) before it can get a control — worth scoping as its own task rather than folding into the `usageTracking` batch above. |
| `server.standalonePort` | intentionally not surfaced | **Not a gap — leave as-is.** `ServerSection.tsx` already documents why: it configures the standalone `ctrlyoke server` headless CLI process, which doesn't exist yet (`STANDALONE_SERVER_PLAN.md` Phases 5–10 are unimplemented). The schema/type/default are kept so the standalone feature can use it later with no config migration. This test will keep flagging it until the standalone server ships and gets its own settings surface (not the VS Code `ServerSection`, which controls a different process) — that's expected, not a bug in the test. |

9 of the 10 are straightforward additive UI work; `modelPricing` needs its own small design
pass first; `server.standalonePort` is intentionally deferred and should stay in the failing
list as a marker until the standalone server work lands.

## Suggested sequencing

1. `server.theme` — smallest, single `CustomSelect`, no new editor component.
2. `defaults.secrets` — reuse `SecretGrantsEditor`, same page as `defaults.agent`/`defaults.skills`.
3. The five simple `usageTracking.*` toggles/numbers (`enabled`, `providerRefreshEnabled`,
   `persistObservedUsage`, `enterpriseUsageApisEnabled`, `warningPercentUsed`) as one batch in
   `StatsUsageSection`.
4. `usageTracking.preferredFallbackOrder` — needs a reorderable list control; do after the
   simple toggles land so the section has a home for it.
5. `modelPricing` — scope its own editor as a separate task.
6. Leave `server.standalonePort` failing until `STANDALONE_SERVER_PLAN.md` ships.
