# CliIntegration Wiring Cleanup Plan

**Date:** April 2, 2026  
**Status:** Proposed  
**Scope:** Post-split cleanup of harness composition and dependency wiring

---

## Problem

`CliIntegration` was split into smaller helper classes, which improved responsibility
boundaries, but the composition layer is now noisy and harder to read. The main
symptoms are:

1. Large constructor dependency objects in `CliIntegration`.
2. Static helpers and static logging methods being passed in as dependencies even
   when the callee could import them directly.
3. Detached provider methods needing `bind(...)`, which is a sign that some
   provider behavior is being passed around at the wrong abstraction level.
4. Mixed dependency styles: some helpers receive narrow function bags, some
   receive service objects, and some receive both.

The recent headless bug around `augmentParsedOutput` confirmed this is not just a
style concern. The current wiring shape can create real correctness bugs when
instance methods are detached from their owning object.

---

## Quick Search Findings

The pattern appears to be concentrated in the harness composition layer rather
than spread evenly across the repository.

### Primary hotspots

- `src/flightpath/harness/CliIntegration.ts`
  - `createInteractiveStartupCoordinator()`
  - `createResponseCollector()`
  - `createServices()`:
    - `CliPromptPreparer`
    - `CliSessionResolverAdapter`
    - `CliPromptRuntimeCoordinator`
    - `CliTransportCoordinator`
    - `CliExecutionRunner`
- `src/flightpath/harness/shared/CliExecutionRunner.ts`
  - `new CliLogMonitor({ ... })`

### Specific smells seen in the search

- `logger: { debug/info/warn/error }` objects created inline repeatedly
- `logDebug` / `logInfo` callback injection for classes that could import `Log`
  directly
- static helper callback injection such as:
  - `extractTextFromEvents`
  - `formatStatistics`
- detached provider method wiring:
  - `augmentParsedOutput`
  - `extractSessionIdFromLogs`

This suggests the cleanup should start in the harness composition layer, not as a
repo-wide mechanical refactor.

---

## Cleanup Goals

1. Make `CliIntegration` easier to scan by reducing inline wiring noise.
2. Remove dependency injection for static helpers and static logging where no
   runtime substitution is needed.
3. Keep provider-specific behavior attached to the provider object instead of
   passing detached methods.
4. Preserve testability without over-injecting everything.
5. Make dependency boundaries more consistent across the extracted helper
   classes.

---

## Proposed Design Direction

### 1. Stop injecting static helpers and static loggers

If a class always uses `Log` or a static formatter/parser helper and there is no
real need to swap that behavior in tests, the class should import and call it
directly.

Good candidates:

- `CliResponseCollector`
  - import `CliLogMonitor.extractTextFromEvents` replacement logic locally or
    move that extraction helper into a shared utility module
  - import `CliOutputFormatter.formatStatistics` directly
  - import `Log` directly for debug logging
- `CliPromptPreparer`
  - remove `logDebug` / `logInfo` injection if the class always logs through the
    shared logger
- other helper classes with inline `logger: { ... }` bags that only forward to
  `Log`

### 2. Pass cohesive service objects instead of detached method bags

When behavior is truly provider-owned, prefer passing the provider itself or a
small adapter interface rather than individual instance methods.

Good candidates:

- `CliResponseCollector`
  - replace:
    - `responseParser`
    - `augmentParsedOutput`
    - `extractSessionIdFromLogs`
  - with either:
    - `provider: ICliProvider`, or
    - a narrower `CliResponseProviderAdapter`

This avoids `bind(...)` and makes it clearer that these behaviors are part of one
cohesive provider abstraction.

### 3. Group host-owned callbacks into explicit role objects

Where callbacks must still come from `CliIntegration`, group them by role instead
of leaving them as a flat dependency bag.

Examples:

- `hostCallbacks`
  - `logResponse`
  - `onResponseComplete`
- `runtimeState`
  - `getWorkspaceRoot`
  - `isCancelling`
  - `setFailureReason`

This keeps constructor signatures readable without overexposing the whole parent
class.

### 4. Keep narrow DI only where it buys real testability

Not every callback is bad. Narrow injection still makes sense for:

- state mutation callbacks into `CliIntegration`
- event emitters
- seams where tests genuinely need replacement behavior
- environment/process abstractions

The cleanup should remove accidental DI, not all DI.

---

## Suggested Refactor Phases

### Phase 1 - `CliResponseCollector`

This is the best first target because it already produced a real bug.

Changes:

1. Stop passing static helpers and logger methods into the constructor.
2. Replace detached provider method fields with a provider or provider adapter.
3. Keep only host callbacks that are truly integration-owned.

Expected result:

- simpler `createResponseCollector()`
- no `bind(...)`
- less risk of detached-method bugs

### Phase 2 - Inline logger bag cleanup

Review extracted helper classes and remove injected logger bags that only forward
to `Log`.

Candidates:

- `CliInteractiveStartupCoordinator`
- `CliPromptPreparer`
- `CliSessionResolverAdapter`
- `CliPromptRuntimeCoordinator`
- `CliTransportCoordinator`

Expected result:

- smaller factory code in `CliIntegration`
- fewer repetitive `logger: { ... }` blocks

### Phase 3 - Composition shape cleanup

Refactor `createServices()` and related factories so dependency objects are
organized around roles instead of long flat bags.

Examples:

- provider-owned deps
- host callbacks
- runtime/environment services

Expected result:

- easier-to-scan composition code
- more consistent helper boundaries

### Phase 4 - Secondary follow-up in nested compositions

After `CliIntegration` is cleaned up, review secondary factories like
`CliExecutionRunner -> CliLogMonitor` for the same pattern and align them with
the same rules.

---

## Non-Goals

- Do not collapse helper classes back into `CliIntegration`.
- Do not replace all dependency injection with global imports indiscriminately.
- Do not do a repo-wide logger refactor as part of this cleanup.
- Do not change runtime behavior or workflow semantics while cleaning up the
  wiring shape.

---

## Guardrails

1. Treat this as a readability and abstraction cleanup first, not a feature
   change.
2. Preserve existing test seams where they meaningfully reduce setup cost.
3. Avoid passing the full `CliIntegration` object into helpers.
4. Prefer small cohesive adapters over very wide interfaces.
5. Validate that headless and interactive flows still behave identically after
   each phase.

---

## Recommended First PR

Start with `CliResponseCollector` only.

That delivers the highest value with the smallest scope:

- it removes the recent `bind(...)` wart
- it fixes the abstraction at the exact point where the bug surfaced
- it gives a concrete pattern to apply to the rest of the harness if the result
  reads better
