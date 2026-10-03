# Editor attachment token count double-counts overlapping prior-context references

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reviewing 8f317f5cd (code reading only)
- **Area:** `src/ui/webview-react/hooks/useAttachmentTokenCount.ts`
- **Severity:** low

## Symptom

A prompt containing overlapping prior-context references, e.g. `$previous` and
`$previous:3`, or `$previous:3` plus a `$step:N` that falls within those three
steps, shows a higher attachment token estimate than what runs. At runtime they
attach 3 outputs, but the editor counts 1 + 3 outputs plus two wrappers.
`$previous` and `$previous:1` mean the same thing but get different cache keys
(`previous` vs `previous:1`).

## Root Cause

`useAttachmentTokenCount` makes one count key per reference (~122-130) and sums
each reference's preview count (~250-257). The runtime
(`RunOutputResolver.resolvePriorContextItems`, ~912-935 and ~992-996) merges all
references into one request: it takes the largest N across them and removes
duplicate items.

## Suggested Fix

Count a prompt's prior-context references together with one combined preview
request, reusing the runtime's merge rules rather than re-implementing them. At
minimum, have `formatInlinePriorContextBody` write `{ count: 1 }` as `previous`
so equivalent spellings share a key. It's only an estimate, so this is low
priority.

## Decision

Decided 2026-10-03 (obvious, no input needed): single-source the merge rules. Move the runtime's prior-context merge (the largest N across references, minus duplicate items) out of `RunOutputResolver.resolvePriorContextItems` into a pure helper that the webview can import. `useAttachmentTokenCount` uses it to build one combined preview request per prompt instead of one per reference. This also makes `$previous` and `$previous:1` share a key. Low priority.
