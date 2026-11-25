# Copilot `auto` runs are recorded as model "auto" and priced as another vendor's "auto" model

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced with a real `copilot --model auto` session log)
- **Area:** `src/core/harness/copilot/CopilotLogParser.ts` (~752-755, ~1063), `src/core/WorkflowExecutor.ts` (~3959-3966), `src/utils/ModelPricing.ts` (~215-239), `src/utils/ModelPricingRegistry.ts` (`resolveModelPricingFromRegistry`), `src/utils/ModelConstants.ts` (`COPILOT_AUTO_MODEL`, `getHarnessModelDisplayName` ~502-518)
- **Resolution:** fixed in this commit

## Symptom

3678baf9e added `auto` to the Copilot model list. With `--model auto`, Copilot's
`session.start` carries `"selectedModel":"auto"`, and it then logs the model it picked:

```
{"type":"session.auto_mode_resolved","data":{"chosenModel":"gpt-6-luna","autoTier":"balance",...}}
```

(each `session.usage_record` also carries `usage.model`). ctrlyoke ignores both:

- The attempt's model is recorded and shown as "auto" instead of the model that ran.
- When per-model usage from OTel spans is not available, the cost falls back to
  `getModelPricing("copilot-cli", "auto")`. The `github-copilot` provider bucket has no
  `auto`, so the registry's cross-provider exact-key sweep returns provider **morph**'s
  `auto` model ($0.85/$1.55 per MTok). In the sample session that priced the attempt at
  $0.063 against $0.0071 for the chosen model, about 9× too high, with source
  `price-table` (looks authoritative). User price overrides are also looked up under
  "auto".

## Steps to Reproduce

1. Run a Copilot step with `model: auto` (or feed a real `auto` session's
   `~/.copilot/session-state/<id>/events.jsonl` to `CopilotLogParser.extractResponse`).
2. Observe `metadata.model === "auto"`.
3. `calculateAttemptCost` without `modelUsage` → `{ usd: 0.063, source: "price-table", modelId: "auto" }`;
   `getModelPricingFromRegistry("copilot-cli", "auto")` returns the morph entry.

## Root Cause

`CopilotLogParser` takes `model` only from `session.start.data.selectedModel`, which is
the requested alias. Pricing then treats the alias as a real model id, and the registry's
cross-provider fallback matches an unrelated model that happens to be named `auto`.

## Suggested Fix

1. In `CopilotLogParser.extractResponse`, handle `session.auto_mode_resolved` and set the
   model to `data.chosenModel` (add the event type to `COPILOT_EVENT_TYPES`); fall back to
   the latest `session.usage_record.usage.model` when present.
2. Never price `COPILOT_AUTO_MODEL` itself: if the chosen model is unknown, treat the
   model as unknown (no price-table estimate) rather than sweeping other providers for an
   `auto` key.
3. Tests: a parser fixture with `selectedModel: "auto"` plus `auto_mode_resolved`
   reports the chosen model; pricing for `copilot-cli`/`auto` does not resolve to another
   provider's model.
