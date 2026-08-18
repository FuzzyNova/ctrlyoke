# Secrets and Sensitive-Value Redaction Plan

**Status:** In progress — Phases 1–2 declaration and prompt disclosure landed
**Priority:** High — before broader remote and automation APIs

## Problem

Workflows can configure MCP environment values, hook commands, scripts, and
variables. Literal credentials in workflow files are unsafe, while resolving a
secret at runtime is only half the problem: the value must also stay out of
logs, persisted run events, previews, exports, errors, and remote dashboard
payloads.

ctrlyoke needs a product-level secret contract before the standalone server,
full MCP control API, or shared workflow/template ecosystem expands.

## How people actually use credentials with AI harnesses

This is the grounding constraint for the whole design, and it rules out the
obvious "encrypted vault that interpolates values into prompts" shape.

Today, a developer working with any CLI harness does this:

1. The credential is installed **on the machine**, not in the conversation —
   a shell profile export, a `.env` file the app already loads, an OS keychain
   entry, or a tool that owns its own auth (`gh auth login`, `aws configure`,
   `gcloud auth`).
2. The harness is told the **name**. Every well-behaved assistant refuses a
   pasted key and instead writes `process.env.STRIPE_KEY` or `$STRIPE_KEY` into
   the code it generates.
3. The value reaches the credential's consumer through **process environment
   inheritance** — the harness's shell tool spawns a child, the child inherits
   the env, the script reads the name.

The value never enters prompt text, and the artifact the harness produces is
portable because it references a name that exists outside ctrlyoke.

**Therefore ctrlyoke is not a password manager, and secrets are not a prompt
interpolation feature.** ctrlyoke's job is to make step 1 reliable and
declared, make step 2 visible to the model, and make step 3 scoped and
auditable — then redact as defense in depth.

## Product Decision

Two entry kinds, one reference syntax, one resolution boundary.

**1. Env passthrough (the common case, no storage).** A workflow declares the
env var names it needs. ctrlyoke verifies they are present in the host
environment before the harness starts, tells the model the names, and stores
nothing. This is the zero-new-risk path and should be the documented default.

**2. Managed secret (the gap-filling case).** When the value is not already in
the machine environment — a headless runner, the hosted dashboard server, a
per-project token the user does not want exported globally in their shell
profile — ctrlyoke holds it in OS-backed storage and injects it as an
environment variable into the spawned child process only.

Both kinds are referenced by the model and by generated code **as an ordinary
environment variable**. The authoring gesture is an inline `!NAME` reference in
prompt text, which both names the secret and grants the step access to it:

```yaml
steps:
  - name: sync-inventory
    prompt: Update my Supabase inventory table using the key !SUPABASE_PAT.
  - name: nightly-report
    secrets: [SERVICE_API_TOKEN] # explicit grant for a step that never names it
    type: script
    script: ./scripts/post-report.sh
```

Names are constrained to `^[A-Z][A-Z0-9_]*$` so a declaration is always a legal
env var name and the same workflow works whether the value is managed by
ctrlyoke or already exported by the user.

### `!NAME` in prompt text is the grant

An inline reference is the declaration. This follows the precedent already in
the schema for `mcpServers`, where "use `/mcp:<server-id>` in the prompt to
force-attach a managed server" and "an inline reference wins over null" — the
prompt text is an authoritative input to resolution, not just prose.

The explicit `secrets: []` array exists for the cases an inline reference cannot
cover: script steps, hook commands, MCP `env`, and prompts that need the value
present without mentioning it. Effective grants for a step are the union of its
inline references and the resolved `secrets` array.

### What the harness actually receives

`!SUPABASE_PAT` is persisted in the prompt and **sent to the harness verbatim**,
exactly like an `@file` reference. The token stays; a generated secrets block
resolves it to the bare environment variable name and states how to read it:

```
Update my Supabase inventory table using the key !SUPABASE_PAT.

<availableSecrets>
!SUPABASE_PAT refers to SUPABASE_PAT, a credential available to you as an
environment variable in this shell. Read it by name (POSIX: $SUPABASE_PAT,
PowerShell: $env:SUPABASE_PAT). Never print, echo, log, or inline its value.
</availableSecrets>
```

Keeping the token is what every other ctrlyoke reference already does — the ref
survives in the prompt and a companion block carries the resolved content — so
round-trip editing, chip rendering, and re-parsing all behave as they do for
`@file` and `#sym:`.

Do **not** rewrite the token to `$SUPABASE_PAT` on the way out. Two concrete
reasons:

- Shell syntax is not portable. `$NAME` is POSIX; PowerShell needs
  `$env:NAME`. Baking one form into prompt text is wrong on the other platform,
  and ctrlyoke cannot know which shell the harness's tool will pick.
- `$` is already a ctrlyoke prompt trigger (`$step:`, `$prior-context`).
  Emitting `$NAME` into final-form prompt text invites collisions with
  ctrlyoke's own `$` scanning on any path that re-parses expanded text.

The block states the access mechanism once, per platform, and the `!` keeps the
reference visibly a ctrlyoke token rather than something the model might mistake
for a literal value. `env:NAME` was considered and rejected: it is a
ctrlyoke-invented prefix the model has to infer, and it looks enough like a
value-bearing token that a model may try to use it as the credential itself.

### Resolution boundary: child process env, never prompt text

`${secret:name}` interpolation into prompt bodies is **explicitly rejected**.
Expanding a value into prompt text puts plaintext into the model request, the
temp prompt file under `.ctrlyoke/temp/`, `events.jsonl`, the response
transcript, and every dashboard transport — the exact surfaces Phase 2 then has
to scrub. Resolution happens at process spawn and nowhere else.

A literal `${secret:NAME}` reference remains allowed in exactly one class of
field: maps whose values are consumed by a process rather than a model — MCP
`env`, MCP `headers`, and hook/script env. Even there, prefer indirection over
substitution (below).

### MCP servers: write the reference, inject the value

For MCP `env`, do not write the resolved value into a harness-native config
file on disk. Write a **reference token** into the generated config and put the
real value in the harness process env, so the file on disk carries only a name.

**The token is per harness — there is no universal `${VAR}`.** OpenCode already
proves this: `OPENCODE_CONFIG_SUBSTITUTION_PATTERN` in
`src/core/harness/opencode/OpenCodeInlineConfig.ts` is `/\{(?:env|file):/iu`, so
OpenCode's form is `{env:NAME}`, and `containsOpenCodeConfigSubstitution()`
already exists to detect it. Model the token as a per-provider hook (alongside
the existing config-generation seams in `CliMcpConfigGenerator` and
`CliProviderUtils`) rather than hardcoding one syntax, and **verify the
remaining five harnesses empirically** before relying on expansion:

- Harness expands a reference → write the reference, inject to process env.
- Harness does not expand → substitute the value into the config, and treat
  that config file as a secret artifact (0600 where the platform supports it,
  deleted on run completion by `TempFileManager`, never included in exports or
  bundle analysis).

Remote MCP `headers` follow the same rule. `OPENCODE_CONFIG_CONTENT` is
env-only and never hits disk, which is the preferred shape.

### Step-scoped grants, not blanket injection

Injected secrets are readable by **anything the harness runs**, including
commands the model composes itself. That is inherent — the same is true of the
user's own shell — but it means the grant must be narrow and explicit:

- No secret is injected unless the step names it — inline as `!NAME`, or in a
  `secrets:` array on the step or workflow.
- The grant list is part of the persisted workflow and visible in dry-run
  preview, so a review of a shared workflow shows which credentials it wants.
- Treat "harness step declares a secret" as a meaningful trust event worth
  surfacing in the run preview alongside external-root approvals.

## Implementation order

Phases are numbered by topic, not by build order. **Build Phase 5 before
Phase 3**: both Phase 3 surfaces (the `!` completion source and the properties
panel's known-name dropdown) read the secret registry that Phase 5 introduces,
so shipping Phase 3 first means inventing a throwaway listing path. The
dependency-correct order is 1 → 2 → 4 → 5 → 3 → 6.

## Phase 1 — Store, declaration, and resolution

- [x] Promote the existing `SecretStore` interface in `src/platform/ServerTokenStore.ts`
      into a first-class platform contract (`get`/`store`/`delete`/`keys`) and keep
      `ServerTokenStore` as one consumer of it.
- [x] Extension host: back it with VS Code `SecretStorage`, keyed by scope
      (`ctrlyoke.secret.user.<NAME>` vs `ctrlyoke.secret.ws.<hash>.<NAME>`).
- [x] CLI/server host: back it with an OS credential-store adapter (macOS
      `security`, Linux `secret-tool`/libsecret, Windows DPAPI via CredMan). If no
      backend is available, **fail and direct the user to env passthrough** — never
      fall back to a plaintext file.

Store-half implementation decisions:

- Workspace `<hash>` is the first 12 hexadecimal characters of SHA-256 over
  the resolved workspace root in the platform-aware path-comparison form. This
  matches the existing project identity length while keeping equivalent
  Windows path casing in one scope.
- macOS and Linux adapters maintain a small encrypted credential-store index
  for `keys()`, because safe generic enumeration through `security` and
  `secret-tool` would otherwise require dumping credential contents. Windows
  uses CredMan through DPAPI-backed generic credentials, with the same index
  contract.
- Unsupported platforms and missing credential-store executables fail with an
  actionable env-passthrough message. There is intentionally no plaintext
  file fallback.
- [x] Add `secrets` to `#/definitions/executionProperties` in
      `schemas/workflow-schema.json`, mirrored in `src/types/CtrlYokeTypes.ts`.
      Placing it there — not on `promptStep` alone — gets `_runtime` capture and
      `scriptStep` coverage for free, since `executionProperties` is already shared
      by all of them (`promptRuntimeMetadata` `allOf`-refs it, so `_runtime` needs
      no extra schema work).
- [x] **Precedence is not free — it is four explicit edits, not one.**
      `EXECUTION_PROPERTY_KEYS` in `src/types/CtrlYokeTypes.ts` only drives
      `PromptFileParser.copyExecutionProperties()` and `WorkflowSerializer`; it does
      not feed resolution. `PropertyResolver` (at `src/utils/PropertyResolver.ts`,
      not `src/core/`) is a thin VS Code adapter that delegates to
      `resolveExecutionProperties()` in `src/types/ExecutionPropertyResolver.ts`,
      which resolves every property by hand. Adding `secrets` therefore means:
  1. `EXECUTION_PROPERTY_KEYS` (parse/serialize round-trip),
  2. a `resolveSecrets()` in `ExecutionPropertyResolver.ts` copied from
     `resolveSkills()` — the exact replace-not-merge + `null`-clears precedent —
     wired into the returned `properties` and `sources` objects,
  3. `secrets?: string[] | null` on `ExecutionPropertyDefaults` and
     `secrets?: string[]` on `ResolvedProperties` in
     `src/types/ExecutionPropertyTypes.ts`,
  4. a `secrets` default in `PropertyResolver.createDefaults()`.
- [x] Shape it like `skills`: `oneOf [ array of ^[A-Z][A-Z0-9_]*$ strings, null ]`,
      where prompt-level replaces workflow-level with no merging and `null`
      explicitly disables an inherited grant. Note the asymmetry to document: an
      inline `!NAME` reference still grants, because it is an authoritative input
      like `/mcp:` — `null` clears the inherited _array_, not what the prompt says.
- [x] `scriptStep` has `"additionalProperties": false`, so its `secrets` entry must
      be added explicitly alongside `errorBehavior` rather than inherited.
- [x] Parse inline `!NAME` references in `src/utils/SecretReferenceParser.ts`
      using the shared secret-name validator and filename-boundary convention, and
      expose the effective inline-plus-array grant union. This declaration step
      intentionally does not yet validate unknown inline names or inject values.
- [x] Resolve at spawn: extend `CliTransportCoordinator`'s existing env plumbing
      (`withProcessEnvOverrides` and the `env` passed to the child) and the
      `EndConditionEvaluator` script env with the granted set. Restrict
      `${secret:...}` expansion to MCP/hook/script env and header maps only.
- [x] **Preflight before the harness starts.** A declared name that resolves to
      neither a managed secret nor a present env var fails the run with the name and
      scope, before any process spawns, before any billable harness turn.

## Phase 2 — Telling the model the names

Without this, the feature is only redaction and users get no value from
registering anything.

The `<availableSecrets>` block is **its own prompt category**, not part of the
excerpt or prompt files. Every other category in
`formatCategorizedInstruction()` (`src/core/HarnessIntegration.ts`) names a distinct kind of
input, and the dashboard's preview, token accounting, and truncation reporting
all key off that category. Folding secrets into excerpts would label them
"Excerpts" in the preview and make them share the excerpt inline-content cap;
folding them into the prompt file would make user-authored text and
ctrlyoke-generated instructions indistinguishable in every downstream surface.
Neither is recoverable later.

- [x] Add `TEMP_FILE_CATEGORIES.SECRETS` and a matching `PREVIEW_PROMPT_CATEGORIES`
      entry with a `PREVIEW_PROMPT_CATEGORY_LABELS` label, both in
      `src/types/DashboardConstants.ts`.
- [x] Thread a `secretRefs: string[]` parameter through
      `formatCategorizedInstruction()`, `CliIntegration.formatCategorizedReferences()`,
      and `CliPromptPreparer`'s `addChunkFiles` call sites, following the shape the
      agent and skills categories already use.
- [x] **Clause position: immediately after agent instructions.** It is a behavioral
      constraint, like agent instructions, rather than reference material. It also
      keeps excerpts as the last optional clause, so the existing
      `excerptPrefix = clauses.length === 0 ? "using" : "and"` logic is untouched —
      appending secrets after excerpts would strand that `and` mid-sentence.

  ```
  Following these agent instructions @agent.md, using these secrets @secrets.md,
  using these available skills @skills.md, … follow the instructions in @prompt.md
  ```

- [x] **Leave it out of `isTierTwoCategory()`.** Tier two (agent, skills, excerpts)
      caps the preview body at `MAX_CONTENT_SIZE`. The secrets block is bounded and
      small, and it is exactly the content a user will want to read in full in
      dry-run preview to confirm what the model was told.
- [x] The block is derived from the grant list, so it is deterministic, reviewable,
      and safe to write to a temp file — names are not secret, and `TempFileManager`
      deletes the file when the turn completes like every other category.
- [x] An unknown `!NAME` is a validation error, not a silent pass-through. Shipping
      an unexplained `!SUPABASE_PAT` with no block to resolve it reads as neither
      prose nor a variable.
- [x] No grants means no category, no file, and no clause — same as every other
      optional category.

## Phase 3 — Authoring UX

### Prompt editor: `!` completion trigger

Add `!` as a sixth trigger in `CodeMirrorEditor`'s `customCompletions`
alongside `@ # ~ $ /`, serving secret **names** from the registry. Values never
enter the completion payload, so the existing `REQUEST_COMPLETIONS` round trip
needs no new protection.

Sync points — the trigger set and its word-boundary lookbehind are deliberately
duplicated across layers, and the boundary regex `[A-Za-z0-9_+=@#$%^&!~-]` is
copy-pasted in several files. All of these need the new trigger:

- `CodeMirrorEditor.tsx` — `customCompletions`, `CompletionTrigger` union
- `src/completions/PromptCompletionProvider.ts` — `TriggerChar` union (currently
  `"@" | "#" | "~" | "$"`; it has no `/`, so `!` is the fifth here even though it
  is the sixth in the editor) and the `findWordStartTriggerIndex` /
  `maxIndex` chain (its header comment already says to keep it in sync with the
  webview copy)
- `src/completions/CompletionHelpers.ts` — the `_triggerChar` union (this one
  does include `/`)
- `src/completions/PromptLinkProvider.ts` — a `!NAME` pattern so the reference
  is clickable and navigates to the Secrets settings page
- `src/ui/webview-react/utils/atomicReferences.ts` — chip rendering, so a
  secret reference is an atomic chip like every other reference
- `WorkspaceFileEditor.tsx` — same decoration patterns for the workspace editor

Two gotchas specific to `!`:

- **`!` is already in the filename-boundary character class.** That works in
  our favor — `data!file.csv` and prose like `Done!` are correctly not
  triggers, since the `!` is preceded by a boundary char. It means no change to
  the class is needed, but it also means an existing filename containing `!`
  keeps parsing as before, which must be covered by a test.
- **Markdown image syntax `![alt](url)` starts with `!` at a word boundary**
  and would open the dropdown. The character-class guard must be strict —
  `/^[A-Z0-9_]*$/` — so `![` bails on the first character. Uppercase-only also
  means the dropdown never fires on ordinary lowercase prose after a `!`.

Chip treatment should distinguish a resolvable name from an unknown one, reusing
the existing `referenceValidityRef` warning-border path rather than a new
mechanism.

Phase 3 status: prompt-editor completion/chips/links and the workflow properties
secret grant list are implemented. The workflow panel keeps inline `!NAME`
grants checked and locked, shares the unresolved-name diagnostic path, and
supports the global-default affordance. CLI authoring remains Phase 6.

### Workflow Properties panel: the grant list

`WorkflowPropertiesPanel` is a paged drawer (`DRAWER_PAGES`), and secrets belong
on the existing **Permissions** page rather than a seventh tab. The page is
already the drawer's trust-and-capability surface (`workspace-trusted` codicon,
tool permission mode, allow/deny lists), and a secret grant is exactly that kind
of decision. A new tab would also need a `DRAWER_TABS` entry competing for
horizontal space in a panel that already goes narrow at 400px.

Render it as a `MultiCheckboxDropdown` of known secret names — the same control
`skills` uses, including the "Active: …" summary line and the `SetAsDefaultButton`
treatment, since `secrets` has identical replace-not-merge and `null` semantics.
Add `secrets` to `isDifferentFromGlobal`'s array-comparison branch beside
`skills`.

Two additions specific to secrets:

- Show inline-referenced names as **checked and locked**, with a hint that the
  prompt text grants them. Otherwise the panel would contradict the prompt, and
  unchecking would appear to work while `!NAME` keeps granting.
- Flag a granted name that resolves to neither a managed secret nor a present
  env var, using the existing `FieldDiagnostic` treatment. This is the same
  preflight that blocks the run, surfaced at authoring time.

## Phase 4 — Central redaction pipeline

`src/types/PreviewRedactor.ts` already exists as the annotated swap point, with
heuristic `REDACTION_RULES` and an unused-in-production `exactSecrets`
parameter. It is now also the matching core used by the runtime redaction
service; runtime output no longer depends on provider-specific hooks.

- Build a per-run redactor from the values actually resolved for that run and
  feed them through the existing `exactSecrets` path.
- Promote it from preview-only to a service applied before data reaches: `Log`
  output and session logs, `events.jsonl`, `manifest.json`, notifications and
  `WebPushService` payloads, error and failure messages, Markdown export,
  `CliJsonResultBuilder` / `CliTerminalFormatter` output, and every
  `CtrlYokeHostedServer` transport.
- Redact common encoded/quoted representations only when deterministic; avoid
  broad heuristics that corrupt normal output.
- Mark redaction as `[REDACTED]` without revealing which secret matched.
- Keep the heuristic rules as a separate layer from exact-value matching — the
  heuristics also catch credentials ctrlyoke was never told about, which is the
  main protection for users who paste a key into a prompt.

Phase 4 coverage (implemented):

- `RunSecretRedactor` is populated only from values resolved during execution;
  `SecretRedactionService` applies those exact values through
  `redactPreviewText()`'s existing `exactSecrets` path and keeps heuristic
  matching independent. Deterministic JSON escaping is covered; broad
  base64/URL guessing is intentionally omitted to avoid false positives.
- Log output/session logs, timeline `events.jsonl` and `manifest.json`, CLI
  JSON/terminal output, dashboard/webview messages, notifications, hosted
  HTTP/WebSocket transports, Web Push payloads, and Markdown export are wrapped.
- The former OpenCode stderr hook was removed; shared response collection and
  transport boundaries now use the same service for all harnesses.
- Harness-native session logs and third-party telemetry files are deliberately
  not rewritten in place: ctrlyoke redacts what it reads, persists, logs, or
  transports, while modifying vendor-owned files would corrupt their session
  history and exceed ctrlyoke's ownership boundary.

## Phase 5 — Settings UX (the secret registry)

**A new top-level "Secrets" tab in `GlobalSettingsDrawer`, not a subsection of
`AdvancedPermissionsSection`.** The permissions tab is about tool-execution
policy; secrets need their own CRUD list, their own set/unset state model, and
are referenced from MCP Manager and workflow authoring, so they need a stable
destination to link to. Place it after `permissions` with `codicon-key`;
`AdvancedPermissionsSection` gets a one-line cross-reference only.

The drawer's existing header `ScopeToggle` (User/Workspace) already provides
the scope model — the Secrets tab reads `activeScope` like every other section.

Backend half (implemented):

- [x] Extension-host `SecretRegistryService` lists managed names and declared
      environment names per scope, classifies their safe state, persists only
      description/timestamp metadata beside the encrypted value, and computes
      MCP/workflow usage.
- [x] Webview list/set/delete contracts and the Zustand registry store carry
      names and metadata only. Secret writes are write-only: the response is
      `{ name, scope, state: "set" }` and never echoes the submitted value.
- [x] The Secrets tab UI is implemented as the global settings tab. It consumes
      the registry store and keeps values confined to the write-only set path.
- [x] Prompt-editor completion triggers, links, atomic chips, and the workflow
      properties secret grant list are implemented; CLI authoring remains Phase 6.

**List view.** One row per name:

| Name                | State                            | Actions                                |
| ------------------- | -------------------------------- | -------------------------------------- |
| `SERVICE_API_TOKEN` | Managed · set · updated 3d ago   | Replace, Delete                        |
| `GITHUB_TOKEN`      | From environment · detected      | Convert to managed, Remove declaration |
| `STRIPE_KEY`        | From environment · **not found** | Set value, Remove declaration          |

- **No reveal action, ever.** Values do not travel to the webview, so the UI
  renders state and metadata, never ciphertext or masked characters standing in
  for a real length.
- Show a "Used by" column or expander listing referencing MCP servers and
  workflows. Names are not secret, and this is the highest-value affordance in
  the tab — it answers "can I delete this?".
- Missing env-passthrough entries render with the warning treatment already
  used by `AdvancedPermissionsSection`'s antigravity warning.

**Set/Replace dialog.**

- Name: text input, validated against `^[A-Z][A-Z0-9_]*$`, disabled on Replace.
- Value: `type="password"` with `autocomplete="new-password"`, plus a masked
  textarea variant for multi-line values (PEM private keys are a real case and
  a single-line input silently mangles them).
- Scope: prefilled from the drawer's active scope, overridable in the dialog.
- Optional description (stored as metadata, shown in the list).
- On submit, post the value once and clear component state immediately; the
  store confirms with `{ name, scope, state: "set" }` and never echoes back.

**Other surfaces that consume the registry.**

- [x] MCP Manager env editor offers a picker inserting `${secret:NAME}` and warns
      when a field looks like a pasted literal credential.
- [x] Dry-run preview shows granted names and `[REDACTED]`, never the value, and
      surfaces unresolved names as a blocking diagnostic in the same place
      `PermissionCapabilitySummary` diagnostics appear.

## Phase 6 — CLI

A `secret` command group registered from `src/cli.ts`. Note that
`trust-external-roots` is defined **inline** in `src/cli.ts` (~line 140) and is
the precedent only for the confirm/report UX; the structural precedent for a
multi-subcommand group is `src/cli/HistoryCommandDefinitions.ts` +
`src/cli/HistoryCommands.ts` (`registerHistoryCommands`). Follow that pair:
`src/cli/SecretCommandDefinitions.ts` for option/argument shapes and
`src/cli/SecretCommands.ts` for the handlers.

```
ctrlyoke secret set <NAME>     # hidden TTY prompt; --stdin to pipe; --scope user|workspace
ctrlyoke secret list           # names, scope, set/unset, source — never values
ctrlyoke secret rm <NAME>      # --scope; confirm unless -y
ctrlyoke secret check [file]   # preflight a workflow: declared vs resolvable
```

- **Never accept a value as an argv parameter.** argv lands in shell history
  and is world-readable via `ps` on Linux. Read from a hidden TTY prompt or
  stdin only.
- There is deliberately **no `secret get`**. Users who need the value already
  have it; a print path exists only to be shell-captured into a log.
- `secret check` is the CI-friendly entry point and should share the exact
  Phase 1 preflight code path as `run`, not reimplement it.
- Document that `ctrlyoke run` in an environment with no credential backend
  works fine with env passthrough — that is the intended CI story.

## Security constraints

- Never include secret values in telemetry.
- Never send a secret value to the webview — not to render a settings form, and
  not in a completion payload. The `!` completion carries names only.
- Zero secret buffers where practical and avoid retaining resolved workflow
  copies beyond execution.
- Treat user-authored commands **and model-composed commands** as capable of
  printing secrets; redaction is defense in depth, not a sandbox. This is why
  grants are step-scoped.
- Config files generated with a substituted value are secret artifacts:
  restrictive permissions, deleted after the run, excluded from export and
  bundle analysis.
- Add tests across failure, retry, cancellation, export, and remote-dashboard
  paths because leaks often occur outside the successful execution path.
- Add a test asserting the resolved value never appears in a run's
  `events.jsonl`, `manifest.json`, or session log — the regression that matters.

## Acceptance criteria

- A shared workflow can reference a credential by name without containing it,
  and runs unchanged whether the value is ctrlyoke-managed or already exported
  in the user's environment.
- Extension, CLI, and server hosts resolve through explicit platform adapters,
  with no plaintext fallback.
- The model is told which names are available and reliably reads them from the
  environment instead of asking for the value.
- Typing `!` in the prompt editor lists secret names, never values, and the
  picked reference alone is enough to grant the step access — no second gesture
  in the properties panel required.
- A `!NAME` reference and a `secrets:` entry produce identical execution
  behavior, and the properties panel and prompt text never disagree about what
  is granted.
- Resolved values are redacted from every persisted and transported output
  surface covered by the test matrix.
- Missing-secret behavior fails, naming the secret and scope, before the
  harness or any script starts.

## Open questions

- Which of the six harnesses expand a reference inside their MCP config env
  values and headers? **Answered from each harness's documented config format
  and the checked-in OpenCode implementation; no billable harness runs were
  used.** The generator owns the provider hook, and the existing spawn-time
  environment injection supplies the real value under the referenced name.

  | Harness           | Native env reference                                                                       | Native header reference                                                                        | Handling                                                                                                                                                              |
  | ----------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `copilot-cli`     | `$NAME`, `${NAME}`, or `${NAME:-default}`                                                  | Same forms                                                                                     | Write `${NAME}` into the temp JSON config; inject `NAME` into the Copilot process environment.                                                                        |
  | `claude-cli`      | `${NAME}` or `${NAME:-default}`                                                            | Same forms                                                                                     | Write `${NAME}` into the temp JSON config; inject `NAME` into the Claude process environment.                                                                         |
  | `codex-cli`       | `env_vars = ["NAME"]` (named parent-env forwarding; static `env` values are not templates) | `env_http_headers = { Header = "NAME" }`, or `bearer_token_env_var = "NAME"` for Authorization | Emit Codex's native named forwarding fields. Composite `${secret:NAME}` values are rejected because Codex has no safe equivalent.                                     |
  | `opencode-cli`    | `{env:NAME}`                                                                               | `{env:NAME}`                                                                                   | Preserve `OPENCODE_CONFIG_CONTENT` as process-env-only inline JSON; never write it to disk.                                                                           |
  | `qwen-cli`        | `$NAME` or `${NAME}` in settings strings                                                   | Same settings-string expansion                                                                 | Write `${NAME}` into the inline JSON config; inject `NAME` into the Qwen process environment.                                                                         |
  | `antigravity-cli` | No substitution syntax in the inspected `.agents/mcp_config.json` format                   | No substitution syntax                                                                         | Substitute from the already-resolved run environment, chmod the generated config to 0600 where supported, and remove/restore it through the existing tracker cleanup. |

  References: [Copilot CLI MCP configuration](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#local-server-configuration-fields), [Claude Code MCP configuration](https://docs.anthropic.com/en/docs/claude-code/mcp), [Codex MCP configuration](https://developers.openai.com/codex/mcp), and [Qwen Code settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/). OpenCode is answered in `src/core/harness/opencode/OpenCodeInlineConfig.ts` by `OPENCODE_CONFIG_SUBSTITUTION_PATTERN` (`/\{(?:env|file):/iu`) and `containsOpenCodeConfigSubstitution()`.

  The Antigravity path is the only substituted artifact. Its workspace config is
  restored to the pre-run baseline (or deleted when ctrlyoke created it), so a
  generated plaintext credential does not remain after cleanup. Existing
  user-authored plaintext in a pre-existing baseline is outside this step's
  ownership and is not rewritten or exported by ctrlyoke.

- Should workspace-scoped managed secrets require the same one-time trust
  approval that `permissions.allowedExternalFileRoots` does, given a cloned
  repo can declare grants? Leaning yes for grants, no for values the user set
  themselves.
- Does the hosted dashboard need any secret write path at all, or is it
  read-only state plus "set this from the CLI/extension"? Leaning read-only.
  Decided:

- **`!NAME` persists and is sent verbatim.** The token survives into the
  persisted prompt and into what the harness receives, matching `@file` refs;
  the `<availableSecrets>` block resolves it. See "What the harness actually
  receives".
- **The resolved grant union is written to `_runtime`.** A completed run records
  what it was actually granted — inline references plus `secrets:` array — so
  history, preview, and audit never re-parse prompt text to answer the question.
  `secrets` lives in `executionProperties`, which `promptRuntimeMetadata`
  already composes, so the field exists on `_runtime` with no extra schema work;
  the only requirement is that resolution writes the union rather than echoing
  the authored array.
