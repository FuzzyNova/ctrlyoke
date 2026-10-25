# Copilot model discovery "retry after timeout" never runs in production

- **Found:** 2026-10-24 by bug-drain review of ddaf7d973
- **Area:** `src/utils/ModelRegistry.ts`
- **Resolution:** fixed in this commit

## Symptom

After a cold-start timeout of `copilot help config`, the fallback Copilot model
list stays for the whole session, the original symptom of
`dev/bugs/implemented/copilot-model-discovery-5s-timeout-falls-back-silently.md`.
`isRegistryInitialized()` also stays `false` for the whole session, so
`CopilotCliProvider.validateAndGetModel` (around line 507) skips model validation
for every Copilot step. The CHANGELOG line about retrying "on a later registry
initialization" describes something that never happens.

## Root Cause

`ModelRegistry.ts` (around lines 98-108) only retries if something calls
`initializeModelRegistry()` again. The only callers are one-shot startup calls in
`src/extension.ts` (around line 431) and `src/platform/NodeHostServices.ts` (around
line 337). The test calls `initializeModelRegistry()` twice by hand, so it passes
while the production path stays broken.

## Suggested Fix

After a Copilot discovery timeout, schedule one background re-query (an `unref`'d
timer, e.g. 30 s, with a small retry cap), or re-query lazily the next time the model
list is read (picker / getter), sharing one in-flight promise. Once it succeeds, mark
the registry initialized. Keep registry-level validation working for the fallback
list in the meantime. Test the production path: a single `initializeModelRegistry()`
whose first discovery times out must later expose the discovered models without a
second manual call. Fix the CHANGELOG wording to match.
