# Compatibility, Permission, and Feedback Staging

> **Complete as of 2026-08-01 — retained as the record of how the 0.1.0
> permission gate was sequenced.** Every step in its queue landed. Forward-looking
> work in these plans is sequenced by
> [`FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md`](FEEDBACK_AUTOMATION_COMPATIBILITY_STAGING.md),
> which supersedes this document and drops its release-gate framing. Do not add
> new steps here.

**Decided 2026-08-01.** Implementation order for three interlocking plans:

- [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)
  — the capability registry, analyzer, and pure effective-property resolver.
- [`TOOL_PERMISSION_PARITY_PLAN.md`](../implemented/TOOL_PERMISSION_PARITY_PLAN.md)
  — the first consumer of that registry.
- [`BROWSER_USER_FEEDBACK_PLAN.md`](./BROWSER_USER_FEEDBACK_PLAN.md)
  — the toast queue, feedback sink, and interaction contract.

This document owns only **sequencing and the dependency argument**. Each plan
remains the source of truth for its own scope, phases, and acceptance criteria;
do not restate their content here.

Roadmap context: the first two are P0 gates for 0.1.0
([`ROADMAP.md`](../active/ROADMAP.md) P0 item 5). The third is unprioritized.

---

## The question this settles

> Does the compatibility/permission work depend on the browser feedback work?

**No — and not in the other direction either.** The compatibility plan
explicitly rules toast out as its authoring surface, and every UI primitive
both P0 plans need already ships:

| Need                             | Already exists                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Field warning border + text      | `warning` prop on `CustomSelect` / `MultiCheckboxDropdown` / `SkillsSelect`     |
| Warning/error styling helpers    | `dropdownBorderClass` / `dropdownWarningClass` in `utils/dropdownValidation.ts` |
| Blocking preflight result dialog | `components/shared/Modal.tsx`                                                   |
| Runtime diagnostic delivery      | existing dashboard status/output message path                                   |

The only place the permission plan ever wanted a new modal was the OpenCode
workspace-lease conflict, and that scope is retired: OpenCode now delivers
permissions through `OPENCODE_CONFIG_CONTENT` and writes no workspace
`opencode.json`, so there is no lease, no conflict, and no conflict UX.

Each plan's header carries a matching "No dependency on" note. If a future
change makes one depend on the other, update all three together.

### The one real interaction, and it favors this order

Browser feedback Phase 2 triages ~63 `vscode.window.show*Message` sites in
reusable code, several of which live in files the compatibility work touches
(`WorkflowOrchestrator`, `PromptFileLoader`). Doing compatibility first
**shrinks** that inventory: the compatibility plan forbids adding new
`show*Message` calls and routes runtime diagnostics through the dashboard
status/output path instead. There is no corresponding benefit to the reverse
order.

---

## Current state (verified 2026-08-01)

Detail lives in each plan's status header. The summary that drives sequencing:

- **Permission parity — provider work landed.** Qwen's stream-json input-format
  fix, OpenCode's inline config, and the pinned real-harness fixtures are all
  in. `getPermissionHarnessSupport()` has already dropped OpenCode.
- **Compatibility — Phases 1A–1C complete.** The registry, analyzer, client
  snapshot, honest permission surfaces, and hosted-browser transport coverage
  are in place. Runtime permission preparation and the remaining Antigravity
  statusline-lease scope are also complete; post-release portability reporting
  remains deferred.
- **Browser feedback — Phase 1 built.** The bounded toast queue and viewport
  are in, while the Phase 2.5 Site 1 and Site 2 deletions remain complete.
  `USER_FEEDBACK` transport and the broader `show*Message` migration remain
  deferred to later phases.

Two shipped defects are worth naming because they shape Stage 0 below:

1. **`uiStore.showToast()` renders nothing, in either host.** Roughly 19 call
   sites — save failures, image-paste errors, "Saved as template" — set state
   no component reads. This is not only a hosted-browser gap; the VS Code panel
   drops them too.
2. **Mode-only harnesses disable the tool-list fields.** A Codex-default
   workflow cannot author the Allowed/Denied Tools that its Claude override
   steps would enforce.

---

## Recommended order

### Stage 0 — two small independent fixes (optional interleave)

Neither item is a release gate, and neither touches a file Stage 1 touches
(the only overlap is additive constants in `DashboardConstants.ts`). Both fix
defects in what is shipping today.

1. **[x] Delete `handleMaxRetriesExhausted`** — browser feedback Phase 2.5 Site 2. **Done 2026-08-01.**
   Under default settings (`maxRetries: 0`, `onFail: stopWorkflow`) _every_
   end-condition failure raises a host-only modal that contradicts the declared
   policy and hangs any remotely driven run. Report the expected/actual values
   through the existing status/output path now; upgrade to `USER_FEEDBACK` when
   Stage 2 lands.
2. **[x] Browser feedback Phase 1** — the toast queue, `ToastViewport`, and the
   `isStandalone` gate on `NOTIFICATION_EVENT`. Small, self-contained, and the
   panel-double-notification regression it risks is covered by the prescribed
   test. **Done 2026-08-01.**

**If you would rather keep the release gate clean, defer both.** Nothing in
Stage 1 changes either way.

**Decided 2026-08-01: both Stage 0 items are in, and both have landed.** They
fix defects in already-shipped behavior rather than adding surface, are the
smallest work in this document, and touch no file Stage 1 touches. Landing them
first cost the gate nothing and removed a run-hanging modal from remotely
driven workflows before any of the registry work started.

### Stage 1 — the P0 release gate

Order is prescribed by the plans themselves and is not negotiable at the
margins: the honest UI is built directly on the registry, and adding a
temporary harness switch while waiting for it is explicitly forbidden.

1. **[x] Compatibility Phase 1A** — shared contracts and the pure
   effective-property resolver.
2. **[x] Compatibility Phase 1B** — permission descriptors, registry assembly,
   analyzer, preflight, client snapshot.
3. **[x] Compatibility Phase 1C** — honest permission UI across every
   authoring surface (`TOOL_PERMISSION_PARITY_PLAN.md` "Compatibility Phase
   1C"). **Done 2026-08-01.**
4. **[x] Permission plan stages 4–7** — the runtime preparation contract, the
   remaining Antigravity statusline-lease scope, and Qwen/OpenCode fixture
   retention. **Done 2026-08-01.**

Two sequencing hazards worth restating here because they are cheap to get
wrong:

- **1A is the highest-risk change in the gate and must land as its own
  reviewable commit.** It is an extraction from `PropertyResolver.ts`, which
  sits on the live execution path. In particular the `hostCanProvidePty` mutable
  static (`PropertyResolver.ts:106`) must become an explicit
  `ExecutionResolutionContext` input — leaving it behind while adding a second
  pure caller produces two resolvers that disagree depending on entrypoint
  startup order.
- **1C is a behavior change, not a message change.** Deleting
  `getPermissionHarnessSupport()` is only half of it; its `"mode-only"` value is
  also wired into `disabled` props and `opacity-50 cursor-not-allowed` classes
  in `WorkflowPropertiesPanel.tsx` and `PropertiesDrawer.tsx`. Those must come
  out in the same change, or the new analyzer will emit correct diagnostics for
  fields the user still cannot edit.

### Stage 2 — post-release

1. **Browser feedback Phases 2 → 3 → 4.** Phase 2 is the largest single chunk
   across all three plans (~136 call sites of triage) and gates nothing that
   ships in 0.1.0.
2. **Compatibility Phase 2** — dry run, portability report, CLI/MCP
   serialization. Already descoped to P1 (2026-07-31).
3. **Codex partial-support investigation.** Open-ended research whose honest
   answer may be "no safe general mapping exists"; explicitly outside the gate.

---

## Queued implementation sequence

The stages above are split into these single-session steps. Each one commits its
own work and leaves this document and its owning plan current. Steps are
strictly ordered: each builds only on what has already landed.

| #   | Stage         | Scope                                                                                                     |
| --- | ------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Stage 0.1     | **Done** — delete `handleMaxRetriesExhausted` and honor the declared `onFail`/`maxRetries` policy         |
| 2   | Stage 0.2     | **Done** — Browser feedback Phase 1 — toast queue, `ToastViewport`, `isStandalone` gate                   |
| 3   | Phase 1A(i)   | **Done** — shared capability + diagnostic contracts and their constants                                   |
| 4   | Phase 1A(ii)  | **Done** — pure effective-property resolver extracted from `PropertyResolver`                             |
| 5   | Phase 1B(i)   | **Done** — harness-owned permission descriptors, registry assembly, cached version detection              |
| 6   | Phase 1B(ii)  | **Done** — pure compatibility analyzer wired into execution preflight                                     |
| 7   | Phase 1B(iii) | **Done** — capability-snapshot message, React store, `useCompatibilityDiagnostics`                        |
| 8   | Phase 1C(i)   | **Done** — `FieldDiagnostic`, `getPermissionHarnessSupport` deleted, honest UI in both property editors   |
| 9   | Phase 1C(ii)  | **Done** — defaults page, advanced permissions help, tooltips/schema docs, hosted-browser parity coverage |
| 10  | Perm. 4       | **Done** — `IToolPermissionMapper.prepare()` / `ToolPermissionApplication` runtime preparation contract   |
| 11  | Perm. 5–7     | **Done** — remaining Antigravity statusline-lease scope; Qwen/OpenCode pinned-fixture retention           |

Stage 2 is deliberately not queued: it is post-release by decision of the plans
themselves.

---

## Why browser feedback is not in the gate

Its own Decision section gives two arguments for urgency. Both have weakened:

- _"Narrowing `PlatformAdapter` gates `STANDALONE_SERVER_PLAN.md` Phase 5."_
  True, but standalone server is deferred out of 0.1.0
  ([`RELEASE_PLAN.md`](RELEASE_PLAN.md) §2.11), so this creates no release
  pressure.
- _"Two `showChoice()` sites block execution on a modal a remote user cannot
  see."_ Both are now deleted, independently of the transport work.

What remains — 63 reusable `show*Message` sites invisible to hosted-browser
users — is a genuine parity gap, but it is a gap in an already-shipped surface
rather than a dishonest capability claim. The permission work is the one that
would otherwise ship telling users a denial is enforced when it is not.

---

## What would change this recommendation

- A decision to pull standalone server back into 0.1.0 — that would promote
  browser feedback Phases 1–2 into the gate.
- Evidence that Codex or Antigravity has a usable granular-policy mechanism —
  that would move the Codex investigation out of Stage 2 and enlarge 1B.
- Any new compatibility surface that needs transient rather than persistent
  feedback — that would create the dependency this document currently denies.
