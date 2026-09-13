# Dry Run / Execution Preview Plan

> **Status:** Implemented.
>
> **Priority:** P1

Shipped in this order:

| Layer                        | Where it lives                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Preview DTO + redaction      | `src/types/ExecutionPreviewTypes.ts`, `src/types/PreviewRedactor.ts`                                     |
| Side-effect-free preparation | `PreparedMutation` + `plan*` variants on `ICliProvider`, all six providers                               |
| Shared plan assembly         | `src/core/harness/shared/ExecutionPlanBuilder.ts` (real execution and preview consume the same `plan()`) |
| Prompt payload planning      | `CliPromptPreparer` planning mode with the Tier 1/2/3 size rules                                         |
| Preview service              | `src/core/ExecutionPreviewService.ts`                                                                    |
| CLI                          | `run --dry-run`, `--dry-run --json`                                                                      |
| Dashboard                    | `SegmentedTabBar`, `executionPreviewStore`, `DryRunModal`, three entry points + run-slot accelerator     |

Deliberately deferred, all explicitly out of scope in this document: the lazy
body-fetch optimization, `--fail-on lossy`, the local reveal flow, and the
optional VS Code keybinding.

Two implementation notes worth keeping:

- **Capability probes do not run during preview.** `getVersion()`/
  `checkAvailability()` spawn the harness CLI, which the no-spawn rule forbids.
  The preview service takes a `HarnessCapabilityRegistrySnapshot` as an injected
  dependency instead, so version-dependent diagnostics stay explicitly
  unverified rather than being fabricated.
- **Tier 2 gating caps the preview body, not the upstream read.** Agent and skill
  content reaches the planner already in memory, because `AgentExpander` reads it
  for execution too. Preview therefore reads nothing execution would not have
  read, and the `MAX_CONTENT_SIZE` cap governs what crosses the DTO boundary. An
  ungated `readFile` still exists inside `AgentExpander` itself; tightening it
  would change execution behavior and belongs to its own change.
- **Tier 1's token estimate is a deliberate, scoped exception to "reads nothing
  execution wouldn't."** ctrlyoke's own process never reads a `directFileRefs`
  file during real execution — the harness does — so any read here is new, not
  reused. It was added anyway because the live editor's attachment token count
  already does this same read, uncapped, and a dry-run total that silently
  omits Tier 1 references reads as "much lower" than reality with no visible
  cause. The fix is single-sourced (`FileTokenEstimator.estimateFileTokens`) and
  still refuses the actual failure mode — a single huge allocation — by never
  reading past `MAX_CONTENT_SIZE`; see **Tier 1** below.

---

## Problem

Users cannot inspect the complete execution ctrlyoke is about to prepare:

- resolved variables and inherited properties;
- agent, skill, prior-context, and reference expansion;
- categorized prompt files and their delivery order;
- permission and MCP translation;
- workspace-scoped settings mutations;
- the executable and arguments passed to the harness;
- compatibility warnings or ignored fields.

Running the workflow and reading logs is too late, especially for denied tool
rules, secrets, remote execution, and unattended automation.

## Product Decision

Build one side-effect-free execution-plan service used by the dashboard,
standalone CLI, validation, and future automation API.

Preview must call the same resolvers, prompt builders, capability analyzer, and
provider preparation logic as real execution. It must not maintain a simplified
second command builder.

**A dry run is a snapshot.** It is computed once, from an explicit user action,
and never auto-refreshes — not on keystroke, not on property change, not on any
push from the backend. Every surface that renders a plan renders the plan it was
given. Staleness is surfaced to the user and resolved by the user, never repaired
silently. This is a governing rule, not a UI preference: a preview that changes
while being read cannot be trusted as the thing you are about to run, and the
whole point of the feature is to be that thing.

## Entry Points

### Dashboard

Naming: the action is **Dry Run** everywhere in the UI (matching the CLI
`--dry-run` flag); the surface it opens is the **Dry Run** modal. Do not
introduce a second user-facing noun such as "Preview" or "Execution plan".

Three entry points, all opening the same modal with a different scope:

| Entry point                                                             | Scope    | Surface                                        |
| ----------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| Header **action controls** group — new button between Save and Undo     | workflow | `Header.tsx` (`actionControls` + mobile row 2) |
| Step context menu — **Dry Run Step** item                               | step     | `useStepContextMenu` (steps panel + chip rail) |
| Editor properties drawer — icon button in the **Validation** tab header | step     | `PropertiesDrawer.tsx`                         |

Header placement, in both tiers:

```text
desktop (sm+):  [Save][Dry Run][Undo][Redo][⌄]
mobile row 2:   [Save][Dry Run][Undo][Redo][Search][Explorer][Settings]
```

Same relative order in both, so the button does not move between tiers.

Rationale for each:

- The action-controls group is the only header group with room. It is
  left-anchored next to `WorkflowControls`, near where authoring happens, and on
  narrow mobile it drops to its own row where the execution controls do not
  compete with it. Dry run belongs to the same "working on this definition"
  family as Save.
- **Do not make the run control a `SplitButton`.** The execution group is a
  fixed three-slot group; a split button renders as `[Run][⌄][Pause][Stop]`,
  putting a chevron mid-group and spending a full slot's width on a disclosure
  affordance in the most space-constrained part of the header. The adjacency
  argument (dry run is a kind of run) is real but is served by the accelerator
  below at zero pixel cost.
- The step context menu is the only per-step action surface that already exists;
  a hover button on the step row would compete with drag/reorder affordances.
- The drawer entry point is where harness, model, agent, permission, and MCP
  edits happen, so it is where "what will this actually send?" is asked. It
  previews the step currently open in the editor, including unsaved property and
  text edits.

Zero-space accelerator on the run control: right-click (desktop) or long-press
(`useLongPress`, already used for mobile step context menus) on `slot1` opens a
one-item `StepContextMenu` containing **Dry Run**. This gives the run-adjacency
without consuming layout, and stays a secondary accelerator — the toolbar button
remains the discoverable entry point.

Implementation note: `Header.tsx` renders the Save button and `UndoRedoControl`
at two JSX sites — the `actionControls` group and the mobile row-2 group, which
inlines them rather than reusing `actionControls` because on mobile the whole
toolbar is one `cy-button-group`. Only one mounts at a time, but the new button
must be added to both. Prefer extracting the shared button into a small component
over a third copy.

Rejected entry points: a dedicated always-visible slot in the execution group
(no room); a third tab in the output pane (output tabs are per-run execution
artifacts and would blur the pre-execution/post-execution distinction).

Optional follow-up: a VS Code keybinding registered against the panel, matching
the existing `Ctrl+Shift+*` workflow shortcuts.

Each entry point computes the plan from the current editor state at the moment it
is invoked, including unsaved working-file changes. It does not recompute after
that — see **State and lifetime** below.

### CLI

```text
ctrlyoke run workflow.ctrlyoke.yaml --dry-run
ctrlyoke run workflow.ctrlyoke.yaml --dry-run --var target=auth
ctrlyoke run workflow.ctrlyoke.yaml --dry-run --json
```

Exit without starting a harness, running scripts, or mutating harness settings.
Structured output uses stable diagnostic codes.

## Execution Plan Contract

```typescript
interface WorkflowExecutionPreview {
  workflow: WorkflowPreviewSummary;
  steps: StepExecutionPreview[];
  diagnostics: CompatibilityDiagnostic[];
}

interface StepExecutionPreview {
  stepIndex: number;
  stepId?: string;
  stepName?: string;
  type: "prompt" | "script";
  resolvedProperties: ResolvedPropertiesPreview;
  prompt?: CategorizedPromptPreview;
  command?: CommandPreview;
  permissionApplication?: PermissionApplicationPreview;
  mcpApplication?: McpApplicationPreview;
  workspaceMutations: WorkspaceMutationPreview[];
  variables: VariableResolutionPreview[];
  conditions: ConditionPreview;
  diagnostics: CompatibilityDiagnostic[];
}
```

Use preview-safe DTOs (data transfer objects — plain serializable snapshots with
no methods or live service references) rather than returning runtime service
objects or secrets. Everything preview emits has to survive `JSON.stringify`
across the webview and hosted-server boundaries anyway, and building an explicit
DTO gives redaction a single chokepoint instead of letting consumers reach
through a live object graph.

## What Preview Shows

### Resolved properties

- harness and detected version;
- model;
- execution and continuation mode;
- session behavior without exposing sensitive session content;
- agent, skills, MCP servers, hooks, permissions, limits, and conditions;
- property source: prompt, workflow, or global default.

### Categorized payload

Show each payload category separately and in final delivery order:

- agent instructions;
- skill content;
- prompt text;
- prior context;
- inline-expanded references;
- provider-formatted file references;
- image metadata.

Show the content that would be written to each temporary prompt file without
creating that file. Do not rely on a prompt-length threshold or describe the
current categorized multi-file architecture as one generic temp file.

### Command

Show an argument array as the canonical value and a shell-escaped rendering for
copy/readability:

```typescript
interface CommandPreview {
  executable: string;
  args: string[];
  displayCommand: string;
  displayShell: CommandDisplayShell; // "cmd" | "powershell" | "posix"
  requiresShellVerbatimArgs: boolean;
  cwd: string;
  environmentKeys: string[];
}
```

Never construct `displayCommand` by joining unescaped arguments. Do not expose
environment values.

`displayCommand` defaults to PowerShell quoting on Windows, not cmd.exe —
PowerShell is the default integrated shell for this audience's terminals (VS
Code, Windows Terminal), and cmd.exe's caret-escaped output does not paste
into it (cmd's `^` escape char means nothing to PowerShell, whose own escape
char is a backtick). `DryRunModal`'s Command tab offers a PowerShell/Command
Prompt toggle for Windows commands, re-rendering `args` for the other dialect
client-side via `renderCommandForDisplay`
(`src/types/CommandDisplayFormatter.ts`, dependency-free so it loads in both
the extension host and the webview bundle). The toggle is hidden for POSIX
commands (nothing to toggle to) and for the rare `.cmd`/`.bat` launcher
fallback where `args` is already a fully cmd.exe-escaped verbatim payload
(`requiresShellVerbatimArgs: true`) — re-escaping that for another shell would
mangle it. The default rendering the DTO ships (`displayCommand`) is never
recomputed on the client; only an explicit toggle click substitutes a
re-rendered string, preserving the snapshot rule.

### Permissions and compatibility

Show:

- effective permission mode;
- every allowed/denied rule;
- provider-native translation;
- ignored, partial, unverified, or unsupported rules;
- the exact workspace config path and owned keys that would be changed;
- the workspace-wide side-effect warning;
- harness capability/version diagnostics from
  `HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`.

For security-sensitive settings, "ignored" is a warning by default and can be
promoted to an error by CLI policy.

### MCP, variables, limits, and conditions

- MCP server IDs, transports, tool filters, and injection method;
- variable values after centralized redaction;
- execution guardrails and already-detectable limit violations;
- pre/end-condition configuration without executing scripts;
- retry and error behavior.

## Size Limits and Large Content

Preview must never be the thing that reads a file execution would not have read.
Three tiers, decided by what the real prompt path does with the content.

### Tier 1 — references: `stat()` first, cap the read, same as Tier 2

`PromptSections.directFileRefs` become provider-formatted file references
(`@path`, `#file:`). ctrlyoke passes the path and the harness reads the file, so
preview never embeds this content in the payload — the body shown for a
FILE_REFERENCE section is always just the path, the provider-formatted
rendering, and `stat()` metadata (size, mtime).

The token _estimate_ is a deliberate exception to "preview reads nothing
execution wouldn't": the live editor's attachment token count
(`useAttachmentTokenCount` / `ContextExpander.estimateFileReferenceTokens`)
already reads these files in full to tell the user what they'll cost once the
harness reads them, and the two numbers must agree — a dry run that reports a
much lower total than the editor for the same workflow is worse than one that
does a bounded read. `FileTokenEstimator.estimateFileTokens` (`src/utils/`) is
the single source for both: `stat()` the file; at or under `MAX_CONTENT_SIZE`
(512 KB), read and tokenize exactly with `gpt-tokenizer`; above it, never read —
approximate from the byte size using `ESTIMATED_CHARS_PER_TOKEN` (4,
`DashboardConstants.ts`, the same rule of thumb `PromptFileSplitter`'s
tokenizer-failure fallback already used). A 10 GB file referenced this way still
never allocates.

Emit a diagnostic when a referenced file is implausibly large for the target
harness rather than silently listing it — this fires exactly when the token
estimate falls back to the size-based approximation, i.e. `estimated: true`.
Preview is the right place to learn that before spending a run on it.

### Tier 2 — inlined content: `stat()` first, cap the read

Agent content, skill content, and excerpt content are read by ctrlyoke and
embedded in the payload. These are the only file reads preview performs, and each
one is gated:

1. `stat()` the file;
2. if `size > MAX_CONTENT_SIZE` (512 KB, `DashboardConstants.ts`), do not read —
   record the size and emit a diagnostic;
3. otherwise read, and re-check `Buffer.byteLength` after decoding.

This is exactly `WorkspaceSnapshotService.captureFileState`, which stats first and
falls back to hash-only above the same constant. Reuse the constant; do not
introduce a second size ceiling with a different number.

The 10 GB case therefore never allocates. That is not a theoretical concern here:
the extension host is a Node UtilityProcess and its documented failure mode is a
V8 heap OOM from _a single large allocation on an already-large heap_, which is
precisely what an ungated `readFile` on a huge attachment produces. Preview
running on a debounce while the user types would make it reproducible on demand.

Content that exceeds the cap is still fully represented in the plan — path, byte
count, and a diagnostic — just not rendered. Preview's job at that size is to
tell the user the run will fail, not to display the payload.

### Tier 3 — assembled payload: already chunked, render per file

The categorized payload is not one blob. `PromptFileSplitter` splits it at
`maxTokensPerFile: 10000` / `maxLinesPerFile: 1800` (Claude CLI's per-file
limits), and the plan already commits to showing the content of each temp file
that _would_ be written. So the natural unit of display is one chunk file, each
with a bounded ceiling, and there is no unbounded single body to render.

Prior-context XML is the large case that is not a file read at all: it is built
from prior step outputs by `buildPriorContextXmlFromItems` and can reach
megabytes on a long workflow. It flows through the same splitter, so it previews
as chunks like everything else.

In the modal, render each chunk collapsed by default through the existing
`buildCollapsedOutputPreview` / `formatCollapsedOutputToggleLabel` machinery,
whose `MAX_COLLAPSED_OUTPUT_MAX_CHARS` (100 KB) hard ceiling already exists for
this purpose. That code carries a warning worth honoring here: a single logical
line can hold millions of characters, so a line-count budget must never bypass
the character budget. Minified files and single-line JSON attachments hit this.

### The DTO is its own limit

The preview crosses a `postMessage` boundary and, in hosted mode, a network one.
Because it is computed once per explicit user action rather than continuously,
this is a one-shot cost paid against a spinner — not a per-keystroke cost.

So the plan always carries **metadata** per payload section — category, byte
count, line count, token estimate, chunk index, content hash. It is small,
bounded by step count, and is what Summary and the rail render without touching a
single body. Ship bodies inline alongside it, capped by a total
`MAX_PREVIEW_BODY_BYTES` budget.

Fetching bodies lazily on section expand is a **later optimization, not a
starting requirement**. Take it only if real payloads prove large enough to make
the open-to-render delay noticeable, particularly over a hosted connection. The
metadata/body separation above is what makes that change additive if it is ever
needed; building the lazy-fetch channel up front buys nothing at this cadence.

`--json` on the CLI resolves bodies inline under the same budget; above it,
sections carry metadata plus a truncation marker so the output stays a valid,
stable document.

Truncation must be visible and precise wherever it happens — never a silent cut.
State the byte counts and the reason (`reference`, `over inline cap`,
`chunk collapsed`, `body budget`), so a user reading a preview always knows the
difference between "the harness will not receive this" and "the modal is not
showing you this right now".

## Side-Effect-Free Preparation

Provider preparation currently mixes pure argument construction with file
mutation in some harnesses. Split it into:

1. `plan` — resolve and return arguments, intended files/mutations, payloads, and
   diagnostics;
2. `apply` — perform the planned mutations immediately before process start;
3. `release` — remove owned mutations after the consuming process exits.

Real execution and preview both call `plan`; preview never calls `apply`.

**This contract already exists for permissions — extend it, do not invent a
second one.** `ToolPermissionApplication` in
`src/core/harness/shared/interfaces/IToolPermissionMapper.ts` already returns
`{ cliArgs, workspaceMutation?, diagnostics }`, and `WorkspacePermissionMutation`
already carries `path` plus deferred `apply()` / `restore()` callbacks that
`CliIntegration` invokes at launch time. That is exactly the plan/apply/release
shape, already shipped across all six mappers. The remaining work is bringing the
other side-effecting preparation steps up to it.

The side effects still fused into argument construction are:

- **MCP config files** — `getMcpConfigArgs()` writes a config file as a side
  effect of returning args (`getMcpConfigFilePath()` exists only so cleanup can
  find it afterwards).
- **Hook files** — `buildNotificationHookArgs()` /
  `buildHeadlessUserHookArgs()` write hook settings while returning args, and
  `cleanupPreviousPromptHooks()` deletes the previous prompt's files.
- **Temp prompt files** — `CliPromptPreparer.createCategorizedPromptFiles()`
  writes every categorized chunk through `TempFileManager` before returning the
  reference string.

Each becomes a planned mutation carrying its target path, its intended content,
and a deferred `apply`, so that the argument array is computable without touching
the filesystem.

The assembly itself is currently inline in
`CliIntegration.runExecutionSession()` — `buildCliArgs`, then hook args, then
`prepareToolPermissions`, then `buildCliSuffix`. Extract that ordering into one
shared builder so preview cannot drift from execution by reimplementing the
order; `runExecutionSession()` then becomes plan-then-apply over the same
builder. Preserving the existing arg order exactly is a hard requirement, not a
nicety: the suffix/prepend rules encode real CLI parsing bugs (Codex `resume`
after global flags, Claude hook args before variadic `--disallowedTools`).

## Redaction and Access

**There is no centralized secrets/redaction service yet.**
`SECRETS_AND_REDACTION_PLAN.md` is still Proposed, and the only redaction in the
tree today is `ICliProvider.redactHeadlessStderr()` — a narrow per-provider
stderr scrubber, not a DTO pipeline. Dry run must not block on that plan, and
must not quietly ship without redaction either. It does two things instead:

**1. Structural omission first.** The primary defense is that secrets never enter
the DTO at all, which is stronger than scrubbing them afterwards and cannot be
defeated by a pattern that fails to match. This is already the shape the contract
implies and it must be enforced, not assumed:

- `CommandPreview.environmentKeys: string[]` — key names only. The DTO has no
  field capable of holding an environment value.
- MCP servers contribute IDs, transports, and tool filters. `env` blocks
  contribute key names only.
- Session state contributes presence and resolution source, never content.
- Tier 1 references contribute a path and `stat()` metadata, never bytes.

A value that has no field to live in cannot leak through one.

**2. One chokepoint for what remains.** What genuinely needs value-level
treatment — variable values, hook command strings, inline config fragments — goes
through a single `PreviewRedactor` module that every preview DTO passes through
immediately before it is returned by the preview service, i.e. before any
webview, hosted-server, log, or CLI-output boundary. First version applies
conservative pattern-based masking of common credential shapes plus a
`RedactionRule` list, and marks each masked span so the UI can render _that a
value was redacted_ rather than silently showing a plausible-looking wrong value.

When the central service from `SECRETS_AND_REDACTION_PLAN.md` lands it replaces
the _internals_ of `PreviewRedactor`; the call sites and the DTO shape do not
change. Keeping that single chokepoint is what makes the swap additive, so do not
scatter masking logic into individual builders or into the modal.

- Default to redacted values in the UI and CLI.
- A reveal action, if added, must be local-only, explicit, and separately
  authorized; it must not make hosted transport carry the original secret.
- Do not show authentication tokens, environment values, secret file contents,
  or sensitive session state.
- Copy actions copy the displayed/redacted representation unless the user has
  explicitly entered an approved local reveal flow.

## Dashboard UX

### Surface

A new `DryRunModal` in `src/ui/webview-react/components/shared/`, built on the
shared `Modal` primitive with `size="xl"` and `fullWidthOnNarrow`, and
`bodyClassName="p-0"` so the master/detail layout owns its own padding.

Do **not** extend `ContentPreviewModal`. That component is a single-blob `<pre>`
viewer whose store slice is `{ title, content, language: "diff" | "xml", ref }`;
a dry run is a structured DTO with per-step sections, and widening that union
turns a small component into a dispatcher. `DryRunModal` reuses `Modal`,
`SplitButton`-free footer buttons, and the same copy/export idiom instead.

If the modal later needs side-by-side panes or its own toolbar, promote it to the
full-screen overlay pattern (`WorkspaceViewerModal`, `z-workspace-viewer`) rather
than growing `Modal`'s size vocabulary. A dry run opened from inside the
workspace viewer must pass `elevated` or it renders behind the overlay.

### Layout

Master/detail, because the plan is `steps[]` and the tab set is per step:

```text
┌─ Dry Run — <workflow name> ─────────────────────────── [x] ┐
│ Overview        │ Step 3 · Implement auth    ⬤ claude-cli  │
│─────────────────│──────────────────────────────────────────│
│ 1 Plan       ✓  │ [Summary] [Payload] [Command] [Conditions]│
│ 2 Scaffold   ⚠  │                                           │
│ 3 Implement  ●  │  <active tab body, scrolls>               │
│ 4 Verify     ✓  │                                           │
│─────────────────┴───────────────────────────────────────────│
│ Copy command   Copy payload   Export        [ Run workflow ] │
└──────────────────────────────────────────────────────────────┘
```

- **Left rail** (~200px): a pinned **Overview** entry (workflow summary,
  workflow-level diagnostics, aggregate token contribution, the consolidated list
  of workspace mutations across all steps) followed by one row per step —
  index, name, `HarnessIcon`, and a severity dot for that step's worst
  diagnostic. Below ~640px (`useElementNarrow`) the rail collapses into a
  `CustomSelect` above the tab bar.
- **Right detail**: the four tabs from the contract — **Summary**, **Payload**,
  **Command**, **Conditions**. Tabs are per step, not per workflow; workflow-wide
  information lives in Overview, which has no tabs.
- Step scope (context menu / drawer entry) opens the same component with the rail
  hidden and no Overview entry. One component, a
  `scope: { kind: "workflow" } | { kind: "step"; index: number }` prop.

### Tab bar

The tab bar is visually the drawer's, but `DrawerTabBar` is hardwired to
`DRAWER_TABS` / `DrawerPage`. Extract the rendering into a generic
`SegmentedTabBar` in `components/shared/` that takes its tabs as a prop, and
reduce `DrawerTabBar` to a thin wrapper over it. Both then share the active
underline, hover, and icon-override behaviour instead of forking it.

Reuse `TabIconOverride` from `tabBadgeUtils.ts` to drive tab state: the Summary
tab shows `codicon-warning` in `text-warning-fg` (or `text-error-fg`) when that
step carries diagnostics; Permissions-affecting steps reuse the existing
`getPermissionTabOverride` colours so the same permission mode reads the same in
the drawer and in the dry run.

### Footer

- **Copy command** — copies `displayCommand` as displayed (redacted). This is
  the exact invocation ctrlyoke will run, not a guaranteed standalone
  paste-and-run command: it may reference categorized prompt/hook/MCP files
  that preview never writes (preview performs no `apply()`). The tooltip says
  so; there is deliberately no separate "runnable" variant that reconstructs a
  different command, since the plan's single-source-of-truth rule (**Product
  Decision**) forbids a second command builder.
- **Copy payload** — copies the categorized payload of the active step as one
  plain-text document, sections joined in delivery order: `FILE_REFERENCE`
  sections render their provider-formatted reference marker (never file
  content), other sections render their `body`, and a section with no body
  (cut by a size or budget cap) renders a bracketed placeholder naming the
  truncation reason instead of silently vanishing. This is for pasting into a
  harness ctrlyoke does not natively support — it is prose, not the DTO; use
  **Export** for the structured JSON.
- **Export** — mirrors `ContentPreviewModal.handleExport`: `downloadTextFile` of
  the JSON plan when `isStandalone`, otherwise `EXPORT_CONTENT_PREVIEW` so VS
  Code opens it as an editor document.
- **Run workflow** (primary) — closes the modal and dispatches the normal run
  path. It must re-dispatch through the existing run message, never "execute the
  previewed plan object": workspace state may have drifted since the plan was
  computed, which the non-goals already acknowledge.

There is no **Open temp file** action because preview creates no temp files.

### State and lifetime

**Compute once, on open. Do not recompute while the modal is open.**

The modal is modal: `Modal` renders a full-screen backdrop that intercepts clicks
and closes on Escape, so no dashboard control that feeds the plan — harness,
model, agent, permissions, variables, attachments, step text — is reachable while
it is up. There is no edit to react to, and a debounced recompute would be
answering a question nobody asked.

Add an `executionPreviewStore` following the `compatibilityStore` precedent: a
snapshot plus a `"checking" | "ready"` status, populated by one request on open
and cleared on close. Requests still carry a monotonic token, but only so a
response from a dismissed-and-reopened modal cannot land in the current one.

The plan can still go stale from outside the dashboard — a direct edit to the
working file, a CLI-managed run, or another hosted client, since multiple browser
tabs can view the same workflow at once.

Handle that with a **"Definition changed — Refresh" banner**: record the
`displayedDefinitionRevision` the plan was computed from and compare it against
the current value. The plumbing already exists and already covers the remote
case — `RUN_VIEW_LOADED` snapshots arrive requestless from replay/invalidation
paths carrying `definitionRevision`, and `useMessageHandler` maintains a
per-address monotonic definition head from them. So an edit in another tab
reaches this client without new transport work.

The banner is not cosmetic. That same pushed snapshot replaces `workflowStore`
content underneath the open modal, so without it the modal would keep rendering a
plan for a definition the dashboard no longer holds, with nothing on screen
saying so.

Refresh is a button. It recomputes only when pressed. The banner must never
auto-dismiss itself by refreshing, per the snapshot rule in **Product Decision**.

`analyzeCompatibility` and `resolveExecutionProperties` in `src/types/` are
already shared between webview and backend and are what `useCompatibilityDiagnostics`
calls. The preview service must call those same functions, so a diagnostic never
has two implementations and the dashboard and CLI emit identical codes. Anything
the client can already derive synchronously stays client-side; the backend plan
supplies only what the client cannot see — capability probes, provider-native
permission translation, resolved argument arrays, and workspace mutation targets.

### Redaction at the UI boundary

The modal renders the redacted DTO as received and never holds an unredacted
copy. Copy actions copy the rendered string, matching `ContentPreviewModal`'s
existing behaviour. A local reveal flow is out of scope for the first version.

## CLI Behavior

- Human output groups diagnostics before step details.
- `--json` returns the full redacted preview contract.
- Add policy flags only if needed after the compatibility analyzer exists, for
  example `--fail-on lossy`.
- Exit nonzero for invalid workflow/provider combinations. Lossy and unverified
  behavior follow the selected validation policy.

## Testing

- Golden tests compare preview plans with the plan consumed by real execution.
- Assert preview performs no harness spawn, script execution, config write, temp
  file write, or session mutation.
- Cover categorized multi-file prompts and every provider.
- Cover redaction at DTO, webview-message, hosted-transport, log, and CLI output
  boundaries.
- Assert structural omission directly, not just masking: give a step an MCP
  server with an `env` block and a secret-bearing environment, then assert the
  serialized DTO contains the key names and does not contain the values
  anywhere in `JSON.stringify(plan)`. This test must fail if someone later adds
  a value-carrying field, which a masking-only test would not catch.
- Cover unsupported/partial permission rules and workspace mutation previews.
- Verify command display escaping independently on Windows and POSIX.
- Assert preview performs no `readFile` above `MAX_CONTENT_SIZE` on a Tier 1
  reference (token estimate falls back to the size-based approximation instead)
  or on Tier 2 content — both by spying on the fs layer, not by asserting on the
  rendered output. Assert a Tier 1 reference at or under the cap gets an exact
  token count matching `gpt-tokenizer`'s `encode()`.
- Cover a single-logical-line payload of millions of characters (minified file)
  to prove the character budget is not bypassed by the line budget.
- Dashboard tests in `src/ui/webview-react/test/**`: each entry point opens the
  modal with the right scope, the rail collapses below the narrow breakpoint, the
  plan is requested exactly once per open, and a response arriving after close
  cannot populate a subsequently reopened modal.
- Assert the snapshot rule directly: with a modal open, push a definition change
  and verify the rendered plan is byte-identical afterwards and only the banner
  appears; then verify Refresh is what replaces it.

## Acceptance Criteria

- A user can see the complete redacted payload and command before execution.
- Preview and real execution consume the same immutable plan.
- Categorized prompt delivery is represented accurately.
- Every ignored/lossy provider translation is visible.
- Workspace-setting side effects are named before execution.
- Preview does not mutate the workspace or harness state.
- A displayed plan never changes except by explicit user action (Refresh, or
  reopening). No input event, timer, or backend push rewrites it.
- CLI and dashboard diagnostics use the same codes and severities.

## Non-goals

- Running pre/end-condition scripts.
- Resolving a "latest session" by opening or changing session state.
- Creating temporary prompt or harness config files.
- Live/continuously-updating preview. A dry run is a snapshot; keeping one in
  sync with ongoing edits is explicitly not a goal.
- Guaranteeing that external workspace state will not change between preview and
  execution.
