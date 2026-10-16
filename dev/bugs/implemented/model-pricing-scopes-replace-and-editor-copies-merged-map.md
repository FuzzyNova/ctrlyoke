# `modelPricing` scopes replace each other per harness, and the editor copies the merged map into the scope being edited

- **Found:** 2026-10-15 by bug-hunt final step (claude-cli)
- **Area:** `src/config/CtrlYokeConfigService.ts`, `src/ui/WebviewSettingsSync.ts`, `src/ui/webview-react/components/settings/stats/StatsUsageSection.tsx`
- **Resolution:** fixed in this commit

## Symptom

1. **Merge.** If the workspace sets any price for a harness, it replaces the
   user's whole price table for that harness. With user
   `{ "claude-cli": { "opus": {…} } }` and workspace
   `{ "claude-cli": { "sonnet": {…} } }`, the effective value is only
   `{ "claude-cli": { "sonnet": {…} } }`, so the user's `opus` override silently
   stops affecting cost estimates. `docs/guide/settings.md` says "Objects merge
   key by key".
2. **Editor copy.** The Model Pricing editor is given the merged value and
   writes the whole object back to the scope selected in the drawer.
   - Adding one price on the User scope (the drawer's default) writes every
     workspace entry into `~/.ctrlyoke/settings.json`, so they then apply in
     every project.
   - On the Workspace scope, it writes the user's personal entries into the
     shared, committed workspace file.

## Steps to Reproduce

1. Put the user and workspace values above in the two settings files.
2. `configService.getAll().modelPricing` returns only the workspace's
   `claude-cli` table. Reproduced with the compiled `CtrlYokeConfigService`.
3. Open Settings → Stats & Usage on the User scope and add a price for any
   model. `~/.ctrlyoke/settings.json` now also contains the workspace's
   `sonnet` entry. (Found by reading the code; not run in the UI.)

## Root Cause

- `deepMerge` (`CtrlYokeConfigService.ts` ~209–240) recurses only where the
  setting's schema default is a plain object. `modelPricing` defaults to `{}`,
  and `modelPricing.<harness>` has no default, so the harness-level value is
  replaced, not merged.
- `StatsUsageSection.tsx` ~383 passes `settings.settings.modelPricing` (the
  merged result of `configService.getAll()`, sent from `WebviewSettingsSync`)
  to `ModelPricingEditor`, and `onChange` writes the whole map to the active
  scope. Settings that need scope-exact editing are sent per scope instead
  (`templateVariableDefaultsByScope`, `externalFileRootsByScope`); `modelPricing`
  is not.

## Suggested Fix

- Send `modelPricing` per scope the same way as `templateVariableDefaultsByScope`
  (message payload type, `WebviewSettingsSync`, dashboard store), and have the
  editor read and write only the active scope's map.
- Make the effective value merge per model: merge `modelPricing` two levels
  deep (harness → model) in `deepMerge`, or resolve per model in
  `ConfigurationUtils.getModelPricingOverride` (workspace model entry over user
  model entry). Keep the docs statement true.
- Tests: config-service merge of user and workspace harness tables, and a
  dashboard test that saving on the User scope writes only the user map.
