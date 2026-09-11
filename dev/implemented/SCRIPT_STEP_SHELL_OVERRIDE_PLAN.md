# Per-Script `shell` Override

> **Status:** Implemented end to end
>
> **Priority:** P3 — small authoring convenience. Not a bug fix (the shell
> inconsistency it's adjacent to is already fixed) and not a release gate.
>
> **Related:** `dev/notes.md:84` (the resolved bug that motivated the shared
> `resolveShellInvocation()` resolver this plan builds on), the
> `resolveShellInvocation` bullets in `.github/instructions/core.instructions.md`
> and `.github/instructions/harness-integrations.instructions.md`,
> `dev/implemented/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md` (why this is
> deliberately **not** a new capability domain there).

---

## Problem

`resolveShellInvocation(script)` (`src/core/harness/PtyProcessManager.ts:214`)
is now the single source for "which shell runs this inline script text,"
consulted by both interactive script-step PTY spawning
(`WorkflowInstance.ts:4138`) and the headless inline-command fallback shared by
script steps, preconditions, and end-conditions
(`EndConditionEvaluator.ts:230`). It resolves `terminal.shellExecutable` if the
user set it, else auto-detects per platform.

That closes the original bug (same script text silently ran under a different
shell depending on `executionMode`), but it leaves no way for a **script
author** to pin an interpreter for one specific script. `terminal.shellExecutable`
is a global/workspace setting — it describes what this machine's terminals use,
not what a particular inline script needs. Two concrete gaps that setting
cannot cover:

1. An inline script written in PowerShell syntax (e.g. a `for ($i=1; ...)`
   loop with no `.ps1` file) only runs correctly if the current machine's
   resolved shell happens to be pwsh/powershell. If a teammate's
   `terminal.shellExecutable` is set to Git Bash, or an unset auto-detect
   resolves to something else, the same workflow file breaks for them with no
   indication why — the note this plan follows up on described exactly that
   failure mode, just via the old `executionMode` split instead of a
   per-machine setting split.
2. A user who prefers bash for their own terminals (their
   `terminal.shellExecutable`) has no way to say "but this one condition
   script is POSIX-specific, run it with `sh` regardless."

Script _files_ with a known extension don't have this problem —
`EndConditionEvaluator.getScriptCommand()` already dispatches `.ps1` to
pwsh/powershell and `.sh` to bash/sh unambiguously by extension, independent of
`resolveShellInvocation()`. The gap is specifically the inline/no-file-match
path.

### An adjacent, currently-inaccurate fourth implementation

Dry-run preview has its own, third, independent "which shell" answer for
script steps — `ExecutionPreviewService.buildScriptCommand()`
(`src/core/ExecutionPreviewService.ts:1312-1340`) hardcodes
`process.env.ComSpec ?? "cmd.exe"` on Windows / `process.env.SHELL ?? "/bin/sh"`
elsewhere, wrapped as `["/d", "/s", "/c", script]` / `["-c", script]`, and
always renders it with the `cmd` or `posix` `CommandDisplayShell` dialect. It
never calls `resolveShellInvocation()`, so it doesn't honor
`terminal.shellExecutable` and — since `resolveWindowsShell()` normally
resolves to pwsh, not cmd — it is actively showing the **wrong shell** in the
preview on a typical Windows machine today. `CommandDisplayShell` already has
an unused `powershell` dialect (`src/types/CommandDisplayFormatter.ts:15`)
that this path never reaches.
`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`'s dry-run section calls preview
"the final pre-execution truth surface, not a second capability
implementation" — this is exactly a second implementation, and it predates
this plan. Routing it through the same resolver is in scope here since it's
the same call and prevents this plan's new field from being invisible in
preview.

---

## Product Decision

Add an optional `shell` field to `scriptStep`, `preCondition`, and
`endCondition` — **not** to the workflow root, and **not** modeled in the
harness compatibility registry.

**Why per-script, not workflow-level.** The question that prompted this
(`dev/implemented/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md` discussion) was
whether shell type belongs as an inherited workflow execution property, like
`harness`. It doesn't: `harness` names an AI backend that (with caveats the
compatibility registry already tracks) is available consistently across OSes.
A shell is inherently OS-scoped — `pwsh`/`cmd` mean nothing on a Mac,
`bash`/`sh` are the odd one out on a bare Windows install. A workflow-level
`shell` default would silently encode "this workflow assumes Windows" (or
macOS/Linux) into what's supposed to be a portable file, and every consumer of
that workflow on another OS would need its own compatibility diagnostic to
find out why. A **per-script** override doesn't have that problem: it's an
opt-in statement about one specific script's syntax (e.g. "this text is
PowerShell"), authored right next to the text it describes, and it fails the
same way an unresolvable `terminal.shellExecutable` already fails today — a
plain spawn error — when the pinned shell isn't installed. No new failure
class, no new diagnostic surface.

**Why not the compatibility registry.** That registry
(`dev/implemented/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`) is explicitly
scoped to AI-harness behavioral differences — permissions, prompt inputs,
hooks, MCP — where ctrlyoke can translate or approximate one harness's
behavior for another. Shell availability isn't a harness capability question
at all (script steps aren't AI harness consumers — see "Script steps are not
AI harness consumers" in that plan's Cross-Harness Resolution Model section),
and it isn't a _ctrlyoke_ capability question either — it's "does this
executable exist on the machine that runs this," the same fact
`terminal.shellExecutable` already lives with outside that registry. Standing
up a new `CapabilityDomain`, adapter declarations, and diagnostics for it would
be real architecture churn for a problem that resolves to one honest error
message when the shell is missing.

**Field shape.** Free-form string, same shape as
`schemas/settings-schema.json`'s `terminal.shellExecutable`
(`"type": "string"`, empty/absent = no override) — not a closed enum of
`ShellKind`. `resolveShellKind()` already infers the kind from an arbitrary
executable name or path via pattern matching, so a closed enum would just be a
second, redundant vocabulary to keep in sync. Document common values
(`pwsh`, `powershell`, `bash`, `zsh`, `sh`, `cmd`) as `examples`, the same
pattern `executionProperties.model` already uses for its non-enum string field.

**Precedence.** Per-script `shell` (when set) → `terminal.shellExecutable`
(when set) → platform auto-detect. Same two-tier shape
`resolveShellInvocation()` already has, with the new field slotted in ahead of
it — this is a plain function-argument precedence, not a new
prompt/workflow/defaults resolution chain, since `shell` doesn't live in
`executionProperties` and has no workflow-level tier to resolve through.

**Scope: inline text only, not extension-based file dispatch.** A `shell`
override does not change `getScriptCommand()`'s extension-based dispatch for
script _files_. `.ps1` → pwsh/powershell and `.sh` → bash/sh are already
unambiguous and correct; forcing a mismatched interpreter onto a file whose
extension already picked the right one (e.g. `shell: pwsh` on a `.sh` file)
would break execution, not fix anything. The field only takes effect on the
same "file not found → direct command" path `resolveShellInvocation()` already
covers.

---

## Implementation

### Schema

**Landed in the foundation step.**

`schemas/workflow-schema.json`, `definitions.scriptProperties.properties`:

```json
"shell": {
  "type": "string",
  "description": "Pin the shell that runs this script's inline text (used only when `script` is not a file path that resolves to a known extension — see scriptProperties description). Free-form executable name or path, e.g. \"pwsh\", \"bash\", \"cmd\". Overrides the workspace's terminal.shellExecutable setting for this one script; falls back to it, then platform auto-detect, when omitted.",
  "examples": ["pwsh", "powershell", "bash", "zsh", "sh", "cmd"]
}
```

Reference it the same way the sibling fields are already referenced:

- `definitions.scriptStep.properties.shell`:
  `{ "$ref": "#/definitions/scriptProperties/properties/shell" }` (needed
  because `scriptStep` has `additionalProperties: false` and lists every field
  explicitly).
- `definitions.rootScriptStep.properties.shell`:
  `{ "$ref": "#/definitions/scriptStep/properties/shell" }` (matches how
  `rootScriptStep` already re-references every other `scriptStep` field).
- `endCondition` and `preCondition` need no new schema entry — both already
  pull the full `scriptProperties` object in via `allOf`/`$ref` and neither
  sets `additionalProperties: false`, so the new field is included the same
  way `env`/`compareSource`/`timeout` already are.

### Types

**Landed in the foundation step.**

`src/types/CtrlYokeTypes.ts` — one field on the shared shape, inherited by all
three consumers for free:

```ts
export interface ScriptProperties {
  script: string;
  env?: Record<string, string>;
  compareSource?: EndConditionCompareSource;
  returns?: string;
  timeout?: number;
  /** Pins the shell for this script's inline-text execution path. See scriptProperties description. */
  shell?: string;
}
```

`ScriptStep`, `EndCondition`, and `PreCondition` all `extend ScriptProperties`
already, so no change is needed at those three declarations.

### Resolver signature

**Landed in the foundation step.** The resolver also accepts the optional
platform injection described below, so its signature is settled before the
preview work.

`src/core/harness/PtyProcessManager.ts:214`. **The change is purely additive —
one new optional parameter slotted ahead of the existing setting lookup. Every
existing return field stays**, in particular `windowsVerbatimArguments`, which
both call sites already consume and which is what keeps a quoted inline `cmd
/d /c` payload from reaching cmd.exe mangled (see the
`shellNeedsVerbatimArguments` doc comment immediately above the resolver).
Dropping it would silently reintroduce the "cmd script exits 0 regardless"
bug:

```ts
export function resolveShellInvocation(
  script: string,
  shellOverride?: string
): {
  executable: string;
  args: string[];
  shellKind: ShellKind;
  windowsVerbatimArguments: boolean; // unchanged — do not drop
} {
  const pinned = shellOverride?.trim();
  const terminalSettings = ConfigurationUtils.getTerminalSettings();
  const settingOverride = terminalSettings.shellExecutable.trim();
  const executable =
    pinned ||
    settingOverride ||
    (process.platform === "win32" ? resolveWindowsShell() : resolveUnixShell());
  const shellKind = resolveShellKind(executable);
  return {
    executable,
    args: buildShellWrapArgs(shellKind, script),
    shellKind,
    windowsVerbatimArguments: shellNeedsVerbatimArguments(shellKind),
  };
}
```

### Call sites

**Landed in the foundation step**, except for the explicitly deferred
`ExecutionPreviewService` item below.

- **`WorkflowExecutor.executeScriptStep`** (`src/core/WorkflowExecutor.ts`,
  the `resolvedProperties` literal at ~line 1816) — add
  `shell: effectiveStep.shell`. It already flows into
  `endConditionEvaluator.evaluateCondition(resolvedProperties, ...)` for free,
  since that call takes the whole `ScriptProperties` object. Also pass it into
  the `context.spawnScriptPty({...})` call (~line 1830).
- **`spawnScriptPty` option type** (`src/core/WorkflowExecutor.ts:283-306`) —
  add `shell?: string;` beside `script`.
- **`WorkflowInstance.ts:4138`** (the `spawnScriptPty` implementation) — change
  `resolveShellInvocation(options.script)` to
  `resolveShellInvocation(options.script, options.shell)`.
- **`EndConditionEvaluator.ts:230`** (the inline-command fallback shared by
  headless script steps, preconditions, and end-conditions) — change
  `resolveShellInvocation(condition.script)` to
  `resolveShellInvocation(condition.script, condition.shell)`. `condition` is
  already typed `ScriptProperties`, so this is a one-line change.
- **`ExecutionPreviewService.buildScriptCommand`** _(landed in the preview step)_
  (`src/core/ExecutionPreviewService.ts:1312-1340`) — routes through
  `resolveShellInvocation(step.script, step.shell,
this.options.platform ?? process.platform)`, so preview both fixes its
  preexisting wrong-shell display and reflects the new override. It maps the
  returned `shellKind` to `CommandDisplayShell`: `pwsh`/`powershell` →
  `COMMAND_DISPLAY_SHELLS.POWERSHELL` (finally used), `cmd` →
  `COMMAND_DISPLAY_SHELLS.CMD`, everything else → `COMMAND_DISPLAY_SHELLS.POSIX`
  — the same three-way simplification `renderCommandForDisplay` already
  supports, just driven by the real resolved kind instead of a platform guess.
  `requiresShellVerbatimArgs` is `shellKind === SHELL_KINDS.CMD` (rather than
  a platform check).

  **Platform-injection gap (resolve this while implementing).**
  `buildScriptCommand` currently branches on
  `this.options.platform ?? process.platform` — an injected platform that
  `ExecutionPreviewService` tests rely on to assert both platforms' previews
  from one host. `resolveShellInvocation` reads `process.platform` directly
  and has no such seam, so a naive swap makes preview host-platform-only and
  silently weakens that existing coverage. The resolver now accepts an
  optional `platform?: NodeJS.Platform` parameter defaulting to
  `process.platform`, and preview passes its injected platform through — a
  small, honest seam rather than new indirection. Existing cross-platform
  preview coverage remains intact.

- `{{vars}}` substitution stays untouched. `VarSubstitutor` deliberately
  substitutes only `script` and `env` (see its file header) — `shell` is a
  static interpreter selector like `timeout`/`compareSource`, not text meant
  for variable interpolation, so `applyToScriptStep`/`applyToEndCondition`
  need no change.

### UI

`src/ui/webview-react/components/shared/ScriptConditionEditor.tsx` is the one
shared editor already rendering all three variants
(`scriptStep`/`preCondition`/`endCondition`) for every consumer
(`WorkflowPropertiesPanel.tsx`, `PropertiesDrawer.tsx`, `PromptEditor.tsx`,
`DefaultsValidationPage.tsx`). Add `shell?: string;` to the shared
`ScriptConditionValue` interface, and a text input paired with the existing
Timeout row (same half-width pattern used for Timeout/Max Retries and
Timeout/Execution Mode), with empty-string-clears-to-`undefined` local-state
handling matching the existing `returnsInput`/`timeoutInput` fields. Because
`update()` spreads `{ ...v, ...patch }` and every consumer already forwards
the editor's `onChange` payload generically, no changes are needed at the four
call sites beyond whatever prop plumbing each already does for the rest of
`ScriptConditionValue`.

Placeholder/help text: `"Auto (terminal.shellExecutable, or platform default)"`,
mirroring the Settings page's own `shellExecutable` description.

**Save-path allowlist (found in review).** Adding the field to the editor is
not sufficient on its own: `WorkflowSerializer.buildCleanWorkflow` strips a
working file down to the `PROMPT_FIELDS` allowlist, so any per-step field
missing from that list is silently dropped on save. `shell` needs
`PROMPT_PROPERTIES.SHELL` added to both `PROMPT_PROPERTIES`
(`src/types/DashboardConstants.ts`) and `WorkflowSerializer.PROMPT_FIELDS`.
Treat this as the standing rule for any future per-step field — the
`schemaUiPropertyRoundTrip` and `WorkflowSerializer` round-trip suites are what
catch it, so never silence them with an opt-out entry to make a staged step go
green; the opt-out outlives the step that added it and hides a real save-path
bug.

### Documentation

- `.github/instructions/harness-integrations.instructions.md`'s
  `resolveShellInvocation` bullet gets one clause added noting the optional
  per-script override parameter and its precedence over
  `terminal.shellExecutable`.
- No change needed to `HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md` itself — the
  "Product Decision" section above is the answer to the question it raised,
  recorded here rather than there since the plan explicitly excludes
  non-harness concerns from its scope.

---

## Tests

- `EndConditionEvaluator` unit tests: an inline (no-file-match) `endCondition`/
  `preCondition`/`scriptStep` with `shell: "cmd"` (or another kind distinct
  from the test machine's detected default) resolves and runs under that
  shell regardless of `terminal.shellExecutable`.
- Same, omitting `shell`, still falls back to `terminal.shellExecutable` then
  auto-detect — the existing pre-override behavior is unchanged.
- Interactive script-step PTY spawn (`WorkflowInstance` script-step suite):
  `shell` override reaches `spawnScriptPty` and is used instead of
  `terminal.shellExecutable`.
- `ExecutionPreviewService` script-step preview: `buildScriptCommand` reflects
  a configured `shell` override, and — with no override — reflects
  `terminal.shellExecutable` when set (regression coverage for the preexisting
  inaccuracy this plan fixes as a byproduct).
- Schema: a workflow file with `scriptStep.shell` / `endCondition.shell` /
  `preCondition.shell` validates against `schemas/workflow-schema.json`.

---

## Acceptance Criteria

- [x] `scriptStep`, `preCondition`, and `endCondition` accept an optional `shell`
      string field in the schema and `ScriptProperties` type.
- [x] A pinned `shell` takes effect only on the inline/no-file-match execution
      path; extension-based script _file_ dispatch (`.ps1`, `.sh`, etc.) is
      unaffected.
- [x] Precedence is per-script `shell` → `terminal.shellExecutable` →
      platform auto-detect, identical across interactive script-step PTYs and
      headless script steps/preconditions/end-conditions.
- [x] Dry-run preview's script-step command reflects the same resolved shell
      (including the override) that execution actually uses — no third,
      independent shell guess remains in `ExecutionPreviewService`.
- [x] No new `CapabilityDomain`, capability declaration, or portability-report row
      is added for shell selection.
- [x] No workflow-root `shell` property or `executionProperties` inheritance is
      added.

All acceptance criteria are met; there are no known exceptions.

## Non-goals

- A workflow-level `shell` default or execution-property inheritance chain —
  deliberately rejected above; revisit only if a concrete portability need
  surfaces that a per-script field can't cover.
- Modeling shell availability in the harness compatibility registry or
  portability report.
- Validating a pinned shell's availability ahead of execution (e.g. an
  authoring-time warning if `shell: "pwsh"` looks unlikely on the target OS).
  An unresolvable pinned shell fails exactly like an unresolvable
  `terminal.shellExecutable` does today — a plain spawn error — and that's
  sufficient.
- Letting `shell` affect extension-based script _file_ dispatch.
- `{{vars}}` substitution into `shell`.
