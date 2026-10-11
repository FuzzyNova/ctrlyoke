# Model pricing editor says Qwen, OpenCode and Antigravity costs are unavailable

- **Found:** 2026-10-11 by Claude while writing `docs/guide/usage-and-stats.md`
- **Area:** `src/ui/webview-react/components/shared/ModelPricingEditor.tsx`
- **Resolution:** fixed in this commit

## Symptom

In **Settings → Stats & Usage → Model pricing overrides**, adding a model override for Qwen
Code, OpenCode or Antigravity CLI shows a warning: "Cost estimates remain unavailable for this
harness until its token semantics are verified, even when these rates are overridden." But
cost estimates for those harnesses are calculated and shown. The same tab's harness share list
shows `≈$0.38` for Qwen Code, for example.

## Steps to Reproduce

1. Open **Settings → Stats & Usage**.
2. Under **Model pricing overrides**, pick Qwen Code and add a model.
3. The warning appears, while the tab's own Qwen Code totals already include a cost.

## Root Cause

`UNKNOWN_TOKEN_SEMANTICS_HARNESSES` (`ModelPricingEditor.tsx:24-28`) still lists
`QWEN_CLI`, `OPENCODE_CLI` and `ANTIGRAVITY_CLI`. The token-semantics table now covers all six
harnesses, so the set and the note at lines 277-290 are left over from before that.

## Suggested Fix

Delete the set and the note, or derive "unknown" from the token-semantics source of truth so the
two cannot drift again. Update `ModelPricingEditor`'s tests to match.
