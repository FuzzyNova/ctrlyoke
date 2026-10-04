# CLI Flag Override Scope — flags set the workflow level; `--force` extends them to steps

> **Status:** Phase 1 complete; phases 2–4 queued. Audited 2026-10-04 against `src/cli.ts`,
> `src/cli/CliRunCommandDefinitions.ts`, `src/cli/CliPropertyOverrides.ts`,
> `src/cli/CliExecutionMode.ts`, `src/types/ExecutionPropertyResolver.ts` and
> `PromptFileLoader.populateSettingsDefaults`. The `--harness` finding was confirmed with a
> real headless run; see
> [`cli-harness-flag-ignored-when-workflow-sets-harness.md`](../bugs/implemented/cli-harness-flag-ignored-when-workflow-sets-harness.md).

## The rule

Every `ctrlyoke run` flag that corresponds to a workflow property overrides **the workflow
level only**. Steps that set the property themselves keep their value. One opt-in modifier,
`--force`, extends a named flag's value to every step as well.

Property resolution stays `step → workflow → settings`. Today the CLI's flags land on three
different tiers depending on the flag; this plan puts every one of them on the workflow tier.
`--force` is the only way a flag reaches the step tier.

## Audit — where each flag lands today

| Flag                                                                        | Lands on                                                                                                                        | Matches the rule?                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `-m, --model`                                                               | Workflow (`CliPropertyOverrides`)                                                                                                 | **Yes.** Steps with their own `model` keep it.                                                       |
| `-H, --harness`                                                             | Workflow (`CliPropertyOverrides`)                                                                                                 | **Fixed in phase 1.** Steps keep their own harness.                                                  |
| `--interactive`                                                             | Settings tier (`overlay.defaults.executionMode`)                                                                                | **No.** A workflow-level `executionMode` beats the flag.                                             |
| `--headless`                                                                | Settings tier, plus `hostCanProvidePty = false`, which clamps **every** step to headless in `resolveExecutionMode`              | **No.** Too strong: it overrides steps that ask for `interactive`.                                   |
| `--permission-mode`, `--allow-tool`, `--deny-tool`                          | Workflow (`CliPropertyOverrides`) for `run`                                                                                       | **Fixed in phase 1.** Fields merge independently; step values still win.                             |
| `--resume-session` / `--no-resume-session`                                  | **Every step** (`cli.ts` mutates `step.resumeSession` on all steps; `--no-resume-session` also deletes each step's `sessionId`) | **No.** Too strong, and it destroys step-authored `sessionId`s.                                      |
| `--session-id`                                                              | The first step only (`steps[0].sessionId` + `resumeSession`)                                                                    | **No.** Too narrow: later steps never see it (D3).                                                   |
| `--var`                                                                     | Workflow `vars` (CLI values win)                                                                                                | **Yes.** `vars` is workflow-only, so there is no step level.                                         |
| `-t, --timeout`                                                             | Setting `execution.maxPromptTimeoutSec`                                                                                         | **Yes, trivially:** no workflow or step field exists.                                                |
| `--script-timeout`                                                          | Setting `execution.scriptTimeoutSec`                                                                                            | Effectively yes: a script's own `timeoutSec` wins. There is no workflow-level field (D2).            |
| `--cwd`, `--prompt`, `--dry-run`, `--json`, `-q`, `--verbose`, `--no-color` | Process or output options, not workflow properties                                                                              | Out of the rule.                                                                                     |

## Decisions

**D1 — One modifier flag: `--force <flags>`.** There is no standard CLI convention for a
per-flag scope modifier. The options considered:

- **Duplicate flags** (`--harness-force`, `--model-force`, …) double the help surface, and
  every new property flag needs a twin.
- **A value suffix** (`--harness codex-cli!`) is obscure and collides with shell history
  expansion of `!`.
- **A single `--apply-to-steps`** is all-or-nothing. You could not force the harness while
  leaving step models alone.
- **A generic `-c key=value` map** (the git/codex style) loses typed parsing, validation and
  `--help` text for each property.

`--force` takes the names of the flags to extend, comma-separated and repeatable, plus `all`:

```sh
ctrlyoke run wf.yaml -H codex-cli -m gpt-5 --force harness          # harness on every step; model workflow-only
ctrlyoke run wf.yaml -H codex-cli -m gpt-5 --force harness,model    # both on every step
ctrlyoke run wf.yaml --headless --permission-mode allow-all --force all
```

This gives per-flag control with one new flag. It reads as "force this flag", and the user
names flags they just typed rather than schema property names.

Validation:

- Naming a flag that was not passed is an error (`--force model requires --model`).
- Naming a flag that cannot be forced (`var`, `timeout`; see D2) is an error.
- `all` expands to every forceable flag that was actually passed.

`--headless` and `--interactive` are both accepted names for the execution-mode property.

**D2 — The forceable set.** A flag is forceable when its property exists at step level:

| `--force` name                     | Forced onto                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `harness`                          | Every prompt step.                                                                              |
| `model`                            | Every prompt step.                                                                              |
| `headless` / `interactive`         | Every prompt and script step (`scriptStep.executionMode` exists).                               |
| `permission-mode`                  | `toolPermissions.mode` on every prompt step that has a `toolPermissions` object, or a new one.  |
| `allow-tool` / `deny-tool`         | `toolPermissions.allowedTools` / `deniedTools` on every prompt step, replacing the lists.       |
| `resume-session` (either polarity) | `resumeSession` on every prompt step; the negative form also drops step `sessionId`s, as today. |
| `session-id`                       | `sessionId` and `resumeSession: true` on every prompt step, replacing step-authored values.     |
| `script-timeout`                   | `timeoutSec` on every script step, including pre- and end-condition scripts.                    |

"Every step" includes parallel-group members and `finalStep`. It does not include steps that
`append_step` adds later, because they are authored mid-run, after the flags were applied.
`--var` and `--timeout` are not forceable: neither has a step-level field.

**D3 — `--session-id` sets the workflow-level session ("every step uses this one session").**
It writes workflow `sessionId` and, because the flag implies `--resume-session`, workflow
`resumeSession: true`. The resolver already gives the intended meaning:
`resolveSessionId` (`ExecutionPropertyResolver.ts`) picks the prompt's `sessionId`, then the
workflow's, then the default. So every step that does not name its own session resumes the
given one, exactly as if the workflow had authored `sessionId:` at the top level.

- **Steps that opt out keep their choice.** A step with its own `sessionId` resumes that
  session instead. A step with `resumeSession: false` still starts fresh.
- **`--force session-id`** puts the session on every prompt step, replacing step-authored
  `sessionId`s, and forces `resumeSession: true`.
- **Parallel groups.** If two members of a group would resolve to the given session, that
  fails preflight with the existing `SESSION_COLLISION` error, as an authored workflow-level
  `sessionId` does today. Don't special-case it. Add one sentence to the error when the session
  came from the flag: members inherit `--session-id`, so either give those members their own
  `sessionId` or run without the flag. Members that set their own session are unaffected.
- **`--session-id` with `--no-resume-session` is a usage error.** The two contradict each other.
- The value is always an exact harness session ID string. The schema's numeric prompt
  references (`1` = "use step 1's session") and `"finalStep"` stay authoring-only; the flag
  does not interpret them.

**D4 — Changing the harness clears models that were meant for the old harness.** Changing
the workflow's harness while keeping its `model` produces mismatches; the audit showed
`--harness copilot-cli` running with `model: sonnet`. So when a harness override replaces a
harness at some scope and `--model` was not given for that scope, the override clears the
`model` at that same scope. Resolution then falls back to `defaults.models[<new harness>]`.

- "Replaces" means the effective harness at that scope changes. At workflow level, compare
  the flag with `workflow.harness ?? defaults.harness`, because an authored workflow `model`
  with no workflow `harness` was written for the settings default. `-H` naming the harness
  already in effect clears nothing.
- Workflow level: `-H codex-cli` alone clears the workflow `model`.
- With `--force harness`: each forced step's `model` is cleared too, unless
  `--force model` supplies one.

A one-line notice per cleared scope says what was dropped
(`workflow model "sonnet" dropped: it was set for claude-cli`).

**D5 — `--force model` without a single forced harness must not mix harnesses.** After
overrides, if the forced steps resolve to more than one harness, `--force model` is refused.
The error lists the conflicting steps and suggests adding `--force harness`. One model name is
almost never valid across harnesses, and a silent mismatch fails mid-run.

**D6 — `--headless` and `--interactive` stop being host-capability switches.** Today
`resolveCliExecutionMode` derives `hostCanProvidePty` from the flag, which is why `--headless`
clamps every step. Split the two concerns:

- **Host capability** is decided by TTYs only: `hostCanProvidePty = stdin && stdout are
TTYs`. With no TTY, every step is still clamped to headless, and
  `warnAboutClampedInteractiveSteps` still reports it. That clamp is physical, not an
  override.
- **The default mode**: `--headless`/`--interactive` set workflow `executionMode`. Without
  either flag, the TTY-derived default stays on the settings tier, as now.

So in a TTY, `--headless` makes the workflow headless while a step that says
`executionMode: interactive` still opens its TUI. `--headless --force headless` restores
today's "everything headless" behaviour.

This needed output gating to be decided per attempt, not by the run-level mode, once a
headless run can contain interactive steps. That is now the case; see
[`cli-interactive-run-hides-headless-step-output.md`](../bugs/implemented/cli-interactive-run-hides-headless-step-output.md).

**D7 — `toolPermissions` flags merge into the workflow's object field by field.**

- `--permission-mode` replaces `toolPermissions.mode` only.
- `--allow-tool` and `--deny-tool` replace their lists, consistent with today's overlay
  replacing the settings lists.
- Sub-fields the flags do not name keep the workflow's values.

A workflow `toolPermissions: null`, which means pass no permission flags, is replaced by an
object when any permission flag is given. The user asked for permissions on the command line.

**D8 — `--resume-session` / `--no-resume-session` set workflow `resumeSession`.** Steps that
set `resumeSession` keep it. `--no-resume-session` no longer deletes step `sessionId`s unless
forced. Today's all-steps behaviour is `--force resume-session`.

**D9 — Overrides are written into the run's working copy, through one function.** A new
`src/cli/CliPropertyOverrides.ts` exposes `buildCliPropertyOverrides(options)` and
`applyCliPropertyOverrides(workflow, overrides)`. The first returns
`{ workflow: Partial<ExecutionProperties>, forced: ReadonlySet<ForceableFlag> }`; the second
mutates the loaded `PromptFile` and returns the notices from D4.

- **Who calls it.** `cli.ts` calls it after load. Dry-run calls it on `previewWorkflow`, and
  the run header reads the result. That single source is what fixes the `--harness` bug.
- **Persistence.** The overridden values persist in the run's `workflow.ctrlyoke.json`, so
  `history show`, `rerun` and the dashboard see what actually ran. The authored file is never
  touched.
- **What it replaces.** It replaces the scattered handling in `cli.ts`: the
  `overlay.defaults.harness`/`executionMode` writes, the
  `overlay.defaults.models[config.harness]` write for `--model` (a second, settings-tier copy
  of the flag, keyed by a harness that may not be the one that runs), the dry-run
  `modelsByHarness` overlay that mirrors it, `applyCliToolPermissionOptions`, the
  `updateWorkflowProperty("model")` call, and the `--session-id`/resume-session step
  mutations (both the real-run copy in `cli.ts` and `applyDryRunSessionOverrides`).
- **What stays.** `explicitHarness` no longer needs to reach
  `executeLoadedPromptFile`, because the workflow now carries it. `--timeout` and
  `--script-timeout` stay settings-overlay values.

`ForceableFlag` is a `const` object of the D2 names, so `--force` parsing and the
application `switch` share one typed key set (per the project's no-hardcoded-flow-strings
rule).

**D10 — Other commands.**

- `rerun --harness/--model` applies to the newly seeded run's workflow level, following the
  rule, and accepts `--force`.
- `append --harness` keeps its meaning of "harness for the appended steps". Appended steps
  are the thing being authored, so it is a step-level flag by design and not subject to the
  rule.
- The execution flags `rerun`, `append` and `continue` share with `run`
  (`addExecutionOptions`: `--headless`/`--interactive` and the permission flags) use the
  same function on that run's working copy. They affect only work that has not run yet. The
  session flags (`--session-id`, `--[no-]resume-session`) exist only on `run`; this plan does
  not add them to the other commands.
- `continue` still rejects `--harness`/`--model`.

**D11 — Help text states the scope.** Each property flag's description ends with
"(workflow level; add `--force <flag>` to apply to every step)". `--force`'s own help lists
the forceable names, generated from the `ForceableFlag` object. The CLI reference docs follow
from the help text.

## Implementation phases

1. **`CliPropertyOverrides` with workflow-level semantics only.**
   - Covers `--harness`, `--model` and the permission flags. Wires the real run, dry-run and
     the run header to it. Fixes the `--harness` bug, which moves to `dev/bugs/implemented/`
     in this commit.
   - Adds the D4 model clearing.
   - Tests: a fake-harness real run asserts the spawned harness for a workflow-set harness, a
     step-set harness, and no harness. Dry-run and the header agree with the real run in each
     case. No fake-harness fixture exists yet: `src/test/integration/helpers/cliProcess.ts`
     runs the real `out/cli.js`, but existing CLI integration tests only use script steps, and
     there is no env override for a harness executable. Build the fixture as a stub executable
     on a test-only `PATH` (e.g. `claude.cmd`/`codex.cmd` on Windows plus a POSIX twin) that
     records its own name and exits. If the launcher resolver cannot be pointed at a stub
     without a production seam, add the smallest test-only seam and say so in this doc.
   - Landed: the integration fixture uses `copilot`/`opencode` stubs on a test-only `PATH`;
     no production seam was needed. These stdout-based harnesses keep the process test
     independent of real session-log discovery. Unit coverage includes D4 and permission
     merges. `rerun`, `append` and `continue` retain their pre-phase behavior.
2. **Execution mode and session flags (D3, D6, D8).** Lands after the interactive-output bug
   fix. Tests:
   - TTY-forced runs with `--headless` keep a step's `interactive`; no-TTY runs still clamp
     and warn.
   - `--no-resume-session` keeps step `sessionId`s.
   - `--session-id` on a three-step sequential workflow resumes the given session for every
     step, except one that names its own `sessionId`.
   - A parallel group inheriting `--session-id` fails preflight with the flag-specific hint.
3. **`--force`** (D1, D2, D5).
   - Covers parsing and validation, step application including parallel members, `finalStep`
     and script steps, and the D5 refusal.
   - Tests: each forceable flag, `all`, error cases, and D4 clearing under `--force harness`.
4. **Other commands and help text (D10, D11).**

## Not in scope

- New property flags (e.g. `--agent`, `--skills`, `--mcp-server`). They follow this rule
  when added, and `ForceableFlag` makes forcing them a one-line addition.
- A settings-tier override flag ("change the default without touching the workflow"). With
  this rule the workflow tier covers it for every property the workflow can set.
- The dashboard's run controls, which already edit the workflow or step directly.
