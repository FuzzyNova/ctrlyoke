# Overzealous Step Failures Plan

> **Status:** Not started — problems verified against the code, fixes not
> designed in detail.
> **Priority:** P1 for item 2 (latent, trips any workflow that uses `vars`);
> P2 for the rest.
> **Origin:** Fell out of implementing
> `dev/implemented/CONTEXT_RESOLUTION_FAILURE_MODE_PLAN.md`. That plan's own
> orchestrator run failed repeatedly on item 1 below, which was fixed during
> its review pass; the same shape of bug turned out to exist in three other
> places.

## The pattern

ctrlyoke has several guards that hard-fail a step because prompt text or
config *mentions* a ctrlyoke syntax, without being able to tell "the author
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

## 2. `{{name}}` throws when the workflow defines any vars

**Verified.** `VarSubstitutor.substitute` (`src/utils/VarSubstitutor.ts:28`)
throws on any `{{key}}` with no matching entry:

```
Unresolved variable "{{foo}}" — pass --var foo=<value> or add it to the workflow's vars: section
```

Both entry points bail out first when there are no vars at all:

```ts
if (!promptText || Object.keys(vars).length === 0) return promptText;   // :55
```

So the bug is **latent, not universal**:

| Workflow | `{{foo}}` in prompt text |
| --- | --- |
| No `vars:` and no `--var` | Passes through untouched — no error |
| **Any** vars defined | **Throws, killing the step** |

A workflow that uses variables for anything can therefore no longer *discuss*
variable syntax. The failure is also confusing: the message tells you to define
`foo`, when the author never wanted a variable at all.

Applies to prompt text, `model`, `additionalArgs`, hook commands, hook `env`,
endCondition `script`/`env`/`retryPrompt`/`passRetryPrompt`
(`applyToResolvedProperties`, `applyToHook`, `applyToEndCondition`), and
worktree `setup` (`WorktreeManager.ts:2524`).

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
confusing auth error. So "just warn and continue" is *not* obviously right
here — something really was going to be substituted.

The problem is not that ctrlyoke checks. It is that the **grant is a second,
separate gesture** the user has no reason to expect:

- The user set up the secret, referenced it correctly in the MCP/script config,
  and is then told the workflow is invalid because they didn't *also* list it
  somewhere else.
- The MCP Manager env editor **inserts `${secret:NAME}` for them** (shipped in
  `SECRETS_AND_REDACTION_PLAN.md` Phase 5) and does not add the grant, so the
  product actively walks users into the failure.
- **Script steps cannot satisfy it inline at all.** They have no prompt, so
  there is no `!NAME` gesture available; `secrets: [NAME]` is the only option —
  and that array is not editable from the UI today (see
  `WORKFLOW_SCHEMA_UI_PARITY_PLAN.md`), which makes the failure
  *unrecoverable* for a UI-only author.

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

1. **Treat `${secret:NAME}` in a step's own process maps as an authoritative
   grant**, exactly like inline `!NAME`. Configure the MCP server or script
   with the secret and it comes as a package. This is a change to
   `getDeclaredSecretGrants`/`getEffectiveSecretGrants` (union in names
   collected from the step's process maps), after which both the preflight
   throw and the `expandSecretInterpolations` throw become unreachable for this
   case and can stay as genuine invariant guards.
2. **Put the cloned-repo protection where it belongs:** a one-time trust
   approval that surfaces *every* grant a workflow wants — inline and env-map
   alike — reusing the `permissions.allowedExternalFileRoots` approval pattern.
   `SECRETS_AND_REDACTION_PLAN.md`'s own open questions already propose this
   ("Leaning yes for grants") and it was never built. One coherent gate beats
   one silent path plus one noisy one.
3. Keep the invalid-name throw (`isValidSecretName`) and the runtime
   `MissingSecretError` — those are real resolution failures, not declaration
   friction.

## 4. The heuristic redactor rewrites authored prompt text

**Partly verified — needs one more trace before fixing.**

Observed: a prompt authored as `${secret:SOME_NAME}` reached the harness as
`${secret:[REDACTED]}`. The **name** was redacted, not a value.

Confirmed cause of the match — `REDACTION_RULES`' `credential-assignment` rule
(`src/types/PreviewRedactor.ts:43`):

```
/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|private[_-]?key)\s*["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([^\s"',;}\]]{8,})/gi
```

`secret` + `:` + 8-or-more characters matches `${secret:LONG_NAME}` exactly.

Confirmed *not* the cause: `CliPromptPreparer` does no redaction, so the prompt
file is not rewritten at preparation time. The rewrite happens further
upstream — `PostMessageDashboardSink` and `CtrlYokeWebviewProvider` both wrap
messages with `secretRedactionService`, so the likely path is the webview
transport or a persistence step before it. **Trace the exact site before
designing a fix**; the correct fix differs depending on whether authored text
is being redacted on the way *in* (a corruption bug) or only on the way *out*
to a display surface (a display-only annoyance).

Notes for whoever picks this up:

- Secret **names are not secret** — `SECRETS_AND_REDACTION_PLAN.md` says so
  repeatedly and builds a whole settings UI that lists them. Redacting a name
  protects nothing.
- The heuristic layer exists to catch credentials ctrlyoke was never told
  about, which is genuinely valuable; the fix is to narrow this rule (e.g.
  exclude a `${secret:...}` reference form), not to disable heuristics.
- `permissions.heuristicSecretRedactionEnabled` (default on) is the existing
  escape hatch, but "turn off all heuristic redaction" is a bad trade for
  "stop mangling a reference syntax."

## Cross-cutting: a test for the whole class

Whatever else lands, add one test asserting that a workflow whose prompt text
**documents** every ctrlyoke reference syntax — `!NAME`, `${secret:NAME}`,
`{{var}}`, `@file`, `#sym:`, `~diff`, `/skill:`, `/mcp:`, `$step:` — runs to
completion without throwing, in both `strictContextResolution` modes. Every
item above would have been caught by it.

## Files likely changed

| File | Change |
| --- | --- |
| `src/utils/VarSubstitutor.ts` | Stop throwing on unresolved placeholders; mask fenced blocks (item 2) |
| `src/utils/SecretReferenceParser.ts` | Union process-map secret references into the effective grant (item 3) |
| `src/utils/SecretResolver.ts` | `getDeclaredSecretGrants` / `getProcessMaps` wiring for the above |
| `src/types/PreviewRedactor.ts` | Narrow `credential-assignment` so it does not eat `${secret:NAME}` (item 4) |
| `src/ui/PostMessageDashboardSink.ts`, `src/ui/CtrlYokeWebviewProvider.ts` | Trace target for item 4 |
| `src/test/**` | The documents-every-syntax regression test |
