# OpenCode Inline Config Migration Plan

> **Status:** Stage 3 complete; Stages 4–5 proposed
>
> **Priority:** P0 — blocks the OpenCode half of
> [`TOOL_PERMISSION_PARITY_PLAN.md`](TOOL_PERMISSION_PARITY_PLAN.md)
>
> **Effect on that plan:** removes OpenCode as a consumer of the workspace
> permission lease, which deletes most of its "Workspace-Configuration Support"
> section rather than implementing it.

Move OpenCode off workspace-root `opencode.json` and off `.opencode/plugin/`
entirely, and deliver every ctrlyoke-owned setting through the
`OPENCODE_CONFIG_CONTENT` environment variable at spawn time. Stage 2 removes
the workspace-root `opencode.json` writes; the existing `.opencode/plugin/`
deployment remains until Stage 4.

---

## Problem

`OpenCodeCliProvider` writes `{workspaceRoot}/opencode.json` for both MCP
servers (`OpenCodeCliProvider.ts:312`) and permission policy
(`OpenCodeCliProvider.ts:410`), via `SettingsJsonMcpTracker`. Three
consequences:

1. **The agent commits ctrlyoke's config.** `opencode.json` lands in the repo
   root, untracked. `SettingsJsonMcpTracker.writeGitignore()`
   (`SettingsJsonMcpTracker.ts:993`) only writes a sibling `.gitignore` when
   none exists — in any real repository one does, so it returns early and
   `opencode.json` is never ignored. An OpenCode run that stages and commits
   (`git add -A`, `git commit -a`) sweeps ctrlyoke's transient config into the
   user's history. Confirmed in this repo: `git check-ignore opencode.json`
   exits 1.
2. **A shared mutable file demands a distributed lock.** Everything
   `TOOL_PERMISSION_PARITY_PLAN.md` specifies under "Workspace-Configuration
   Support" — PID+token owner identity, lease sidecars, dead-owner pruning,
   `withFileLock` atomicity, structured `PolicyLeaseResult` conflicts, a
   blocking conflict modal, CLI/MCP conflict exit codes — exists solely because
   two processes can race on one file. None of it is inherent to the feature.
3. **`.opencode/plugin/` is the same class of problem**, one directory over.
   `deployCompletionPlugin` (`OpenCodeCliProvider.ts:538`) writes
   `ctrlyoke-completion-hook.ts`, `ctrlyoke-hooks.json`, and a `.gitignore`
   into the repo.

## Verified findings

All verified against **OpenCode CLI 1.18.10** on Windows 11, this session,
using `opencode debug config` and real `opencode run` invocations against the
free `opencode/big-pickle` model, then corroborated against the **1.18.10
source at `c:\dev\opencode`** (same version as the installed CLI). Nothing
below is taken from documentation alone; where the docs are wrong, that is
called out.

### `OPENCODE_CONFIG_CONTENT` works and outranks the project file

Per [the precedence order](https://opencode.ai/docs/config/#precedence-order),
inline config sits above both project `opencode.json` and the `OPENCODE_CONFIG`
file path. Confirmed: with a project `opencode.json` present, inline values won
every conflict. In source, `config.ts:468` reads `process.env.OPENCODE_CONFIG_CONTENT`
and merges it in `loadInstanceState` after global config, the `OPENCODE_CONFIG`
file, project `opencode.json`, and the `.opencode/` directory scan.

`OPENCODE_CONFIG` is **not** a substitute — it loads _below_ project config, so
a user's `opencode.json` would still override ctrlyoke. Inline is the only
option that is authoritative.

Two first-party precedents confirm this is a supported pattern rather than an
accident of implementation:

- OpenCode's own CI drives a locked-down agent this exact way —
  `.github/workflows/docs-locale-sync.yml:59` sets `OPENCODE_CONFIG_CONTENT` to
  a `{"permission":{"*":"deny","read":"allow",…}}` block;
- OpenCode's own JS SDK spawns its server with
  `OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {})`
  (`packages/sdk/js/src/v2/server.ts:38`).

`config.ts:250` also skips seeding the default global config file when
`OPENCODE_CONFIG_CONTENT` is set — the loader explicitly recognizes
"this caller routes config through the environment."

### Both `permission` and `mcp` work inline, behaviorally

- `{"permission":{"*":"ask","bash":{"*":"deny"}}}` → the bash tool was removed
  from the model's toolset entirely ("I don't have a shell/Bash tool
  available"), input tokens dropped accordingly.
- `{"permission":{"*":"ask","bash":{"*":"allow","echo *":"allow"}}}` → `echo
hello-from-bash` executed, `exit: 0`.
- `{"mcp":{"inline-test":{"type":"local","command":[...],"environment":{...}}}}`
  → `opencode mcp list` showed the server registered and attempting connection,
  alongside the user's global `cclsp` server.

No `opencode.json` existed in the workspace for any of these.

### `ask` is fail-closed in headless mode

`{"bash":{"*":"ask"}}` under `opencode run` printed
`permission requested: bash (echo ask-test); auto-rejecting` and returned
`"The user rejected permission to use this specific tool call."` In the TUI,
`ask` prompts. This matters for the ordering hazard below: a degraded rule is
never _more_ permissive than intended in headless mode.

### The merge is per-key and order-sensitive — this is the sharp edge

Configs are **deep-merged, not replaced**, and OpenCode evaluates permission
patterns with **the last matching rule winning**
([docs](https://opencode.ai/docs/permissions/)). Merge positioning is therefore
security-relevant. The merge is remeda's `mergeDeep` (`config.ts:41`), applied
left-to-right as `result = mergeConfigConcatArrays(result, next)`
(`config.ts:352`) — which explains all three measured rows below: JS spread
semantics preserve the target's key positions and append new source keys, and
`mergeDeep` recurses only into plain objects, so a type mismatch replaces.
Measured behavior:

| Case                                                        | Result                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Key exists only in inline config                            | **Appended after** all lower-precedence keys, in inline emission order    |
| Key exists in both                                          | Keeps the **project file's position**, takes the **inline value**         |
| Types differ (user scalar vs inline object, or the reverse) | Inline **replaces wholesale**; the user's rules for that tool are dropped |

The second row is the hazard. Given a project `opencode.json` of
`{"permission":{"bash":{"npm *":"allow"}}}` and a ctrlyoke policy of
`{"*":"ask","bash":{"*":"ask","npm *":"deny"}}`, the resolved config was:

```json
"bash": { "npm *": "deny", "*": "ask" }
```

ctrlyoke's `deny` retained the user's early slot, so its own trailing `"*":
"ask"` overrode it. `npm` degraded from `deny` to `ask` — auto-rejected in
headless, but **user-approvable in the TUI**. Fail-closed in one mode, weakened
in the other. Not acceptable as-is.

**Mitigation — guarantee every emitted key is textually novel.** OpenCode's
matcher treats `*` as "zero or more characters", so appending a `*` produces a
distinct key with identical semantics. Both verified by real run:

- nested: `{"bash":{"**":"deny"}}` → bash denied, and OpenCode echoed the
  matched rule `{"permission":"bash","pattern":"**","action":"deny"}`.
- top level: `{"permission":{"**":"deny"}}` → **all** tools stripped (input
  tokens fell from ~9 800 to 2 295, model emitted a raw-text tool call),
  proving `**` matches tool names as a catch-all just as `*` does.

So collision avoidance is: resolve the user's effective key set, and for any
ctrlyoke key that collides, append `*` until novel. See "Stage 3".

### Config text is `{env:}`/`{file:}`-substituted before parsing

`config/variable.ts:33` applies `{env:VAR}` and `{file:path}` substitutions to
config **text** before it is parsed, and this runs on `OPENCODE_CONFIG_CONTENT`
like any other source. Verified:

- `{"bash":{"echo {env:MY_SECRET} *":"allow"}}` resolved to
  `"echo pwned-via-env *"`;
- `{"bash":{"echo {file:leak.txt}":"allow"}}` resolved to the file's contents.

**Structural break-out does not work** — this was tested directly. A file whose
contents were `x","*":"allow","zzz":"` resolved to a single escaped key
(`"echo x\",\"*\":\"allow\",\"zzz\":\""`), leaving the surrounding permission
block intact. The substitution is JSON-string-aware, so an injected value
cannot rewrite the policy structure.

Two residual hazards remain, both of which **already exist today** on the
file-based path (`loadConfig` substitutes every source identically) and so are
not regressions introduced by this migration — but they must not be carried
forward unexamined:

1. **Information disclosure.** A user-authored tool pattern containing
   `{env:AWS_SECRET_ACCESS_KEY}` or `{file:~/.ssh/id_rsa}` is expanded into the
   resolved config. That expansion must never reach dry-run output, run
   history, or logs.
2. **Silent semantic rewriting.** A pattern stops matching the literal string
   its author wrote, with no diagnostic.

Mitigation: detect `{env:` and `{file:` in ctrlyoke-emitted permission patterns
and MCP values at the mapper layer, and warn rather than pass them through.

### Anything merged after inline config still outranks it

`merge()` (`config.ts:351`) is purely order-dependent; its `kind` argument
affects plugin scoping only, not value precedence. The org/console config
(`config.ts:504`) and managed/MDM configs merge _after_ inline and therefore
override it. For an enterprise user with an active OpenCode org account,
administrator policy wins over ctrlyoke's permission block. That is the correct
outcome, but ctrlyoke must not claim its policy is unconditionally authoritative.

### `plugin[]` accepts paths outside the repo

The docs claim the `plugin` config key takes npm package names only. That is
wrong for 1.18.10. `opencode debug config` resolves auto-scanned plugins to
`file:///…` specs, and supplying such a spec explicitly works:

```
OPENCODE_CONFIG_CONTENT='{"plugin":["file:///C:/…/scratchpad/ocplug/ctrlyoke-probe.ts"]}'
```

loaded and executed a plugin from outside the workspace. **This is what lets
`.opencode/` leave the repo too.**

`config/plugin.ts:51-53` shows ctrlyoke need not build the URL itself: a
`file://` spec passes through, an absolute path — including the Windows
drive-letter form, matched explicitly by `/^[A-Za-z]:[\\/]/` — is converted via
`pathToFileURL`, and a relative spec resolves against the config source
directory (`ctx.directory` for inline config, per `config.ts:471`). Passing the
absolute extension path and letting `pathToFileURL` escape it removes the
spaces-in-path concern entirely.

Two related corrections to ctrlyoke's current assumptions, both from
`config/plugin.ts:21`, where the auto-scan glob is `{plugin,plugins}/*.{ts,js}`:

- both `.opencode/plugin/` and `.opencode/plugins/` are scanned — ctrlyoke's
  singular form (`OpenCodeNotificationMonitor.ts:36`) is fine;
- `.js` **is** scanned, so the comment at `OpenCodeCliProvider.ts:546`
  ("OpenCode only loads .ts plugins — .js files are silently ignored") is stale
  for 1.18.10. Retire it with the rest of the deployment code rather than
  preserving it.

`ctrlyoke-opencode-plugin.ts` is already fully env-driven —
`CTRLYOKE_NOTIFY_DIR`, `CTRLYOKE_WORKSPACE_ROOT`, `CTRLYOKE_RUN_ID`, etc. — and
uses no `__dirname` or plugin-relative resolution. Its only file dependency is
the hooks sidecar it reads from `{workspaceRoot}/.opencode/plugin/ctrlyoke-hooks.json`
(`ctrlyoke-opencode-plugin.ts:95`), which becomes an env var.

### Size is not a constraint

A 40 715-character inline config (2 200 bash rules) round-tripped intact
through `child_process` spawn on Windows. The oft-cited 32 767-character
per-variable limit applies to `cmd.exe`/registry paths, not `CreateProcess`
environment blocks. Any realistic ctrlyoke policy is two orders of magnitude
below this. Keep a defensive guard at ~32 KB anyway.

### Malformed inline config fails closed and echoes its content

`OPENCODE_CONFIG_CONTENT='{"permission":'` aborts startup with a JSONC parse
error **that prints the offending content to stderr**. ctrlyoke always emits
`JSON.stringify` output so it cannot trigger this, but MCP `environment` blocks
carry API keys, so this stderr path must be treated as secret-bearing and
excluded from output history. (OpenCode parses JSONC, so comments are legal —
ctrlyoke has no reason to emit any.)

## Design

One method builds the whole ctrlyoke-owned config object per step:

```jsonc
{
  "permission": {
    /* from OpenCodeToolPermissionMapper.buildPermissionPolicy */
  },
  "mcp": {
    /* ctrlyoke + user-defined servers */
  },
  "plugin": ["file:///<extensionPath>/out/scripts/ctrlyoke-opencode-plugin.ts"],
}
```

serialized to `OPENCODE_CONFIG_CONTENT` and returned from
`getHeadlessSpawnEnv()` / `getInteractiveSpawnEnv()`. Keys ctrlyoke does not
own are simply absent, so the user's global and project config still applies to
everything else.

`$schema` is dropped — inline config is never edited by a human.

### Where the env value is threaded

`ICliProvider` already declares `getInteractiveSpawnEnv?()`
(`ICliProvider.ts:394`) and `getHeadlessSpawnEnv?()` (`ICliProvider.ts:401`),
and all three spawn sites consume them: `CliTransportCoordinator.ts:125`
(standalone interactive), `:225` (VS Code PTY), `:570` (headless).
`AntigravityCliProvider.ts:294–303` is the existing precedent — it stashes
per-prompt state during `buildCliArgs` and serves it from those hooks.

Both hooks are parameterless, so the value must be held on the provider
instance. It cannot be built in one place: `CliIntegration.runExecutionSession`
calls `buildCliArgs` (`CliIntegration.ts:886`) — which is where MCP entries and
the plugin/hooks payload are resolved — and only calls
`prepareToolPermissions` (`:961`) afterwards, so the permission block does not
exist yet when `buildCliArgs` returns. Both run before either spawn-env hook is
consulted.

So the provider must **accumulate parts and serialize lazily**: keep a
`pendingInlineConfig` accumulator, have `getMcpConfigArgs` and the plugin/hooks
path populate their slices during `buildCliArgs`, have `prepareToolPermissions`
populate the `permission` slice, and `JSON.stringify` the whole object inside
`getHeadlessSpawnEnv()` / `getInteractiveSpawnEnv()`.

**Reset the accumulator at the top of `buildCliArgs`.** The integration is
reused across prompts within a run (`WorkflowInstance.ts:220-222`), so without
an explicit per-prompt reset a step that configures no MCP servers or no
permission policy silently inherits the previous step's — which for the
`permission` block means a step intended to run unrestricted would carry a
stale policy, or worse, a step intended to be restricted would carry a laxer
one if the order were reversed. `prepareToolPermissions` is also skipped
entirely when `workspaceRoot` is undefined, which is a second path to stale
state. Reset unconditionally, and cover it with the consecutive-steps test
listed under Testing.

**Provider instance state is safe here — this is the Antigravity pattern, and
it is correct.** Execution integrations are created **per workflow run**, not
per harness: `WorkflowInstance` owns
`executionIntegrations: Map<string, HarnessIntegration>`
(`WorkflowInstance.ts:224`), populated through
`IntegrationFactory.createForExecution()` (`IntegrationFactory.ts:103`), which
documents the guarantee directly — "execution integrations are per-run:
isolated event emitters, isolated process state, no shared fields between
parallel workflows" (`:94-96`).

The six `readonly` `CliIntegration` fields on `WorkflowOrchestrator`
(`:305-310`, constructed at `:386`, listed at `:423`) are **detector
singletons** used for availability checks and the status bar. They are not the
execution path. Do not mistake them for it.

So two concurrent workflows on OpenCode each get their own `CliIntegration` and
their own `OpenCodeCliProvider`, and a mutable `pendingInlineConfig` field
cannot race across them — exactly like `resolvedCurrentModel`
(`OpenCodeCliProvider.ts:75`) and Antigravity's `statusLineToken` today.

**The one real constraint** is within a single run: the integration is
deliberately reused across prompts (`WorkflowInstance.ts:220-222`), so
per-prompt fields are only safe while steps execute sequentially. That holds
today. `PARALLEL_STEPS_PLAN.md` would break it — for the inline config, for
`resolvedCurrentModel`, and for Antigravity's statusline state alike. That is a
cross-cutting concern for that plan to solve once for all providers, not a
reason to invent a bespoke channel here.

## What this deletes

From `OpenCodeCliProvider.ts`:

- the `configTracker` getter (`:84`) and every `SettingsJsonMcpTracker` call;
- file-writing in `getMcpConfigArgs` (`:312`) — it becomes pure object
  construction;
- the whole body of `prepareToolPermissions` (`:410`) — policy moves into the
  inline config, and with no shared file there is nothing to acquire;
- `cleanupWorkspaceArtifacts`'s tracker teardown (`:434`);
- `writePluginDirGitignore` (`:587`) and `deleteCtrlYokeGitignore` (`:609`);
- plugin/sidecar file writes in `deployCompletionPlugin` (`:538`), replaced by
  a `file://` spec plus a hooks env var;
- `getMcpConfigFilePath`'s null-return workaround (`:389`), whose entire reason
  for existing was "don't let generic cleanup delete the user's opencode.json".

From `SettingsJsonMcpTracker.ts`: `registerPermissionPolicy` /
`unregisterPermissionPolicy` (`:652`, `:671`) lose their only caller. The
generic `registerValueLease` / `unregisterValueLease` / `getValueLeaseBaseline`
machinery **stays** — `AntigravityCliProvider` uses it for its statusline lease
(`AntigravityCliProvider.ts:643`).

From `TOOL_PERMISSION_PARITY_PLAN.md`, the following stop being OpenCode work:
step-scoped lease release, PID+token owner identity, the dead-PID pruning
regression test, `withFileLock` atomic acquisition, the `PolicyLeaseResult`
conflict contract, the blocking conflict modal, CLI/MCP conflict exit codes,
and the workspace-mutation disclosure caveat. What remains of that section
applies only to Antigravity's statusline lease against a **user-global** file —
lower stakes than a security policy, and reasonably demotable from P0 to P1.

**What does _not_ go away:** the harness still caches config at process start,
because environment is fixed at spawn. So the parity plan's restart-on-change
invariant is unchanged and still security-critical:
`getInjectIncompatibilityReason` (`CliIntegration.ts:467`) must keep forcing a
restart when `toolPermissions` or `mcpServers` differ from `spawnedWith`, and
its missing-snapshot branch must still be changed to fail closed. Carry those
two items over verbatim.

## Stages

**Stage 1 — inline builder, no behavior change (complete).** Add
`buildInlineConfig(): OpenCodeInlineConfig` to `OpenCodeCliProvider`, composing
the existing mapper output and MCP entry construction into one object. Unit
tests only; nothing consumes it yet.

**Stage 2 — deliver via env, cut the file writes (complete).** Store the inline config
built in Stage 1 on the provider during `buildCliArgs` and return it from
`getHeadlessSpawnEnv()` / `getInteractiveSpawnEnv()`, following
`AntigravityCliProvider.ts:294-303`. Delete the tracker calls and drop
`opencode.json` from every code path. Update `OpenCodeCliProvider.test.ts` — `"creates,
gitignores, and cleans a workspace permission config"` (`:272`), `"coordinates
MCP and permissions while restoring an existing opencode.json"` (`:318`), and
`"does not overwrite a malformed existing opencode.json"` (`:402`) were
replaced by inline-config assertions. Coverage includes matching headless and
interactive env values, accumulator reset between steps, and a fixture
workspace directory check proving no `opencode.json` is created.

Stage 2 was also smoke-tested through a real `node-pty` spawn of
`opencode debug config`; the child exited successfully and resolved the
`permission` block from `OPENCODE_CONFIG_CONTENT`.

**Stage 3 — collision-safe key emission (complete).** Resolve the user's effective
permission key set from `~/.config/opencode/opencode.json`, the `OPENCODE_CONFIG`
file when that variable is set, and project `opencode.json`. For every key
ctrlyoke emits — the top-level catch-all, top-level tool names, and nested
patterns — append `*` until it is novel in that scope. Emit **before** relying
on last-match-wins. Two rules:

- never emit a scalar where the user has an object for the same tool, or the
  reverse, unless ctrlyoke intends to discard the user's rules for that tool —
  the merge replaces wholesale in that case;
- when a collision cannot be made novel, degrade to a diagnostic rather than
  emitting a rule whose position is wrong.

The implementation also rejects `{env:...}` and `{file:...}` substitutions in
ctrlyoke-emitted permission/MCP values, enforces a defensive 32 KiB serialized
config limit, and keeps OpenCode stderr out of history and telemetry because
parse failures echo the complete inline config (including MCP credentials).
Inline policy is authoritative over the lower-precedence global/project config
layers only; OpenCode organization/console and managed/MDM layers merge later
and may override it.

**Stage 4 — move the plugin out of the repo (complete 2026-07-31).** Reference
`out/scripts/ctrlyoke-opencode-plugin.ts` directly from the extension
installation by putting its **absolute path** in `plugin[]` and letting
`pathToFileURL` handle escaping (`config/plugin.ts:52`). Replace the
`.opencode/plugin/ctrlyoke-hooks.json` sidecar with an env var carrying the
same JSON (or a path under `.ctrlyoke/temp/`, which is already gitignored).
Delete `.opencode/` creation, its `.gitignore`, and
`getAdditionalCleanupFilePaths`'s artifact list.

Implemented: the inline `plugin[]` entry now carries the absolute extension
installation path, user hooks travel in `CTRLYOKE_OPENCODE_HOOKS`, and normal
OpenCode runs create no workspace plugin or config files. A warning-backed,
minimal `.opencode/plugin/` deployment remains only when the installed plugin
path cannot be loaded.

**Stage 5 — real-harness regression coverage.** This is the automated coverage
`TOOL_PERMISSION_PARITY_PLAN.md` still owes for OpenCode; it should now be
written against the inline path, not the file path.

## Testing

Unit:

- inline config shape for each permission mode (`none` and `dangerouslyAllowAll`
  emit no `permission` key at all);
- collision rewriting, including the top-level `*` → `**` case and a
  multi-round-trip case where `foo *` and `foo **` are both already taken;
- scalar/object type-mismatch guard;
- MCP entries render identically to today's file contents;
- the ~32 KB size guard;
- `{env:` / `{file:` detection in permission patterns and MCP values warns
  instead of emitting the token;
- headless and interactive spawns receive the same `OPENCODE_CONFIG_CONTENT`
  for one step;
- consecutive steps in one run each get their own config — the prompt-to-prompt
  case, since the integration is reused across prompts within a run;
- no `opencode.json` or inline-config file is created under the workspace root
  for an OpenCode run — assert on a fixture workspace's directory listing,
  which is the actual regression the user hit. (Stage 4 separately removes the
  remaining plugin deployment.)

Real-harness (`npm run test:harness`, on request only — it costs money):

- allow proceeds, deny blocks, and deny wins over allow, all through inline
  config with no `opencode.json` present;
- the same three with a pre-existing user `opencode.json` containing
  conflicting rules, proving collision rewriting holds;
- the ctrlyoke MCP server connects from inline config;
- the completion plugin fires from a `file://` spec outside the repo, in both
  headless and TUI modes.

## Risks

- **TUI env inheritance is likely but still unproven for ctrlyoke's spawn
  path.** The behavioral tests ran through `opencode run` and
  `opencode debug config`. Source lowers this risk substantially — the loader
  reads `process.env` directly at instance-load time (`config.ts:468`), and
  OpenCode's own SDK relies on inline config surviving into a spawned `serve`
  process (`sdk/js/src/v2/server.ts:38`). Still confirm once under a real
  `node-pty` spawn before Stage 2 ships, since that is the path ctrlyoke
  actually uses.
- **`{env:}`/`{file:}` substitution in user-authored patterns.** See the
  findings section: structural break-out is not possible, but expansion leaks
  secrets into the resolved config and silently rewrites patterns. Pre-existing
  on the file path; fix it as part of this work rather than porting it forward.
- **Path-spec plugin support is undocumented.** Verified in both 1.18.10 source
  and behavior, but absent from the docs, so it could regress without notice.
  Detect a failed plugin load and fall back to `.opencode/plugin/` deployment
  with a warning rather than silently losing completion detection.
- **Secrets in the environment.** MCP `environment` blocks carry API keys.
  Environment is at least as safe as the file this replaces (no disk
  persistence, and `/proc/PID/environ` is owner-readable only), but the
  OpenCode parse-error path echoes the full content to stderr — keep it out of
  output history and any telemetry.
- **Merge semantics are version-dependent.** Everything in "Verified findings"
  is measured against 1.18.10 and read from that same source tree. Key ordering
  and type-mismatch replacement are emergent properties of remeda `mergeDeep`,
  not a documented contract, so pin the version in the real-harness fixture and
  re-verify on upgrade.

## Non-goals

- Changing behavior for any harness other than OpenCode.
- Removing `registerValueLease` from `SettingsJsonMcpTracker` — Antigravity
  still needs it.
- Introducing a session-scoped spawn-env channel, or adding a per-invocation
  env argument to `executeStandaloneInteractiveProcess`
  (`CliExecutionRunner.ts:455`). Per-run integrations already make provider
  instance state safe, so there is no correctness driver — the asymmetry with
  the PTY and headless paths is cosmetic. Making per-prompt provider state safe
  under concurrent steps belongs to `PARALLEL_STEPS_PLAN.md`, solved once for
  all providers.
- Governing an OpenCode process the user launched outside ctrlyoke. That stays
  out of scope exactly as `TOOL_PERMISSION_PARITY_PLAN.md` decision 6 states —
  though the exposure shrinks, since ctrlyoke no longer leaves a config file
  behind for such a process to pick up.
