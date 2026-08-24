# Allow/Deny Tool List Completion Editor Plan

> **Status:** Not implemented.

## Goal

Replace the plain `<textarea>`/`LocalTextarea` fields used for tool permission
allow/deny lists with a CodeMirror-based editor that offers completions for
known tool patterns (`read`, `write`, `shell(...)`, etc.) and flags invalid
pattern syntax with inline diagnostics — the same quality bar the prompt and
script editors already have, applied to a field that today is unassisted
plain text.

## Why

`SingleLineCompletionEditor.tsx` + `ScriptCommandEditor.tsx` already prove the
pattern this needs: a CodeMirror shell with a completion source fed by a
request/response round trip to the extension host (`useCompletionRequest`,
`MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST/RESPONSE`,
`PromptEditorSupportService.handleScriptCompletionRequest`). The allow/deny
list fields never got the same treatment because they're one-line-per-item —
`SingleLineCompletionEditor` hard-codes single-line behavior (fixed 26px
height, newline stripped on paste/type, Enter blurs instead of inserting a
line), so it can't be reused for a multi-line list as-is.

Tool patterns also have real syntax to get wrong — unclosed
`shell(git:*` parens, a stray `*` with no enclosing parens (see
`CliToolPermissionMapper.validatePatterns()`, which already detects both) —
and users currently get no feedback until a run fails or a compatibility
diagnostic fires after the fact.

## Current State

Plain `<textarea>`/`LocalTextarea` allow/deny fields, one pair per surface:

| Surface                          | File                                                                   | Commit behavior                                |
| -------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Workflow-level Permissions tab   | `WorkflowPropertiesPanel.tsx` (~L2179–L2269)                           | every keystroke (`onChange` posts immediately) |
| Global defaults Permissions page | `components/settings/defaults/DefaultsPermissionsPage.tsx` (~L49–L102) | on blur, via `LocalTextarea`/`useLocalInput`   |

Both split/join on `\n` and store `string[]` (`toolPermissions.allowedTools` /
`.deniedTools`). Both already have compatibility diagnostics layered on top
(`FieldDiagnostic`, `PermissionCapabilitySummary`) — this plan only adds
_syntax_ linting, it doesn't touch that existing per-harness support
reporting.

**Out of scope:** `McpServerForm.tsx`'s per-server `autoApprove`/`deniedTools`
textareas (~L312–L339 and its sibling) use a different vocabulary — bare tool
names _defined by that specific MCP server_, not the `shell(...)`/canonical
patterns this plan covers. Offering real completions there needs a live tool
listing from the configured server, which is a separate feature. Worth a
follow-up once this lands, not bundled here.

## Proposed Design

### 1. Extend the completion editor to support multi-line

Generalize `SingleLineCompletionEditor.tsx` in place rather than forking a
second component: add a `multiline?: boolean` prop (default `false`, so
`ScriptCommandEditor` and every other current caller is unaffected). When
`multiline` is true:

- Skip `singleLineTransactionFilter` (no newline stripping) and the
  paste-newline-scrubbing in `handlePaste`.
- Swap `singleLineTheme`'s fixed `26px`/`overflow:hidden` box for a
  flexible-height theme — no `height`/`overflow:hidden` on `&`, so the
  wrapper's `flex-1 min-h-[Npx]` (matching how the current textareas size
  themselves inside `WorkflowPropertiesPanel`'s `FormField`) drives height
  the same way `CodeMirrorEditor`'s `minHeightClassName`/`maxHeightClassName`
  props do. Keep `.cm-gutters { display: none }` — no line-number gutter, to
  stay visually close to the textarea it replaces.
- Drop the `Prec.highest` Enter binding that accepts-or-blurs. In multiline
  mode, plain `Enter` should fall through to `minimalSetup`'s default
  `insertNewlineAndIndent`; only wire `Enter`/`Tab` to `acceptCompletion`
  when a completion popup is actually open (`acceptCompletion` already
  no-ops and returns `false` otherwise, so this is just _not_ adding the
  "else blur" fallback for the multiline case).
- Everything else — the completion round-trip plumbing, compartments for
  `disabled`/`aria-*`, viewport/tooltip repositioning, `syncDocument`'s
  external-value diffing — is identical and shared as-is.

The implementation keeps the existing filename and export rather than
renaming it to `CompletionEditor.tsx`; multiline behavior is a prop on the
shared component.

**Implemented:** Item 1 is implemented by keeping the existing
`SingleLineCompletionEditor.tsx` file and export, with a `multiline` prop for
the flexible-height behavior.

### 2. New completion source: tool permission patterns

Mirror the `ScriptCommandEditor` → `ScriptCommandCompletionHelpers.ts` split:

- **`src/completions/PermissionListCompletionHelpers.ts`** (extension host,
  Node-side): builds completion candidates for the _current line's_ pattern,
  not the whole document (allow/deny lists are one pattern per line, so
  context is line-scoped — mirrors `parseScriptCompletionContext`, but
  simpler: split on `\n`, find the line at `position`, offer candidates
  filtered by what's typed so far on that line).
  - Bare tool names: `read`, `write`, `edit`, `multiedit`, `glob`, `grep`,
    `ls`, `webfetch`, `todowrite`, `bash`, `shell`. **Single-source these
    from `COPILOT_TO_CLAUDE_MAP`'s keys** in
    `src/core/harness/shared/CliToolPermissionMapper.ts` — don't hand-maintain
    a second list that can drift from the canonical Copilot-format tool
    vocabulary already used by every permission mapper.
  - `shell(` / `bash(` snippet completions with a small curated set of
    common argument patterns (`git:*`, `npm:*`, `npx:*`, `docker:*`,
    `curl:*`, a bare `*`), inserted with the cursor left inside the
    parens — same spirit as `ScriptCommandCompletionHelpers`'s
    `STATIC_CANDIDATES`, just for shell-permission arguments instead of
    runnable commands.
  - No attempt at dynamic MCP tool name completion in this pass (see
    Non-Goals) — `<mcp-server>(tool)` patterns are typed freehand and simply
    won't trigger a false "unrecognized" lint error (see linter section).
- **Message plumbing**: add `PERMISSION_COMPLETIONS_REQUEST`/`_RESPONSE` to
  `MESSAGE_TYPES` (`DashboardConstants.ts`) and their payload shapes to
  `WebviewMessageTypes.ts`, register the request in
  `WebviewMessageRouter.ts` (`registerEditorSupport`, alongside
  `SCRIPT_COMPLETIONS_REQUEST`), and add
  `PromptEditorSupportService.handlePermissionCompletionRequest()` that
  calls the new helper and emits the response — same shape as
  `handleScriptCompletionRequest`.
- **`src/ui/webview-react/components/shared/PermissionListEditor.tsx`**:
  wraps the multiline completion editor exactly like `ScriptCommandEditor`
  wraps the single-line one — `useCompletionRequest` +
  `PERMISSION_COMPLETIONS_REQUEST`/`RESPONSE`, `buildScriptCompletionResult`'s
  analog for permission items, plus the syntax linter extension (below).
  Props: `value: string[]` / `onChange: (value: string[]) => void` (join/split
  on `\n` internally) so callers don't repeat that conversion at every call
  site — today's four call sites (two in `WorkflowPropertiesPanel`, two in
  `DefaultsPermissionsPage`) all do their own `.join("\n")` /
  `.split("\n").map(trim).filter(Boolean)`, which this component should own
  once instead of four times (DRY).

### 3. Syntax linter

Pure client-side and synchronous — unlike the context-reference linter in
`CodeMirrorEditor.tsx`, this needs no extension-host round trip, since
pattern syntax is just a regex shape. Add via `@codemirror/lint`'s
`linter()`, one `Diagnostic` per offending line:

- **Single-source the pattern regex.** `CliToolPermissionMapper.parsePattern()`
  (`/^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/`) is defined in
  `src/core/harness/shared/CliToolPermissionMapper.ts`, which pulls in
  `utils/Log.ts` (Node/extension-host only) and isn't safe to import into the
  webview bundle. Extract the regex (and the "wildcard without parens" /
  "unclosed parens" checks already written for
  `CliToolPermissionMapper.validatePatterns()`) into a small dependency-free
  module — e.g. `src/utils/ToolPatternSyntax.ts`, no `vscode`/Node imports —
  that both `CliToolPermissionMapper` (extension host) and the new webview
  linter import. This removes the current duplication risk instead of adding
  a third copy of the same regex.
- Diagnostics per line:
  - Blank line: skip (not an error; matches today's `filter(Boolean)` on
    commit).
  - Doesn't match the pattern regex at all: `error`, "Invalid pattern syntax".
  - Contains `(` with no matching `)`: `error`, "Unclosed parentheses".
  - Contains `*` outside any `(...)`: `warning`, "Wildcard needs enclosing
    parentheses, e.g. `shell(*)`" (mirrors the existing
    `validatePatterns()` warning message).
  - Bare tool name not in the canonical list from `ToolPatternSyntax.ts` and
    not shaped like `word(...)`: leave unflagged — this is the escape hatch
    for MCP server tool names (`github(search)`) and any future tool this
    list hasn't been taught about yet. Only _shape_ is linted, not vocabulary
    completeness, so the linter never blocks a valid-but-unrecognized entry.

### 4. Roll out to call sites

Replace the four textareas with `<PermissionListEditor>`:

- `WorkflowPropertiesPanel.tsx`: swap both `<textarea>` blocks (Allowed
  Tools / Denied Tools), keeping the existing `disabled` logic
  (`permMode !== PERMISSION_MODES.CUSTOM` /
  `permMode === DANGEROUSLY_ALLOW_ALL || NONE`), `aria-describedby` wiring to
  `FieldDiagnostic`, and the `fieldValidationBorderClass` styling hook (the
  new component needs an equivalent "invalid state" className passthrough,
  or that border logic moves onto the wrapper `div` the same way
  `SingleLineCompletionEditor`'s `className` prop is documented to work
  today — no vertical padding added to the wrapper).
- `DefaultsPermissionsPage.tsx`: swap both `LocalTextarea` fields. This page
  commits on blur (`useLocalInput`), which `PermissionListEditor` doesn't
  natively provide (CodeMirror editors here fire `onChange` per keystroke,
  like `SingleLineCompletionEditor` already does). Wire it the same way
  other CodeMirror-backed fields defer a commit: local `useState` synced from
  the prop, updated on every `onChange`, committed via `onUpdate(path, value)`
  in the editor's existing `onBlur` callback — same effective contract as
  `LocalTextarea`, just implemented at the call site instead of inside a
  native `<textarea>`.

## Affected Components

| Component                                                  | Planned role                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SingleLineCompletionEditor.tsx`                           | Gains `multiline` support; single-line callers unaffected                                             |
| `src/completions/PermissionListCompletionHelpers.ts` (new) | Line-scoped completion candidates for tool patterns                                                   |
| `src/utils/ToolPatternSyntax.ts`                          | Implemented: shared, dependency-free pattern regex + syntax checks (extension host + webview)         |
| `src/core/harness/shared/CliToolPermissionMapper.ts`       | Implemented: adopts `ToolPatternSyntax.ts` instead of its own inline regex                            |
| `PromptEditorSupportService.ts`                            | New `handlePermissionCompletionRequest()`, mirroring `handleScriptCompletionRequest`                  |
| `WebviewMessageRouter.ts`                                  | Registers `PERMISSION_COMPLETIONS_REQUEST`                                                            |
| `DashboardConstants.ts` / `WebviewMessageTypes.ts`         | New message type + payload contracts                                                                  |
| `components/shared/PermissionListEditor.tsx` (new)         | Wraps the multiline editor + completion source + linter; owns `string[]` ↔ `\n`-joined conversion     |
| `WorkflowPropertiesPanel.tsx`                              | Allowed/Denied Tools fields on the workflow Permissions tab                                           |
| `components/settings/defaults/DefaultsPermissionsPage.tsx` | Allowed/Denied tools fields on the global defaults page                                               |

## Decisions Deferred to Implementation

- The multiline variant stays as a `multiline` prop on the existing
  `SingleLineCompletionEditor.tsx` file and export; no rename to
  `CompletionEditor.tsx` is planned.
- Exact curated list of `shell(...)`/`bash(...)` argument snippets beyond the
  handful named above — expand based on what's actually common in existing
  workflow fixtures/templates.
- Whether lint diagnostics also get a `lintGutter()` dot marker or stay
  underline-only (textareas today have no gutter at all; underline-only is
  the closer visual match, but a gutter dot makes multiple errors in a long
  list easier to scan).

## Non-Goals

- Dynamic MCP-server tool name completion (`<server>(tool)` argument
  suggestions sourced from a live server tool listing). The linter's
  "unrecognized bare name" rule is deliberately permissive so this can be
  added later without a breaking change to what's accepted. See Follow-Ups
  below — this is deferred, not rejected.
- Any change to `McpServerForm.tsx`'s per-server `autoApprove`/`deniedTools`
  fields (different vocabulary — see Current State, and Follow-Ups below).
- Harness-compatibility diagnostics (already covered by
  `FieldDiagnostic`/`PermissionCapabilitySummary`/`compatibilityDiagnostics.ts`)
  — this plan is syntax-only.

## Follow-Ups

Raised while scoping this plan. None of these are required for the allow/deny
list work above to ship; recommendations below are about whether they're
worth a _future_ plan of their own.

### 1. `KeyValueMapEditor.tsx` as a CodeMirror editor with lint/completions

**Recommend: yes, but scoped down from full parity with the permission-list
editor.** `KeyValueMapEditor` (`KEY=value` per line, used for MCP server
env/headers and end-/pre-/script-condition `env`) already has two
textarea-adjacent affordances bolted on: a "looks like a pasted credential"
warning paragraph (`findLiteralCredentialEnvKeys`) and, when
`allowSecretReferences` is set, a separate `<select>` below the textarea to
insert a `${secret:NAME}` reference. Both map cleanly onto the CodeMirror
primitives this plan already introduces:

- The credential-heuristic warning becomes a per-line lint `Diagnostic`
  (squiggly under the offending value) instead of a block paragraph below
  the whole field — same detection logic, more precise placement.
- A silently-duplicate `KEY=` (second occurrence wins in the `Record`, first
  is lost with no signal today) becomes a real lint error — this is a
  genuine footgun the plain textarea can't surface at all.
- `${secret:` inline completions (triggered while typing a value) can
  replace the separate "Insert secret reference…" `<select>`, using the same
  secret-name source (`useSecretRegistryStore`) the select already reads.

What I would **not** carry over from the tool-permission editor: bare-name
tool completions. There's no closed vocabulary for env/header _keys_ — they're
arbitrary, user- and server-defined — so there's nothing meaningful to
complete on the key side, only lint + secret-reference completions on values.
Scope this as "lint + secret completions," not "tool-name completions for
KEY=VALUE," and it's a solid, self-contained follow-up.

### 2. Live MCP tool-name completions (`McpServerForm.tsx` auto-approve/deny lists, and the workflow allow/deny list)

Two related asks, both blocked on the same missing capability, so grouping
them:

- `McpServerForm.tsx`'s `autoApprove`/`deniedTools` textareas (~L312–L339 and
  its sibling) — per-server tool names, 100% freehand today with zero
  validation; a typo silently no-ops.
- Whether the _workflow-level_ `toolPermissions.allowedTools`/`deniedTools`
  list (the one this plan's `PermissionListEditor` covers) is "another spot
  where users can approve or deny MCPs" — **confirmed yes.** Per
  `schemas/workflow-schema.json`'s `deniedTools` description for a
  per-server entry, MCP tool patterns in the _main_ allow/deny list use the
  `mcp__<serverid>__<tool>` shape (Claude CLI's native format), distinct
  from the per-server `deniedTools` field's bare-name shape. So a workflow
  author can and does write `mcp__github__search` directly into the same
  Allowed/Denied Tools fields this plan is adding completions to — today
  with no help at all, same as the server-scoped fields above.

**Recommend: yes, this is the highest-value item of the three follow-ups**
— unlike CLI tool names or env keys, MCP tool names are arbitrary,
case-sensitive, and defined entirely by the target server, so freehand entry
is the worst-assisted case of anything in this doc. But it's gated on real
new infrastructure that doesn't exist yet: nothing in ctrlyoke currently
lists a configured MCP server's tools. `ManagedMcpServer`
(`WebviewMessageTypes.ts`) carries `id`/`displayName`/`config`/`locations` —
no `tools` field — and `useMcpManagerStore` has no tool-listing action.
Building this means connecting to (or briefly spawning) the configured
server and calling its `tools/list` RPC, with real failure modes to design
for (server unreachable, requires a secret that isn't resolved yet, slow
remote server, stdio server not currently running). That's a distinct
prerequisite project, not a small addition to this plan.

Recommended shape once that capability exists: a shared
`McpToolListingService` (extension host) that both consumers call —
`McpServerForm`'s auto-approve/deny fields for that one server, and
`PermissionListCompletionHelpers.ts` (from this plan) for `mcp__<server>__`
completions scoped to the workflow's currently-configured servers. Cache
aggressively (tool lists don't change per keystroke) and fail soft to "no
completions" rather than blocking the field on a slow/unreachable server.

### 3. Other free-text fields in `WorkflowPropertiesPanel.tsx` worth the same treatment

Scanned the rest of the panel for plain `<input>`/`<textarea>` fields with an
implicit syntax or vocabulary that a completion/lint editor could actually
help with (as opposed to genuinely free text). Two clear hits, both trivial
follow-ups since they need zero new plumbing — `ScriptCommandEditor` already
exists and already does exactly this job elsewhere in this same panel
(`ScriptConditionEditor`'s Script field):

**Implementation status:** The per-hook command field and worktree Setup field
are now implemented with `ScriptCommandEditor`, including shell-command
completions. The remaining items in this follow-up are intentionally deferred.

- **`HooksEditor.tsx`'s per-hook `command` field**
  (`components/editor/HooksEditor.tsx` ~L176–L185, rendered from this
  panel's Hooks tab) — a plain `<input type="text">` with placeholder
  `node ./scripts/my-hook.js`. This is a shell command, the exact domain
  `ScriptCommandEditor` covers. **Recommend: swap it in directly** — no new
  completion source or message plumbing needed, just replacing the `<input>`
  with `<ScriptCommandEditor>` (single-line, already supports `disabled`/
  `aria-label`/`onBlur`).
- **Worktree "Setup" field** (`WorkflowPropertiesPanel.tsx` ~L1701–L1714) —
  a plain `<input type="text">`, placeholder `e.g. npm ci`, described as "a
  command run after a new worktree is created." Same situation exactly.
  **Recommend: swap it in directly**, same as above.

One field reconsidered after initial pushback:

- **Additional Args** (~L1579–L1591, raw per-harness CLI flags like
  `--effort high --max-turns 10`) — my first pass recommended against this,
  reasoning that a completion list would mean hand-maintaining per-harness
  CLI flags that drift out of date. That objection doesn't hold against a
  different design: run the currently-selected harness's own `<bin> --help`
  live and parse its flag table, so completions always match whatever
  version is actually installed instead of a static list. This is a
  genuinely high-value, previously-manual workflow ("run `copilot --help`,
  find the flag by eye, type it back in") worth automating, but the parsing
  side is real work — six CLIs, no shared help-text format guaranteed. Spun
  out into its own plan:
  [`HARNESS_HELP_FLAG_COMPLETIONS_PLAN.md`](HARNESS_HELP_FLAG_COMPLETIONS_PLAN.md).

One field considered and **not** recommended:

- **Session ID** (~L1829–L1834) — not pattern- or vocabulary-shaped text;
  it's either an opaque session identifier or the `SESSION_ID_SENTINELS`
  value already handled by the separate Resume Session dropdown above it.
  Nothing to complete or lint.

Already covered, no action needed: worktree **Branch**/**Base** already use
`BranchNameEditor` (`SingleLineCompletionEditor` + live git-branch
completions via `BRANCH_LIST_REQUEST`), and the end-/pre-condition **Script**
field already uses `ScriptCommandEditor` via `ScriptConditionEditor.tsx`.
