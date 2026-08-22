# Overzealous Step Failures Plan

> **Status:** Items 2, 3, and 4 implemented (2026-08-20); the cross-cutting
> "documents every syntax" regression test is implemented. Remaining work is
> deliberately deferred: item 3 recommendations 2 and 3.
> **Items 2 and 3 were staged inside
> `dev/implemented/WORKFLOW_SCHEMA_UI_PARITY_PLAN.md`'s step queue** (2026-08-20):
> that plan added the UI controls which make both failures reachable for a
> dashboard-only author, so the guards were fixed alongside them.
> **Priority:** P1 for item 2 (latent, trips any workflow that uses `vars`);
> P2 for the rest.
> **Origin:** Fell out of implementing
> `dev/implemented/CONTEXT_RESOLUTION_FAILURE_MODE_PLAN.md`. That plan's own
> orchestrator run failed repeatedly on item 1 below, which was fixed during
> its review pass; the same shape of bug turned out to exist in three other
> places.

## The pattern

ctrlyoke has several guards that hard-fail a step because prompt text or
config _mentions_ a ctrlyoke syntax, without being able to tell "the author
means this" from "the author is writing about this."

The recurring failure is authoring a workflow **about ctrlyoke** — a plan, an
instruction file, a prompt that documents a feature. That is a first-class use
case here (this repo is developed that way), and it is exactly the case these
guards punish.

**Design rule to apply to all of them:** a reference syntax appearing in text
is not, by itself, evidence of intent. Where ctrlyoke cannot distinguish
intent, the correct behavior is an advisory diagnostic that lets the step run —
not a throw. Reserve throws for cases where proceeding would produce a
silently wrong result (a credential that really was going to be substituted
and now won't be).

## 1. `${secret:NAME}` in prompt text — FIXED, kept here as precedent

`assertNoSecretInterpolationInPrompt` threw unconditionally on any prompt
containing `${secret:...}`, so a prompt merely quoting the syntax killed the
run before step 1.

Fixed in `fix: stop failing steps on prompt-text secret interpolation` — now
`findSecretInterpolationsInPrompt`, reported as a non-blocking
`prompt.secret.interpolation-ignored` advisory from `WorkflowExecutor`'s step
and retry paths, deliberately excluded from
`isContextResolutionDiagnostic` so it cannot block even in
`execution.strictContextResolution: "fail"`.

Listed here because it is the template for the remaining three.

## 2. `{{name}}` throws when the workflow defines any vars — IMPLEMENTED

**Verified.** `VarSubstitutor.substitute` (`src/utils/VarSubstitutor.ts:28`)
throws on any `{{key}}` with no matching entry:

```
Unresolved variable "{{foo}}" — pass --var foo=<value> or add it to the workflow's vars: section
```

Both entry points bail out first when there are no vars at all:

```ts
if (!promptText || Object.keys(vars).length === 0) return promptText; // :55
```

So the bug is **latent, not universal**:

| Workflow                  | `{{foo}}` in prompt text            |
| ------------------------- | ----------------------------------- |
| No `vars:` and no `--var` | Passes through untouched — no error |
| **Any** vars defined      | **Throws, killing the step**        |

A workflow that uses variables for anything can therefore no longer _discuss_
variable syntax. The failure is also confusing: the message tells you to define
`foo`, when the author never wanted a variable at all.

Applies to prompt text, `model`, `additionalArgs`, hook commands, hook `env`,
preCondition `script`/`env`, endCondition `script`/`env`/`retryPrompt`/`passRetryPrompt`,
script-step `script`/`env` (`applyToResolvedProperties`, `applyToHook`,
`applyToPreCondition`, `applyToEndCondition`, `applyToScriptStep` — the latter three
now share one `applyToScriptProperties` helper, all in `src/utils/VarSubstitutor.ts`),
and worktree `setup` (`WorktreeManager.ts:2524`).

**Widened 2026-08-20.** preCondition and script-step substitution did not exist when
this item was first written. `applyToPreCondition`/`applyToScriptStep` landed in
`fix: add variable substitution in preCondition and script steps, update documentation
for clarity`, fixing a real mismatch (`ExecutionPreviewService` substituted a script
step's `{{var}}` for preview, but the real run sent the literal text). That fix is a
prerequisite this item now depends on: the throw below was already live for
prompt/model/hooks/endCondition/worktree-setup, and now reaches preCondition and
script-step too — so a fix for this item that doesn't cover those two is incomplete.

**Implemented 2026-08-20 — option (a) plus fenced-block masking.**
`VarSubstitutor` now leaves unresolved placeholders literal and exposes unique
unresolved tokens for a non-blocking
`prompt.variable.substitution-ignored` advisory. `WorkflowExecutor` reports
the field and step for prompt text, model/additionalArgs, hooks,
preCondition/endCondition, retry prompts, and script steps; worktree setup
reports its own field through the same diagnostic channel. Fenced code blocks
are masked before substitution and diagnostics, so quoted `{{...}}` syntax is
left untouched without an advisory. The diagnostic is deliberately outside
`isContextResolutionDiagnostic`, including under
`execution.strictContextResolution: "fail"`.

**This also makes the failure reachable today, independent of any `vars` editor.**
`ScriptConditionEditor`'s `preCondition` variant already renders an editable `script`
field, so a user can put `{{typo}}` in a preCondition's script through the dashboard
right now; combined with any workflow vars (workflow-defined _or_ a bare `--var` on
the CLI), that throws before step 1 runs.

**Options, roughly in order of preference:**

- **(a) Leave unresolved placeholders alone and warn.** `{{foo}}` with no match
  stays literal and produces an advisory diagnostic. Matches the item-1 fix and
  the design rule above. Risk: a genuine typo (`{{brnach}}`) now silently ships
  the literal text instead of failing loudly — mitigated by the warning row.
- **(b) Keep throwing, but only for prompt-adjacent fields where a literal is
  plainly wrong** (`model`, `script` paths), and warn for free text
  (prompt, retryPrompt).
- **(c) Add an escape** (`\{{foo}}` or a fenced-block mask like
  `parseSecretReferences` already uses via `maskFencedCodeBlocks`). Cheapest
  partial fix and composable with (a): masking fenced blocks alone would have
  prevented most real cases, since documentation quotes syntax in code fences.

(a) plus fenced-block masking is the recommended combination. Note that
`parseSecretReferences` already establishes the fence-masking precedent for
exactly this reason — see its header comment.

## 3. An ungranted `${secret:NAME}` in a process map hard-fails the workflow

**Verified.** `preflightWorkflowSecrets` throws before step 1 when a process
map references a secret the step was not granted:

> `Secret "X" is referenced in process environment for scope "step 1" but is not granted to that step.`

The maps scanned by `getProcessMaps` (`src/utils/SecretResolver.ts:234`) are
MCP `env` **and `headers`**, hook `env`, script-step `env`, and
pre/end-condition `env` at both step and workflow level.
`expandSecretInterpolations` throws again at spawn time as a second line of
defense.

### Why this one is different from items 1, 2 and 4

Those maps genuinely interpolate. If ctrlyoke let an ungranted reference
through, the child process would receive the literal string
`${secret:GITHUB_PAT}` as its token and fail somewhere downstream with a
confusing auth error. So "just warn and continue" is _not_ obviously right
here — something really was going to be substituted.

The problem is not that ctrlyoke checks. It is that the **grant is a second,
separate gesture** the user has no reason to expect:

- The user set up the secret, referenced it correctly in the MCP/script config,
  and is then told the workflow is invalid because they didn't _also_ list it
  somewhere else.
- The MCP Manager env editor **inserts `${secret:NAME}` for them** (shipped in
  `SECRETS_AND_REDACTION_PLAN.md` Phase 5) and does not add the grant, so the
  product actively walks users into the failure.
- **Script steps cannot satisfy it inline at all.** They have no prompt, so
  there is no `!NAME` gesture available; `secrets: [NAME]` is the only option —
  and that array is not editable from the UI today (see
  `dev/implemented/WORKFLOW_SCHEMA_UI_PARITY_PLAN.md`), which makes the failure
  _unrecoverable_ for a UI-only author.

### The security argument does not survive contact with the code

The justification for requiring an explicit grant is the cloned-repo threat: a
shared workflow declares `env: { X: "${secret:MY_AWS_KEY}" }`, and merely
running it ships your key to someone else's MCP server. Real threat.

**But inline `!NAME` in prompt text already auto-grants.**
`getEffectiveSecretGrants` (`src/utils/SecretReferenceParser.ts`) unions inline
prompt references into the grant set, and `getDeclaredSecretGrants` documents
the asymmetry as deliberate. So a cloned workflow with `!MY_AWS_KEY` in its
prompt text grants automatically, with no friction — same threat, opposite
handling. The env-map check buys no protection a malicious shared workflow
cannot route around through prompt text, while charging every legitimate local
author a confusing hard failure.

A hard error is also the wrong instrument even where the threat is real: it
does not prompt for review, it fails, and the user adds the grant to make it
stop. That trains rubber-stamping.

### Recommendation

1. ~~**Treat `${secret:NAME}` in a step's own process maps as an authoritative
   grant**, exactly like inline `!NAME`. Configure the MCP server or script
   with the secret and it comes as a package. This is a change to
   `getDeclaredSecretGrants`/`getEffectiveSecretGrants` (union in names
   collected from the step's process maps), after which both the preflight
   throw and the `expandSecretInterpolations` throw become unreachable for this
   case and can stay as genuine invariant guards.~~ **Implemented (2026-08-20).**
   Process-map references are now authoritative grants with scope-preserving
   coverage for script env, hooks, conditions, MCP env/headers, workflow maps,
   and unrelated steps; the invariant guards remain in place.
2. **Outstanding — put the cloned-repo protection where it belongs:** a one-time trust
   approval that surfaces _every_ grant a workflow wants — inline and env-map
   alike — reusing the `permissions.allowedExternalFileRoots` approval pattern.
   `SECRETS_AND_REDACTION_PLAN.md`'s own open questions already propose this
   ("Leaning yes for grants") and it was never built. One coherent gate beats
   one silent path plus one noisy one.

   Implement this as the following concrete plan:

   1. **Implemented (2026-08-22) — compute the workflow-wide request once, from the existing authoritative
      per-step resolver.** Add
      `getWorkflowSecretGrants(workflow: PromptFile): string[]` to
      `src/utils/SecretResolver.ts`, alongside `getDeclaredSecretGrants`.
      Iterate `workflow.steps ?? []` followed by `workflow.finalStep` when
      present, call `getDeclaredSecretGrants(step, workflow)` for each, and
      union the names in first-seen order. This automatically includes inline
      `!NAME`, the effective `secrets` array (including inherited workflow
      declarations), and valid `${secret:NAME}` references in every effective
      process map. Do not scan `${secret:NAME}` in prompt prose: prompt text is
      not a resolution boundary.

   2. **Implemented (2026-08-22) — add a separate user-local trust store.** Create
      `src/config/SecretGrantsTrustStore.ts` with the same platform-agnostic
      shape as `ExternalRootsTrustStore`:
      `SecretGrantTrustDecision = "allow" | "deny"`,
      `getDecision(workspaceIdentity: string, name: string)`,
      `getApprovedGrants(workspaceIdentity: string, candidateNames:
      readonly string[])`, `getPendingGrants(...)`, and
      `setDecisions(workspaceIdentity: string, names: readonly string[],
      decision: SecretGrantTrustDecision)`. Canonicalize the workspace identity
      with `ExternalRootsTrustStore.canonicalizeRoot`. Persist atomically at
      `~/.ctrlyoke/secret-grants-trust.json`, with the exact key shape
      `${workspaceIdentity}␟${secretName}`. Export a process-wide
      `secretGrantsTrustStore` singleton. Keep this out of
      `CtrlYokeConfigService`: approval is local trust state, not a setting, and
      a checked-in workflow must never be able to write its own approval.

   3. **Implemented (2026-08-22) — keep the shared resolver platform-agnostic, but make trust fail closed
      at the core boundary.** Add an optional constructor callback to
      `src/core/WorkflowInstance.ts`, for example
      `approveSecretGrants?: (workflow: PromptFile, workspaceRoot: string) =>
      Promise<void>`. Invoke it in `WorkflowInstance.executeLoadedPromptFile`
      immediately before the existing `preflightWorkflowSecrets(...)` call.
      The callback resolves pending approvals; `preflightWorkflowSecrets`
      itself must then verify that every name returned by
      `getWorkflowSecretGrants` has an `"allow"` decision for the canonical
      workspace identity before resolving values. Add the trust store as an
      injectable field in its existing options object, defaulting to
      `secretGrantsTrustStore`, so unit tests do not depend on the user's
      singleton file. A pending or denied name is treated as unavailable and
      must use the existing `MissingSecretError`/ungranted process-map failure
      path, not a new trust-specific execution result. This check is
      unconditional even when `failOnMissing` is false: a denial must never
      become a warning that lets execution continue. The same core path
      therefore covers normal runs, retries, continuations, seeded re-runs,
      and ephemeral dashboard prompts. Direct `WorkflowInstance` callers such
      as the CLI pass no UI callback. The adapters own only the pending-review
      UX; the core check prevents any non-UI execution path from bypassing it.

   4. **Wire the VS Code prompt at execution time, not extension activation.**
      Add `promptBatchApprovalForPendingWorkspaceSecretGrants(workflow:
      PromptFile, workspaceRoot: string, store: SecretGrantsTrustStore =
      secretGrantsTrustStore): Promise<void>` to a new
      `src/ui/SecretGrantsTrustPrompt.ts`, mirroring
      `promptBatchApprovalForPendingWorkspaceExternalRoots` in
      `src/ui/ExternalFileTrustPrompt.ts`. Require
      `vscode.workspace.isTrusted`; display one `showQuickPick` with every
      pending name checked by default; Enter records allow for checked names
      and deny for unchecked names; Escape records nothing so the next attempt
      asks again. In `WorkflowOrchestrator.buildWorkflowInstance`, pass this
      function as the new `WorkflowInstance` callback. The callback is reached
      from the real dashboard paths (`extension.ts`'s `ctrlyoke.run` and
      `runFromContext`, plus `WebviewMessageRouter` →
      `WorkflowStepHandlers`' addressed draft/re-run/continue handlers) because
      they all ultimately call `WorkflowInstance.executeLoadedPromptFile`;
      do not put a native prompt in extension activation, where the workflow
      definition is not known.

   5. **Implemented (2026-08-22) — add the CLI fail-closed gate and approval command.** In `src/cli.ts`'s
      `runCommand`, perform the new gate only after the file or inline workflow
      has loaded and CLI `--var` values have been merged, but before
      `executeLoadedPromptFile` (and before the dry-run path if that path is
      given a loaded workflow). Use `getWorkflowSecretGrants`, the canonical
      working-directory identity, and `secretGrantsTrustStore.getPendingGrants`.
      List every pending name and exit 2 with
      `Run \`ctrlyoke trust-secret-grants <file>\` to review and approve them.`
      Keep the existing external-root gate unchanged. Register a top-level
      `trust-secret-grants <file>` command in `src/cli.ts`, with `-d, --cwd`
      and `-y, --yes`, and implement its parse/load, pending-name listing,
      interactive confirmation, and allow/deny persistence by reusing the
      `PromptFileParser` and the store. The command is deliberately scoped to
      one workflow file because grants are per-workflow; an inline `--prompt`
      with pending names remains fail closed and must be moved to a file before
      it can be approved durably. Add the command's options/handler types to
      `src/cli/SecretCommandDefinitions.ts` (`TrustSecretGrantsOptions`) and
      its testable `trustSecretGrantsCommand(...)` handler in
      `src/cli/SecretCommands.ts`, using the existing
      `SecretCommandDependencies`/`SecretCommandIo` contracts.

   6. **Implemented (2026-08-22) — scope the decision by workspace and name, not by workflow file or
      content hash.** Use the exact `${workspaceIdentity}␟${secretName}` key:
      secret names are identifiers, not secret values, and the approval is a
      local user's trust decision for that workspace. This matches the external
      roots precedent and avoids re-prompting for every workflow that
      legitimately uses the same credential. A workflow cloned into another
      checkout/workspace gets a different identity and must be reviewed again;
      finer workflow/content scoping would turn the one-time review into
      repetitive rubber-stamping without improving the stated cloned-repository
      boundary.

   7. **Test each boundary.** Extend
      `src/test/unit/SecretResolver.test.ts` with workflow-wide union coverage
      across multiple steps and `finalStep`, including inline and process-map
      grants. Add `src/test/unit/SecretGrantsTrustStore.test.ts` by copying the
      isolated temporary-file patterns from
      `src/test/unit/ExternalRootsTrustStore.test.ts`: allow/deny/pending
      behavior, workspace isolation, persistence, corrupt-file recovery, and
      the exact separator key. Extend `src/test/unit/SecretCommands.test.ts`
      (and the CLI run integration/parser coverage where appropriate) for
      `trust-secret-grants`, `--yes`, pending-name output, and the run gate's
      exit-2 fail-closed behavior. Add focused VS Code prompt/wiring coverage
      using the existing `src/test/unit/ConfigurationUtils.test.ts`-style
      injected-store/stub patterns: all names are shown in one picker,
      checked/unchecked decisions persist, Escape leaves names pending, and
      the execution callback is invoked before `preflightWorkflowSecrets`.
3. **Honored (2026-08-20), not outstanding work** — this was a constraint on the
   fix, not a task. The invalid-name throw (`isValidSecretName`) and the runtime
   `MissingSecretError` are both still in place: they are real resolution
   failures, not declaration friction. So are the `preflightWorkflowSecrets` and
   `expandSecretInterpolations` throws, now unreachable for the auto-granted case
   and retained as genuine invariant guards.

## 4. The heuristic redactor rewrites authored prompt text — FIXED (2026-08-20)

Observed (reproduced live via the workflow-root end-condition `env` editor
added by `WORKFLOW_SCHEMA_UI_PARITY_PLAN.md`): a value authored as
`${secret:TEST_SECRET}` displayed back as `${secret:[REDACTED]}`. The **name**
was redacted, not a value, and the mangled reference then failed
`KeyValueMapEditor`'s own `SECRET_REFERENCE_PATTERN` check, triggering a false
"looks like a pasted credential" warning on a value the user had correctly
picked from the secret-reference dropdown.

Confirmed cause of the match — `REDACTION_RULES`' `credential-assignment` rule
(`src/types/PreviewRedactor.ts`):

```
/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|private[_-]?key)\s*["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([^\s"',;}\]]{8,})/gi
```

`secret` + `:` + 8-or-more characters matches `${secret:LONG_NAME}` exactly.

No trace of the exact site was needed in the end: since
`redactPreviewText`/`secretRedactionService.redactValue` is applied broadly
(webview `postMessage`, hosted-server responses, CLI output, logs) and secret
**names are not secret** (`SECRETS_AND_REDACTION_PLAN.md` says so repeatedly
and builds a whole settings UI that lists them), the correct fix is the same
regardless of which call site is hit: narrow the rule itself so it never
matches ctrlyoke's own reference syntax. Added a negative lookbehind,
`(?<!\$\{)`, immediately before the keyword alternation — it excludes exactly
the case where the keyword is preceded by `${` (i.e. `${secret:NAME}`,
`${token:NAME}`, etc.), while leaving every other credential-assignment match
(`api_key=...`, `token: "..."`, …) untouched. Regression test:
`src/test/unit/PreviewRedactor.test.ts` ("does not redact ctrlyoke's own
${secret:NAME} reference syntax").

## Cross-cutting: a test for the whole class

Whatever else lands, add one test asserting that a workflow whose prompt text
**documents** every ctrlyoke reference syntax — `!NAME`, `${secret:NAME}`,
`{{var}}`, `@file`, `#sym:`, `~diff`, `/skill:`, `/mcp:`, `$step:` — runs to
completion without throwing, in both `strictContextResolution` modes. Every
item above would have been caught by it.

## Files likely changed

| File                                                                      | Change                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/utils/VarSubstitutor.ts`                                             | Stop throwing on unresolved placeholders; mask fenced blocks (item 2)       |
| `src/utils/SecretReferenceParser.ts`                                      | Union process-map secret references into the effective grant (item 3)       |
| `src/utils/SecretResolver.ts`                                             | `getDeclaredSecretGrants` / `getProcessMaps` wiring for the above           |
| `src/types/PreviewRedactor.ts`                                            | **Done.** Narrowed `credential-assignment` so it does not eat `${secret:NAME}` (item 4) |
| `src/test/unit/WorkflowExecutor.test.ts`                                  | Documents-every-syntax regression test                                     |
