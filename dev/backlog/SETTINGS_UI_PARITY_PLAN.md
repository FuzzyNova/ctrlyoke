# Settings Schema UI Parity Plan

> **Status:** Not implemented. Tracked by
> `src/test/integration/settingsSchemaUiParity.integration.test.ts`
> (`Settings schema -> Global Settings dashboard control parity` ›
> `every leaf settings-schema property has a live dashboard control`), which
> allowlists the gaps below in its `PENDING_UI_PARITY` list. As each gap gets
> a dashboard control, remove its path from `PENDING_UI_PARITY` and re-run the
> test — it fails if a listed path no longer has a missing control, so a
> forgotten removal can't hide a future regression in that same setting.

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

```powershell
npm run compile-tests
$env:MOCHA_GREP = "Settings schema"; node ./out/test/runTest.js; $env:MOCHA_GREP = $null
```

## Current gaps (7)

| Setting | Section it belongs in | Disposition |
| --- | --- | --- |
| `server.theme` | intentionally not surfaced (for now) | **Not a gap yet — leave as-is.** The VS Code-hosted dashboard (`ServerSection.tsx`'s process) always follows the VS Code theme; there's nothing for this setting to control there. It's meant for the standalone `ctrlyoke server` headless CLI process's own dashboard, which doesn't exist yet — same story as `server.standalonePort` below. Give it a control once the standalone server ships and gets its own settings surface. |
| `usageTracking.enabled` | `StatsUsageSection` (or `AdvancedPermissionsSection`) | **Add control.** Master switch for workspace quota/observed-usage collection; currently only settable by hand-editing `settings.json`. |
| `usageTracking.providerRefreshEnabled` | `StatsUsageSection` | **Add control.** Gate for provider quota refresh calls. |
| `usageTracking.persistObservedUsage` | `StatsUsageSection` | **Add control.** Whether normalized observed usage is persisted to the workspace. |
| `usageTracking.warningPercentUsed` | `StatsUsageSection` | **Add control.** Numeric threshold (0–100) for quota warnings. |
| `modelPricing` | none yet — needs its own editor | Per-harness/per-model USD rate overrides (`inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok`, `cacheWritePerMTok`, `reasoningPerMTok`) keyed by an open-ended `harness -> model -> rates` map. There's no natural fixed-key list to render (unlike `defaults.models`, which iterates the 6 known harnesses) since model IDs are freeform strings. Needs its own small editor (add/remove harness, add/remove model, five rate fields per model) before it can get a control — worth scoping as its own task rather than folding into the `usageTracking` batch above. **Design resolved (2026-08-21): the setting is a generic per-harness/per-model override of whatever `getModelPricing` would otherwise resolve from the downloaded models.dev registry (`src/utils/ModelPricingRegistry.ts`) — it must not special-case which harnesses are eligible.** What blocked two harnesses from calculating an estimate at all turned out to be separate bugs, not reasons to scope them out of the editor — see "Related fixes" below. |
| `server.standalonePort` | intentionally not surfaced | **Not a gap — leave as-is.** `ServerSection.tsx` already documents why: it configures the standalone `ctrlyoke server` headless CLI process, which doesn't exist yet (`dev/active/STANDALONE_SERVER_PLAN.md` Phases 5–10 are unimplemented). The schema/type/default are kept so the standalone feature can use it later with no config migration. This test will keep flagging it until the standalone server ships and gets its own settings surface (not the VS Code `ServerSection`, which controls a different process) — that's expected, not a bug in the test. |

`defaults.secrets` is done — see "Completed" below. Of the remaining 7, 5 are straightforward
additive UI work; `modelPricing` needs its own small editor now that its design is resolved;
`server.theme` and `server.standalonePort` are both intentionally deferred until the standalone
server ships and should stay in `PENDING_UI_PARITY` as markers until then.

### Related fixes surfaced while scoping `modelPricing`

Cost estimation is a token-usage-based proxy ("what would this have cost at list price"), not a
mirror of the harness's actual billing mechanism — ctrlyoke already shows an estimate for
Claude/Codex even though both are commonly used on flat-rate subscriptions, not billed per token.
Auditing why Copilot and Qwen show no estimate at all found two unrelated bugs, neither of which
is "this harness's billing model makes an estimate meaningless":

- **Copilot — pure policy bug, fixed 2026-08-21.** `HARNESS_TOKEN_SEMANTICS[COPILOT_CLI]` already
  declared known cache/reasoning semantics, and `CopilotLogParser` already extracts a model ID and
  input/output token counts per attempt — every input `calculateTokenCost` needs was already
  available. `calculateAttemptCost` just short-circuited on `harnessId === COPILOT_CLI` before ever
  consulting the price table. Fixed by removing that early return and adding Copilot prices.
  `ATTEMPT_COST_UNAVAILABLE_REASONS.COPILOT_BILLING_UNIT` was removed as part of this fix — it had
  no other reader. **Superseded shortly after by the pricing registry:** the hand-typed
  `MODEL_PRICING` table this bullet originally described no longer exists. `getModelPricing`
  (`src/utils/ModelPricing.ts`) now resolves every harness through
  `getModelPricingFromRegistry` (`src/utils/ModelPricingRegistry.ts`), backed by
  `src/utils/generated/modelPricingRegistryData.json`, downloaded from models.dev by
  `npm run sync-model-pricing`. There is no hand-maintained price table left to add a model to.
- **Qwen — the price gap closed, the semantics gap did not.** The registry does carry Alibaba
  pricing (including `qwen3.5-plus`), so "no bundled Qwen entries" is no longer why Qwen shows no
  estimate. What still blocks it is `HARNESS_TOKEN_SEMANTICS[QWEN_CLI]` being `UNKNOWN`/`UNKNOWN`:
  ctrlyoke does not know whether Qwen's cache-read tokens are counted inside or on top of `prompt`,
  or whether reasoning tokens are folded into output. That's missing empirical verification against
  a real `qwen` CLI run, not a policy choice — filling in a guess would silently produce a
  confidently-wrong number, which is worse than no estimate. `opencode-cli` and `antigravity-cli`
  are in the same unverified state. Verifying those three is its own task, tracked separately from
  this plan.

## Implementation constraints found while scoping the remaining work (2026-08-21)

- **`StatsUsageSection` is not currently wired for settings writes.** `GlobalSettingsDrawer.tsx`
  passes `{...sectionProps}` (`activeScope` / `onUpdate` / `onReset`) to every other settings
  section but gives `StatsUsageSection` only `hideCost` / `isNarrow` / `settings`. Its one existing
  settings control (`StatusLineTrackingControls`) works around that by posting
  `UPDATE_GLOBAL_SETTING` itself with a hard-coded `SETTING_SCOPES.USER`. Any new control here
  should thread `sectionProps` through properly rather than copying that workaround.
- **`usageTracking.enabled` is machine-scoped.** It is listed in
  `WORKSPACE_FORBIDDEN_SETTING_ROOTS` (`CtrlYokeConfigService.ts`), so a workspace-scope write
  throws. Follow the `worktrees.root` pattern in `WorktreesSection.tsx`: disable the control while
  `activeScope === SETTING_SCOPES.WORKSPACE` and render the short "switch to User scope" note. The
  other three `usageTracking.*` settings are ordinary scope-aware settings.
- **`modelPricing` must be written as one whole object at path `modelPricing`.** Setting writes
  are dot-path writes (`CtrlYokeConfigService.set` → backend `set(path, value)`), and real model
  IDs contain dots (`qwen3.5-plus`, `gpt-4.1`), so a per-model path like
  `modelPricing.qwen-cli.qwen3.5-plus.inputPerMTok` would silently nest under bogus `5-plus` keys.
  Use the aggregate-editor convention instead — `path="modelPricing"` on the `SettingInputRow`
  plus `onUpdate("modelPricing", nextWholeObject)` — exactly as `DefaultsMcpPage.tsx` does for
  `defaults.mcpServers`. `getLeafSources` records object paths as well as leaves, so the source
  badge and reset button still work at that path.
- **An override alone does not make an estimate appear for every harness.** `calculateAttemptCost`
  requires *both* a price and verified token semantics; for `qwen-cli`, `opencode-cli`, and
  `antigravity-cli` it returns `UNVERIFIED_TOKEN_SEMANTICS` regardless of any override. The editor
  should say so where the user enters rates for those harnesses, rather than implying the override
  will start producing a cost.

## Completed

| Setting | Where | Notes |
| --- | --- | --- |
| `defaults.secrets` | `DefaultsHarnessPage.tsx`, "Agent & Skill Defaults" section | Reuses `SecretGrantsEditor` (shared with `PropertiesDrawer.tsx`/`PromptEditor.tsx`) inside a `SettingInputRow` for the source badge/reset button. Added a `hideLabel` prop to `SecretGrantsEditor` so it doesn't duplicate the row's own label. |

## Rejected

| Setting | Reason |
| --- | --- |
| `usageTracking.enterpriseUsageApisEnabled` | **Removed from the schema entirely (2026-08-21), not deferred.** Researched what it would actually gate: every provider's "enterprise" usage surface (Anthropic's Admin/Enterprise Analytics API, GitHub's org/enterprise Copilot usage-metrics REST API, ChatGPT Enterprise's Analytics/Compliance APIs) requires a separate org-admin-provisioned credential for cross-user/org-wide reporting, not a richer view of one developer's own usage — confirmed empirically for Copilot, where the personal `account.getQuota` response is identical on a personal vs. enterprise seat. ctrlyoke is an individual-developer tool; org-wide reporting is what the provider's own admin console is for. The setting was also unwired dead scaffolding — never read outside its own schema/type/default declarations. See `dev/implemented/HARNESS_USAGE_TRACKING_PLAN.md` Phase 3 for the full writeup. |
| `usageTracking.preferredFallbackOrder` | **Removed from the schema entirely (2026-08-21) along with the feature it supported.** The setting only ever fed a "consider switching to harness Y" suggestion appended to the near-limit warning message (`UsageSelectionAssist.findFallbackHarness`); it had no effect on whether the warning fired. Product call: the warning's job is to report that a queued harness is low on quota, not to recommend a replacement — that choice belongs to the user, not to a setting they'd have to configure first. Removed `findFallbackHarness`/`orderedHarnessIds`/`isComparableWindow`/`fallbackHarnessId` along with the setting; the warning message now ends after the reset time. See `dev/implemented/HARNESS_USAGE_TRACKING_PLAN.md` Phase 5 for the full writeup. |

## Suggested sequencing

1. ~~`defaults.secrets` — reuse `SecretGrantsEditor`, same page as `defaults.agent`/`defaults.skills`.~~ Done.
2. The four simple `usageTracking.*` toggles/numbers (`enabled`, `providerRefreshEnabled`,
   `persistObservedUsage`, `warningPercentUsed`) as one batch in `StatsUsageSection`.
3. `modelPricing` — scope its own editor as a separate task.
4. Leave `server.theme` and `server.standalonePort` in `PENDING_UI_PARITY` until
   `dev/active/STANDALONE_SERVER_PLAN.md` ships.

### Staging vs. `STATUSLINE_FORMAT_CUSTOMIZATION_PLAN.md`

**No strict dependency either direction — the two plans can be worked in parallel, or in either
order.** Checked for real coupling (2026-08-21) and found none: this plan's remaining work (the
four `usageTracking.*` toggles above, the `modelPricing` editor) is about data-collection/cost
settings; the statusline plan is about display formatting. Neither reads or depends on the other's
settings or code paths.

Both plans edit `StatsUsageSection.tsx`, but in disjoint regions: this plan's toggles land near
the top (where they gate the stats rendered below); the statusline plan's only edit to that file
is *removing* its "Statusline Tracking" block (moved to a new dedicated "Status Line" settings
tab) and adding a `percentDirection` control. Whichever plan lands first, the other's diff doesn't
meaningfully conflict with it.

**One operational watch-item, not a blocker.** The statusline plan introduces a brand-new schema
leaf, `usageTracking.percentDirection`, sitting in the same `usageTracking` object this plan's
`settingsSchemaUiParity.integration.test.ts` already inventories. If that plan's schema addition
and its own UI control for that setting ever land in *separate* merges, this test will flag a new
gap in the interim — fix, if it happens, is adding `permissions.usageTracking.percentDirection` to
`PENDING_UI_PARITY` here, same as any other tracked-but-not-yet-controlled setting, until the
statusline plan's own UI phase lands.
