# Multi-Line Script Authoring and Script Type Coverage

> **Status:** Proposed
>
> **Priority:** P2 for the multi-line authoring half (a file-format capability
> the dashboard cannot reach, plus one silent-misexecution hazard); P3 for the
> script-type half (incremental interpreter coverage).
>
> **Related:** `dev/backlog/SCRIPT_STEP_SHELL_OVERRIDE_PLAN.md` — that plan pins
> _which shell_ runs an inline script; this one covers _what text you can put in
> the field_ and _which interpreters a script file can reach_. They touch the
> same call sites (`EndConditionEvaluator.getScriptCommand`,
> `resolveShellInvocation`) and should land in that order, since a per-script
> `shell` is what makes a multi-line inline script portable.
> Also `dev/backlog/COLORED_SCRIPT_OUTPUT_PLAN.md` (script output rendering).

---

## Problem

Two independent gaps around the same `script` field.

### 1. Multi-line scripts are authorable in a file but not in the dashboard

The workflow format already accepts them. Verified against the current schema
and parser:

```yaml
steps:
  - type: script
    script: |
      Write-Output "a"
      npm test
```

parses to `"Write-Output \"a\"\nnpm test\n"` and validates — `scriptProperties.script`
is a plain `type: string` with no single-line constraint. Execution works too:
the inline branch hands `condition.script` to the resolved shell untouched, and
PowerShell multi-line exit codes now propagate correctly (fixed in
`184178a8`).

But every dashboard entry point into that field is single-line.
`ScriptCommandEditor` wraps `SingleLineCompletionEditor`, and all three call
sites take the default single-line mode — Enter blurs the field and typed or
pasted newlines are stripped:

| Call site                          | Field                    |
| ---------------------------------- | ------------------------ |
| `ScriptConditionEditor.tsx:345`    | pre/end-condition script |
| `WorkflowPropertiesPanel.tsx:1903` | worktree setup command   |
| `HooksEditor.tsx:236`              | hook command             |

So a multi-line script authored in YAML survives a round trip only if nobody
opens that field in the dashboard, and a user cannot write one there at all.
The primitive is already there: `SingleLineCompletionEditor` supports
`multiline` and `wrapSingleLine` — nothing consumes them for scripts.

### 2. A multi-line script can silently execute the wrong thing

`evaluateCondition` decides file-vs-inline by tokenizing the **whole** script
string with `EndConditionEvaluator.parseScriptCommand()` and testing whether the
first token resolves to a file. That tokenizer treats newlines as ordinary
whitespace, so for a multi-line script the "script path" is the first word of
the first line and every later line becomes an argument:

```
parseScriptCommand("package.json\nnpm test")
  -> scriptPath="package.json"  args=["npm","test"]
```

`package.json` exists, so `resolveScriptPath` resolves it, `getScriptCommand`
falls through to the default "execute directly" branch, and the step runs
`package.json npm test` — the second line's intent is gone. It fails as a spawn
error rather than silently passing, but the diagnostic points at the wrong
thing entirely, and the same shape with a real script file
(`scripts/setup.sh\nnpm test`) runs `setup.sh` with `npm test` as its argv and
reports whatever that returns.

This is latent today because the field cannot produce newlines. It becomes
reachable the moment the editor does, so it must be fixed **before or with**
the editor change, not after.

### 3. Script type coverage is thin and asymmetric

`getScriptCommand()` (`EndConditionEvaluator.ts:562`) dispatches on extension:

| Ext            | Current                                        |
| -------------- | ---------------------------------------------- |
| `.py`          | `python` (win) / `python3`-if-present (unix)   |
| `.js`          | `node`                                         |
| `.ts`          | `npx ts-node`                                  |
| `.sh`          | `bash` (win) / `sh` (unix)                     |
| `.bat`, `.cmd` | `cmd /c` on Windows, **null elsewhere**        |
| `.ps1`         | pwsh/powershell on Windows, **null elsewhere** |
| _anything_     | execute the path directly                      |

Concrete problems:

- **`.ps1` is rejected off Windows even though PowerShell 7 is cross-platform.**
  `.bat`/`.cmd` returning null off Windows is correct — `cmd.exe` is
  Windows-only — but `.ps1` is not in that category. A workflow with a `.ps1`
  condition is unusable on macOS/Linux for no real reason.
- **`.mjs`/`.cjs` fall through to "execute directly"**, which cannot work on
  Windows for a non-`.exe`, and relies on the +x bit elsewhere.
- **`.ts` hardcodes `npx ts-node`**, which is a network-capable resolution on a
  cold cache and slower than the alternatives most repos now have. No
  `tsx`/`bun`/`node --experimental-strip-types` path.
- **No shebang handling.** An extensionless or oddly-named executable script
  goes to the default branch. On Unix the kernel honors its shebang; on Windows
  nothing does, so the same file is portable in one direction only.
- The default branch is a quiet trap: an unsupported extension is not an error,
  it is an attempt to execute a data file.

## Product Decision

Two separable deliverables. **A** is the valuable one; **B** is cleanup that
can land independently.

### A. Multi-line inline scripts

1. **Make file-vs-inline routing newline-aware, not whitespace-aware.** A
   script containing a newline is inline, full stop — never a file path with
   arguments. This kills the misexecution above and matches intent: nobody
   writes a file path with a newline in it.

   The narrow rule (only the _first line_ is eligible to be a script path, and
   only when there are no further non-blank lines) is preferable to "trim and
   hope", and is one condition in `evaluateCondition` before
   `parseScriptCommand` is consulted.

2. **Give the script field a multi-line mode.** `ScriptCommandEditor` gains a
   `multiline` passthrough; `ScriptConditionEditor` adopts it. Keep Enter's
   single-line behavior where the field is genuinely a command
   (`WorkflowPropertiesPanel`'s worktree setup, `HooksEditor`'s hook command)
   unless there is demand, so this is opt-in per call site rather than a global
   behavior change.

   `wrapSingleLine` is the intermediate option worth considering for the
   condition field first — it grows to a capped height and soft-wraps while
   keeping single-line Enter semantics — but it does not let a user type a
   newline, so it does not deliver the feature on its own.

3. **Serializer round trip.** Confirm `WorkflowSerializer.buildCleanWorkflow`
   emits a block scalar (`|`) rather than a quoted string with `\n` escapes,
   so a multi-line script saved from the dashboard stays readable in the file.
   This is the one place where "already works in YAML" needs verifying rather
   than assuming.

4. **cmd cannot do this, and should say so.** A `cmd /d /c` invocation is a
   single command line; a multi-line script cannot survive it. When the
   resolved shell is `cmd` and the script contains a newline, fail the
   preflight with a clear message rather than executing a truncated command.
   This is the natural place for `SCRIPT_STEP_SHELL_OVERRIDE_PLAN.md`'s
   per-script `shell` to be the fix the message points at.

5. **Display.** Terminal tab labels, dry-run preview, and any
   `formatCommandForDisplay` output need a first-line-plus-ellipsis treatment;
   a raw multi-line string in a tab title is not viable.

### B. Script type coverage

1. Route `.ps1` through pwsh on every platform, falling back to
   `powershell.exe` only on Windows. Keep `.bat`/`.cmd` Windows-only.
2. Add `.mjs`/`.cjs` alongside `.js`.
3. Resolve the TypeScript runner instead of hardcoding: prefer a local `tsx`,
   then `ts-node`, then `node` with native TS stripping.
4. Replace the silent default branch with an explicit rule: keep direct
   execution for files that are actually executable, and return `null` (a real
   "unsupported script type" error) otherwise. `evaluateCondition` already has
   the error path for `null`.
5. Optionally read a shebang for extensionless files and dispatch on it, which
   is the only way that shape works on Windows.

Extension-to-interpreter dispatch is data, not control flow — it belongs in a
`const` map in `DashboardConstants.ts` keyed by extension, per the
no-hardcoded-flow-control rule, with `getScriptCommand` reduced to a lookup plus
the two platform guards.

## Tests

- `parseScriptCommand`/routing: a newline-containing script is never treated as
  a file, including the `package.json\nnpm test` and `scripts/setup.sh\nnpm test`
  shapes that misroute today.
- Multi-line inline execution end-to-end through the headless path, asserting
  the exit code of the _last_ command (extends `ShellInvocation.test.ts`, which
  already covers the multi-line PowerShell case at the shell level).
- cmd + multi-line fails preflight with the documented message rather than
  running a truncated command.
- Serializer round trip: multi-line script → YAML block scalar → parse → same
  string.
- `ScriptCommandEditor`/`ScriptConditionEditor` (Vitest): Enter inserts a
  newline in multiline mode and still blurs in single-line mode; pasted
  newlines survive instead of being stripped.
- `getScriptCommand`: table-driven over every extension, both platforms, and
  the unsupported-extension error.

## Acceptance Criteria

- A multi-line script can be authored in the dashboard, saved, reloaded, and
  executed with the same text and exit code as the equivalent YAML file.
- No script containing a newline is ever dispatched as a file path with
  arguments.
- `.ps1` conditions run on macOS and Linux.
- An unsupported script extension produces an "unsupported script type" error
  instead of an attempt to execute the file.

## Non-goals

- Syntax highlighting or per-shell language support in the script editor. The
  field stays a plain text editor with the existing command completions; the
  shell is not known at edit time anyway (see the shell-override plan).
- Multi-line support for the hook command and worktree setup fields unless
  asked for — those are genuinely single commands.
- A script _body_ stored outside the workflow file (a `scriptFile:` pointer, or
  a heredoc-style external block). If inline scripts grow past a handful of
  lines, that is the better answer, but it is a separate format decision.
- Running a multi-line script under `cmd`. It is rejected, not emulated by
  writing a temp `.bat`.
- Reworking the completion source for multi-line context. Completions currently
  key off the text before the cursor and will keep working line-agnostically;
  making them line-aware is only worth it if the field grows real syntax
  support.
