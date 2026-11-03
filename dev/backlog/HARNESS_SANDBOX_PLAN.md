# Harness Sandbox Property

**Status:** Ready to implement. Revised 2026-11-03 against current code and the installed CLIs
(codex 0.166.0, copilot 1.0.105, claude 2.1.317, agy 1.4.12, qwen 0.26.0, opencode 1.19.5).
Phase 1 can ship on its own. Phases 2–5 begin with the short probes in phase 0.
**Priority:** P2. Folds in
[`workspace-codex-sandbox-settings-widen-permissions-without-approval`](../bugs/backlog/workspace-codex-sandbox-settings-widen-permissions-without-approval.md)
(phase 1), and settles "Sandbox is a separate axis" from
`dev/implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md`.

## Principle: contain the agent, don't interrogate it

ctrlyoke's goal for unattended agents is **boundaries instead of approvals**. Let the agent
run whatever it needs, and make what a command can _reach_ the safety mechanism, not a stream
of approval prompts nobody is there to answer. Full containment has four parts:

1. **Containment** of files and processes: an OS sandbox, a container, and worktrees for
   repository state.
2. **Scoped credentials:** a deploy key or fine-grained token for the one repo, not the
   user's main identity.
3. **Network policy:** what the agent may reach.
4. **A short deny list** kept only for **irreversible actions outside the boundary**, such
   as `git push`, package publishes and cloud deletes. Containment can't undo those, so they
   still deserve a stop.

Approval prompts are the fallback for when no boundary exists. This plan covers part 1 on
the user's own machine. `DOCKER_SERVER_IMAGE_PLAN.md` covers the server version of the same
principle.

## Problem

ctrlyoke has one control, `toolPermissions.mode`, and it mixes two different things:

- **Approval:** which actions run without asking. `mode`, `allowedTools` and `deniedTools`
  describe this on every harness.
- **Containment:** what a command can touch when it runs (files, network, credentials).

Containment is derived from the approval mode, differently per harness, and the workflow
never shows it:

| Harness                         | How containment is chosen today                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                           | `CodexToolPermissionMapper`: `allowAll` → `--sandbox workspace-write`; `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox` (both controls off in one flag); `custom` → `permissions.codexSandboxMode`, clamped to `read-only` when a write-capable tool is denied. |
| Antigravity                     | Never sandboxed since 2026-10-31. The `custom` → `--sandbox` mapping was removed early (see "Antigravity" below), so only a user `additionalArgs` `--sandbox` applies.                                                                                                              |
| Copilot, Claude, Qwen, OpenCode | Never sandboxed by ctrlyoke. A sandbox the user enabled in the harness's own settings still applies.                                                                                                                                                                                |

So the same workflow runs sandboxed on one harness and unsandboxed on the next.

A second problem sits in the same code. A workspace's `.ctrlyoke/settings.json` can set
`permissions.codexSandboxMode: "danger-full-access"` and `codexApprovalPolicy: "never"`,
which removes the user's Codex sandbox without the approval prompt that a wider
`defaults.toolPermissions` gets. Phase 1 fixes that.

## Native sandbox support (checked 2026-11-03)

| Harness     | Per-run control                                                                                                                                                                                                                               | What it contains                                                                                                                                                                                                                                                                                                                                                                                                             | Unsupported host                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `-s read-only \| workspace-write \| danger-full-access` (both `codex` and `codex exec`). `-a on-request \| never` is interactive only; 0.149.0 removed `untrusted`.                                                                           | OS sandbox for model shell commands. `workspace-write` allows writes to the workspace and `--add-dir` roots only, with network off unless `config.toml` enables it. `git add` fails in both a plain checkout and a linked worktree because the index is under `.git`, outside the writable root. Phase 3 must add the git common dir, and a linked worktree's own gitdir, as writable roots (see Phase 0 results).           | Phase 0.                                                                                                                                                                                       |
| Copilot     | `--sandbox` / `--no-sandbox`. Both parse on 1.0.105 but neither is listed in `--help`; `copilot help sandbox` documents `--sandbox`. Policy lives only in the user's `~/.copilot/settings.json` `sandbox` key.                                | Shell commands, via Microsoft Execution Containers (Seatbelt on macOS, bubblewrap plus a private network namespace on Linux, ProcessContainer on Windows). Built-in file edits follow the policy only best-effort. **The default policy allows outbound network** and a per-command bypass (`allowBypass`). `sandboxMcpServers` decides whether local MCP servers run inside. git/`gh` authenticate through a masking proxy. | Prints a startup warning, then **every sandboxed shell command and sandboxed MCP server fails**: closed, not open. An org policy can force sandboxing on, and then refuses `/sandbox disable`. |
| Claude      | `--settings` JSON: `sandbox.enabled`, `sandbox.failIfUnavailable`, `sandbox.allowUnsandboxedCommands`, `sandbox.autoAllowBashIfSandboxed`, `sandbox.filesystem.allowWrite`, `sandbox.network.allowedDomains`, … (found in the 2.1.317 binary) | The Bash tool. **`autoAllowBashIfSandboxed` defaults to on**, which auto-approves sandboxed commands, and `allowUnsandboxedCommands` lets the model retry a command outside the sandbox (`dangerouslyDisableSandbox`). Both change approval as well as containment, so ctrlyoke must turn both off.                                                                                                                          | `failIfUnavailable: true` makes it refuse instead of running unsandboxed.                                                                                                                      |
| Antigravity | `--sandbox` ("Run in a sandbox with terminal restrictions enabled"), or `enableTerminalSandbox` in `--settings`                                                                                                                               | Terminal commands. Permission rules configure mounts and the network allowlist. On Windows, 1.4.12 ran even rule-allowed commands inside the sandbox, and they got `EPERM` writing the workspace ([permission rules plan](../implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md)).                                                                                                                                             | **Silently does nothing** (below Windows 11 24H2, some Linux containers).                                                                                                                      |
| Qwen        | `-s true \| false \| docker \| podman \| sandbox-exec`                                                                                                                                                                                        | Re-launches the **whole CLI**, MCP servers and hooks included, in Seatbelt (`permissive-open` on macOS, where network stays open) or in a Docker/Podman container (Linux/Windows). The newer per-tool `tools.executionSandbox` is Linux-only and can be set only in User or System settings: no flag, and workspace settings are rejected. It also **disables MCP servers and executable hooks**.                            | `true` needs Docker/Podman off macOS.                                                                                                                                                          |
| OpenCode    | None.                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                              |

### What this means for ctrlyoke

- **Network can't be the common denominator.** Codex closes it, while Copilot's default and
  Qwen's Seatbelt profile leave it open. So `sandbox: true` promises **write containment for
  terminal commands**. Network follows each harness's own sandbox policy, and the docs table
  says which.
- **Qwen is unsupported.** Its whole-CLI sandbox also wraps ctrlyoke's MCP server and hook
  scripts. Under Seatbelt they can't write run state under `~/.ctrlyoke/projects/...`. Under
  Docker the extension's `node` paths don't exist. `executionSandbox` turns MCP and hooks off
  outright. Revisit if Qwen ships a per-run, per-tool sandbox that leaves MCP and hooks
  running.
- **Codex has no other control in headless runs.** `codex exec` takes no `-a`, so its
  sandbox is the only enforcement there (see the `includeApprovalFlag` comment in
  `CodexToolPermissionMapper.buildCodexSpecificArgs`). That is why `allowAll` maps to
  `workspace-write`, and why inherit must keep doing so.

## Decisions

These were open questions in the 2026-10-30 draft; each is now decided.

1. **Values: `true`, `false` or absent.** Absent means inherit: `defaults.sandbox`, then
   each harness's derived behavior today. No `null`; there is no harness config to defer to
   beyond what absent already means. Every existing workflow keeps its exact command line
   until someone sets the property.
2. **`true` = contained.** Terminal commands may write only the workspace roots, approved
   external roots (`CliProviderUtils.getWorkspaceDirs`), temp dirs and the harness's own
   caches. Network follows the harness's policy. Harness file tools and MCP servers are not
   necessarily covered, and the schema description says so.
3. **`false` removes only ctrlyoke's containment.** It never turns off a sandbox the user
   enabled in the harness's own settings (Copilot `/sandbox enable`, Claude
   `sandbox.enabled`), so a workflow from a repository can't quietly undo the user's choice.
   In practice it changes only Codex, the one harness where ctrlyoke supplies containment
   today. There it means `-s danger-full-access`.
4. **An explicit `true` that can't be honored fails the step at launch.** That covers a
   harness declared `unsupported` (Qwen, OpenCode) and a host where the sandbox can't run.
   An explicit containment request that silently doesn't apply is the worst outcome. It also
   closes the gap where MCP `edit_step` switches a pending step's `harness`: the step fails
   instead of running uncontained. Inherit never fails.
5. **Default for new users: inherit.** `defaults.sandbox: true` breaks any workflow that
   needs the network on Codex (npm install, API calls) until an allowlist exists. Revisit
   with the object form.
6. **Inherit keeps its meaning for now.** Making absent mean "not sandboxed" everywhere, so
   `allowAll` stops implying `workspace-write` on Codex, would be a **Changed** entry for
   released workflows. Decide after the property has shipped for one release. The dashboard
   could first flag workflows that rely on the derived sandbox.
7. **Workspace widening needs approval (phase 1 and phase 2).** A workspace settings value
   for `permissions.codexSandboxMode`, `permissions.codexApprovalPolicy` or
   `defaults.sandbox` that is wider than the user's effective value is held until the user
   approves it, the same way `defaults.toolPermissions` already works (bug option 1). Making
   the settings user-only (option 2) was rejected: it breaks repositories that legitimately
   _narrow_ Codex, for example to `read-only`, and it doesn't match how the rest of the
   permissions surface works.

## Phase 0: probes (half a day, short real runs)

Run each from a fresh scratch directory with a throwaway workspace, using the node-pty
recipe in `.github/copilot-instructions.md` for interactive captures. Record the results in
the matching harness doc, then update the table above and the capability declarations in
phase 3.

- **Claude:** pass `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false}}'`
  in `-p` mode under each ctrlyoke permission mode, then:
  1. Write outside the workspace.
  2. Fetch a URL with and without `network.allowedDomains`.
  3. Run `git commit`.
  4. Check whether a second `--settings` is merged or replaces the first (decides the merge
     approach in phase 3).
  5. Check whether stdio MCP servers and hook commands run inside the sandbox.
- **Copilot:** run `-p --allow-all-tools --sandbox` with no saved `sandbox` key, then:
  1. Find the effective default policy (does `--sandbox` seed the documented default).
  2. Find what a blocked command returns.
  3. Check whether a per-command bypass is auto-approved under `--allow-all-tools`. If it
     is, Copilot's declaration is `partial` with a caveat, because ctrlyoke can't set
     `allowBypass` without writing the user's config.
  4. Check whether `--add-dir` roots become writable.
  5. Find the default for `sandboxMcpServers`, and whether ctrlyoke's MCP server and hook
     scripts still work.
  6. Run `git commit`.
- **Antigravity:** on macOS, check whether a command under `--sandbox` can write the
  workspace. If it can't, as on Windows, declare `sandbox` `unsupported` for agy and drop its
  mapping. Find whether stream-json `init` or any other output reports that the sandbox is
  active. That decides whether "silently no effect" can be detected or needs the host
  pre-check below.
- **Codex:** run `codex exec -s workspace-write` on Linux without Landlock or bubblewrap, and
  on Windows, to see what it does on an unsupported host. Run `git commit` in a plain checkout
  and in a ctrlyoke managed linked worktree. The worktree's git common dir is outside the
  workspace (`ExecutionRootScope.gitCommonDir`), and Codex also protects `.git` under writable
  roots. Check whether this already breaks committing steps under `allowAll` today. If it
  does, file a bug and have phase 3 add the common dir as a writable root.

If phase 0 finds agy or Copilot not worth declaring, set them to `unsupported` in phase 3.
The design doesn't change.

### Phase 0 results (2026-11-03, macOS)

First pass: thin, because Copilot and Antigravity were out of quota. Re-run the same
day with working quota, using `src/test/harness/sandbox.harness.test.ts` and direct
probes. Throwaway "outside" targets were hidden directories under the home directory:
**macOS temp paths are writable inside the Codex, Claude and Copilot sandboxes**, so a
sibling of a temp workspace proves nothing.

- **Codex 0.166.0 (verified).** `-s workspace-write` blocks a write to a non-temp
  outside path and closes the network. `git add`/`git commit` fail in a plain checkout
  (`.git/index.lock`) and in a linked worktree. Adding the common dir as `--add-dir`
  fixes the **plain checkout** (the root _is_ the protected `.git`), but **not a linked
  worktree**: Codex protects the gitdir the worktree's `.git` pointer file names
  (`<common>/worktrees/<name>`) even inside an added root. Granting that directory as a
  root too fixes it. `CodexCliProvider` now adds both (`gitWritableAdminDirs`), with a
  unit test using a real plain checkout and linked worktree. The `global_status`-style
  MCP call and a Stop hook both work under `sandbox: true`. Linux without
  Landlock/bubblewrap and Windows remain unprobed (macOS host).
- **Claude 2.1.317 (verified; stays `partial`).** With the exact settings ctrlyoke
  generates: a write to a non-temp outside path is blocked, `git commit` works in a
  plain checkout and a linked worktree (only the worktree itself writable), ctrlyoke's
  MCP server answers and a Stop hook fires. **Repeated `--settings` flags replace each
  other (the last one wins):** sandbox first and env second ran unsandboxed, and the
  reverse lost the env, so ctrlyoke must (and does) emit one merged file; a user
  `additionalArgs` `--settings` would override it. `network.allowedDomains: []` is not
  deny-all (phase 0 first pass: `curl` still returned 200). Network and file-tool scope
  are still not established, hence `partial`.
- **Copilot 1.0.105 (not usable; declared `unsupported`).** `--sandbox` does contain
  shell commands (a non-temp outside write fails with `EPERM`, after the agent really
  ran it), but it also runs ctrlyoke's own helpers inside the sandbox: the ctrlyoke MCP
  server could not start (`Cannot read package config` for the ctrlyoke checkout, and
  after widening reads with `--add-dir` it still closed during discovery), so
  `workflow_status` was unavailable, and hook commands failed with `EPERM` reading
  their script. Policy, including `sandboxMcpServers`, is settable only in
  `~/.copilot/settings.json`, so ctrlyoke can't change it per run. Revisit if Copilot
  gains a per-run policy flag. Bypass auto-approval was not probed.
- **Antigravity 1.4.12 (not usable; declared `unsupported`).** Nothing is missing:
  `/usr/bin/sandbox-exec` is present and the log says "Print mode: enabling terminal
  sandbox for this session" (that line is the only sandbox-active signal; stream-json
  carries none). But on macOS, as on Windows, the policy makes the **workspace**
  read-only (`echo > inside.txt` and `git commit` fail with `Operation not permitted`,
  even with the workspace under the home directory) while paths outside it stay
  writable (`/Users/Shared`, `$HOME`, sibling dirs), and it denies reading
  `~/.gemini/config`. `--settings` rejects `cnsSandboxMounts`, `sandboxAllowNetwork`
  and the other `sandbox*` keys, and a `write(<workspace>/**)` allow rule does not
  change it, so there is no supported way to make the workspace writable.
- **Qwen and OpenCode:** an explicit `sandbox: true` fails the step at launch, checked
  by `src/test/harness/sandbox.harness.test.ts` (no model call).
- **Phase 0 status:** complete on macOS. Not probed: Linux/Windows hosts, Copilot
  per-command bypass, Claude network policy.

## Phase 1: workspace Codex settings gate (fixes the bug) — **Done.**

This phase is independent of the `sandbox` property and ships first.

- `src/config/WorkspaceSensitiveSettings.ts`: add two `VALUE` descriptors to
  `SENSITIVE_WORKSPACE_SETTINGS` with `isSensitive: isPresent` and an `isCoveredByUser`
  ranking:
  - `permissions.codexSandboxMode`: `read-only` < `workspace-write` < `danger-full-access`.
  - `permissions.codexApprovalPolicy`: `untrusted` = `on-request` < `never`. Treat
    `untrusted` as `on-request`, since that is what Codex ≥ 0.149.0 runs.

  Compare against the user's **effective** value: the user value, or
  `CTRLYOKE_SETTINGS_DEFAULTS.permissions` when unset (`workspace-write` / `on-request`). Put
  the order arrays and a shared `isRankNoWiderThan(order, workspace, user)` helper next to the
  `CODEX_SANDBOX_MODES` / `CODEX_APPROVAL_POLICIES` constants in `DashboardConstants.ts`, so
  phase 3 reuses them.

- Add `SETTING_PATHS.PERMISSIONS_CODEX_SANDBOX_MODE` and
  `PERMISSIONS_CODEX_APPROVAL_POLICY` (neither exists yet).
- `summarize`: `"Codex sandbox: danger-full-access"` / `"Codex approval policy: never"`.
- The prompt and `ctrlyoke trust-workspace-settings` then list them with no other change.
  `ConfigurationUtils.getCodexSandboxMode()` / `getCodexApprovalPolicy()` already read the
  filtered merge.
- Tests in `src/test/unit/WorkspaceSensitiveSettings.test.ts`:
  - narrower and equal values auto-apply;
  - a wider value is withheld until approved, and then applies;
  - an unset user value compares against the shipped default;
  - `untrusted` vs `on-request` counts as equal.
- Schema descriptions for both keys get the same workspace-approval sentence that
  `defaults.toolPermissions` has; then run `npm run schema:update`.
- Docs: `docs/harnesses/codex-cli.md` and `docs/workflows/permissions.md`.
- `CHANGELOG.md` **Changed**: "A workspace `permissions.codexSandboxMode` or
  `codexApprovalPolicy` that is less restrictive than your own now waits for your approval
  before it applies."
- `git mv` the bug to `dev/bugs/implemented/` and set its Resolution line.

Implemented as specified; the approval-policy order treats `untrusted` as equal to `on-request` for Codex 0.149.0 and newer.

## Phase 2: schema and resolution

- [x] `schemas/workflow-schema.json`: add a boolean `sandbox` to the shared execution
      properties, at workflow and step level beside `toolPermissions`, with no default.
      `schemas/settings-schema.json`: add `defaults.sandbox`, which `$ref`s the same definition.
      Additive and optional, so no `schema:bump`; run `npm run schema:update`. The description
      states that `true` contains terminal commands' writes, that network, harness file tools and
      MCP servers follow each harness's policy, that `false` never disables a sandbox enabled in
      the harness's own settings, and which harnesses fail an explicit `true`.
- [x] Types: `sandbox?: boolean` on `ExecutionProperties` (`CtrlYokeTypes.ts`) and
      `"sandbox"` in `EXECUTION_PROPERTY_KEYS`. In `ResolvedProperties`, `sandbox?: boolean`
      (undefined = inherit). `CtrlYokeSettings.defaults.sandbox?: boolean`, with no shipped
      default.
- [x] Resolution: `resolveExecutionProperties` (`src/types/ExecutionPropertyResolver.ts`)
      resolves prompt → workflow → `defaults.sandbox` with a source, like `errorBehavior`.
      `PropertyResolver.createDefaults` reads `ConfigurationUtils.getDefaultSandbox()`.
- [x] **Spawn identity:** add `SANDBOX` to `SPAWN_IDENTITY_FIELDS`
      (`src/types/ExecutionSpawnIdentity.ts`), so a reused process is never carried into a step
      with different containment.
- [x] **Workspace gate:** add a `defaults.sandbox` descriptor to `SENSITIVE_WORKSPACE_SETTINGS`.
      `true` is always covered. `false` is covered only when the user's own value is `false`,
      because on Codex it is wider than both inherit and `true`.
- [x] **MCP:** leave `sandbox` out of `MCP_STEP_UPDATE_SCHEMA` (`src/utils/McpToolDefinitions.ts`),
      so an agent can't relax a later step. Add a test that `edit_step` rejects it.
- [x] Carry the property through the listed property plumbing: `WorkflowStepSanitizer`,
      `PromptFileLoader`, `WorkingFileManager`, `RunDefinitionChanges`, `RunDefinitionAnchor`,
      `CliPropertyOverrides`, `coreWorkflowAdapter`, `promptPropertyValues`, `stepOverrideChips`,
      `stepMetadataClipboard`, `replyToStep` and `workflowFileCompletionExtension`. The CLI
      `--sandbox` / `--no-sandbox` override is additive.
- [x] Tests: resolver precedence and source, the sanitizer and loader round trip, spawn
      identity, the workspace gate, and MCP rejection.

## Phase 3: mappers and diagnostics

### Code shape

- New `src/core/harness/shared/interfaces/ISandboxMapper.ts`. Keep it separate from
  `IToolPermissionMapper` so the two axes stay separate in code:

  ```ts
  interface SandboxApplication {
    cliArgs: string[];
    /** Merged into the harness's single settings payload (Claude). */
    settings?: Record<string, unknown>;
    diagnostics: CompatibilityDiagnostic[];
    /** For Dry Run and logs: "on" | "off" | "harness" plus a detail like "Codex workspace-write, network off". */
    effective: EffectiveSandbox;
  }
  interface ISandboxMapper {
    readonly capabilities: SandboxCapabilityDescriptor;
    prepare(
      request: boolean | undefined,
      context: SandboxContext
    ): Promise<SandboxApplication>;
  }
  ```

  `SandboxContext` carries the resolved `ToolPermissionConfig | null`, `isInteractive`, the
  writable roots, the Codex settings, `cliVersion` and `additionalArgs`.

- `ICliProvider` gains an optional `sandboxMapper`. `ExecutionPlanBuilder` calls it **before**
  hook preparation, so Claude's fragment can be merged. It appends `cliArgs` beside the
  permission args. If any diagnostic is an error, it fails the launch with that diagnostic.
  A provider without a mapper is treated as `unsupported`.
- Capabilities: add a `sandbox: { terminal: CapabilityDeclaration }` domain to
  `CapabilityDomainDescriptorMap` and `CAPABILITY_DOMAINS` (`src/types/CompatibilityTypes.ts`,
  `DashboardConstants.ts`). Add a `SANDBOX_CAVEAT_CODES` set (network follows the harness
  policy; file tools are best-effort; MCP servers are not contained) and a
  [x] `CompatibilityAnalyzer` check modeled on `mcp.perServerToolFiltering`. An explicit `true`
  on an `unsupported` harness is an **error**; on a `partial` one it is information carrying
  the caveat. This is an additive domain in the registry snapshot.

### [x] Codex: one resolver for both axes

Replace `CodexToolPermissionMapper.resolveSandboxMode` with
`resolveCodexContainment(config | null, sandbox, codexSandboxMode)`, which returns
`{ sandboxMode?: CodexSandboxMode; bypass: boolean }`. `CodexSandboxMapper` emits `-s`,
`CodexToolPermissionMapper` emits `-a` or the bypass flag, and the `--add-dir` filter in
`CodexCliProvider` reads the same result. `permissions.codexSandboxMode` becomes **how
strict Codex's sandbox is when containment is on**:

| `sandbox` | mode                  | Result (interactive adds `-a`)                                                                                                                                                         |
| --------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent    | any                   | **Today's args exactly**, including the bypass flag for `dangerouslyAllowAll`. Snapshot-tested for every mode × interactive/headless.                                                  |
| `true`    | `allowAll`            | `-s workspace-write -a on-request`, or `-s read-only` when `codexSandboxMode` is `read-only`.                                                                                          |
| `true`    | `dangerouslyAllowAll` | `-s workspace-write -a never` (headless: `-s workspace-write`). **No bypass flag.** `read-only` setting applies as above.                                                              |
| `true`    | `custom`              | `-s <codexSandboxMode, clamped to workspace-write if it is danger-full-access> -a <policy>`. `read-only` clamp kept when a write-capable tool is denied.                               |
| `true`    | `none` / `null`       | `-s workspace-write`, or `read-only` per the setting. No `-a`: approvals are the harness's own.                                                                                        |
| `false`   | `allowAll`            | `-s danger-full-access -a on-request`                                                                                                                                                  |
| `false`   | `dangerouslyAllowAll` | `--dangerously-bypass-approvals-and-sandbox` (same as today)                                                                                                                           |
| `false`   | `custom`              | `-s danger-full-access -a <policy>`. When a write-capable tool is denied, the `read-only` clamp still wins, with an info diagnostic: it is the only way Codex can enforce that denial. |
| `false`   | `none` / `null`       | `-s danger-full-access`                                                                                                                                                                |

### The other harnesses

| Harness     | `true`                                                                                                                                                                                                                                                                                                                                                                                                                        | `false` | absent  | Declared                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | `settings.sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { allowWrite: <writable roots> } }`, merged into the one `--settings` file written by `planNotificationHookArgs` / `planHeadlessUserHookArgs` (`ClaudeCliProvider.ts`). **Verified: repeated `--settings` flags replace each other (last wins), so one merged file is required.** | nothing | nothing | `partial` (verified 2.1.317: outside write blocked, `git commit`, MCP and hooks work; network policy and file-tool scope not established) |
| Copilot     | fails (error diagnostic). **Verified unusable on 1.0.105:** `--sandbox` contains shell commands but also sandboxes ctrlyoke's own MCP server and hook scripts, which then cannot start or run; the policy (`sandboxMcpServers`) is settable only in `~/.copilot/settings.json`.                                                                                                                                               | nothing | nothing | `unsupported` (revisit if Copilot gets a per-run policy flag)                                                                             |
| Antigravity | fails (error diagnostic). **Verified unusable on 1.4.12 (macOS and Windows):** the sandbox is active but makes the workspace read-only while outside paths stay writable; no supported setting changes the mounts.                                                                                                                                                                                                            | nothing | nothing | `unsupported`                                                                                                                             |
| Qwen        | fails (error diagnostic)                                                                                                                                                                                                                                                                                                                                                                                                      | nothing | nothing | `unsupported`                                                                                                                             |
| OpenCode    | fails (error diagnostic)                                                                                                                                                                                                                                                                                                                                                                                                      | nothing | nothing | `unsupported`                                                                                                                             |

On Claude, `autoAllowBashIfSandboxed: false` and `allowUnsandboxedCommands: false` keep
approvals governed by `toolPermissions` alone. Without them, turning containment on would
silently widen approvals, and the model could step outside the sandbox.

### Antigravity history

The old `custom` → `--sandbox` mapping was removed on 2026-10-31, ahead of this plan
(Nathan's call). Under it, agy 1.4.12 on Windows ran even rule-allowed commands inside the
sandbox, where they couldn't write the workspace, so `custom` was unusable for any command
that writes. Inherit therefore means no flag on Antigravity, and there is no legacy mapping
to keep.

### Tests

- Per harness, in `src/test/unit/`: the args or settings for `true`, `false` and absent
  under each permission mode. Absent equals the current snapshot.
- Claude: the merge yields exactly one `--settings`.
- The Codex table above, row by row, in both the interactive and headless shapes.
- `--add-dir` follows the resolved mode.
- `ExecutionPlanBuilder` fails the launch on an error diagnostic.
- `CompatibilityAnalyzer` reports an error for an explicit `true` on Qwen and OpenCode.

## Phase 4: harness tests (opt-in, `npm run test:harness` only) — **Done.**

For each harness declared other than `unsupported`, `src/test/harness/` checks four things:

- `sandbox: true` blocks a write outside the workspace.
- `sandbox: false` allows that write.
- ctrlyoke's MCP server (`global_status`) and completion hooks still work under `true`.
- A Codex `dangerouslyAllowAll` + `true` run gets no bypass.

The network checks are per harness, matching the documented policy.

`src/test/harness/sandbox.harness.test.ts` covers Codex and Claude (the two
declared implementations) with a non-temp outside-path write check, `global_status`
and a completion hook under containment. Codex also has a closed-network check and a
`dangerouslyAllowAll` case that checks the generated launch arguments and the
outside-write behavior. Qwen, OpenCode, Copilot and Antigravity get a launch-failure
check for an explicit `true`. The file runs against live harnesses as part of
`npm run test:harness`.

## Phase 5: UI, docs, changelog — **Done**

- [x] **Properties panel** (`WorkflowPropertiesPanel.tsx`, `PropertiesDrawer.tsx`): a
      **Sandbox** row beside Tool Permissions with Inherit / On / Off, and per-harness support
      shown the way permission fidelity is shown (`useCompatibilityDiagnostics`). Add a step
      override chip.
- [x] **Settings:** `defaults.sandbox` on `DefaultsPermissionsPage.tsx`, with
      `settingsCatalog.ts` entries. Move the `codexSandboxMode` / `codexApprovalPolicy` rows from
      `AdvancedPermissionsSection.tsx` under it as the Codex detail, and say that they set how
      strict Codex is when contained.
- [x] **Dry Run** (`ExecutionPreviewService`, `DryRunModal.tsx`, `executionPreview.ts`): show
      each step's `SandboxApplication.effective`, e.g. "Sandboxed: Codex workspace-write, network
      off" / "Not sandboxed" / "Harness setting". Log the same line at launch. A persisted
      per-run record, in the run header, waits until there is demand; it would be a `_runtime`
      field.
- [x] **Docs:**
  - [x] `docs/workflows/permissions.md`: a new "Sandboxing" section on the two axes, the
        per-harness network table, and the fail-closed rule.
  - [x] Each `docs/harnesses/<harness>.md`: its mapping. Rewrite the Codex mode bullets in
        `codex-cli.md` (lines 81–87) around the table above.
  - [x] `antigravity-cli.md`: the `additionalArgs` advice changes to "use `sandbox: true`".
  - [x] `npm run schema:update`, then regenerate the compatibility docs.
- [x] **`CHANGELOG.md`:** **Added** for the `sandbox` property, `defaults.sandbox` and the CLI
      override. Inherit leaves every existing workflow's command line unchanged, so the only
      **Changed** entry is phase 1's.

## Later

- **Object form:** `sandbox: { network: [...], writable: [...] }`, once there is a
  cross-harness way to express a network allowlist. Claude's `network.allowedDomains` and
  Copilot's `userPolicy.network` are the candidates. Folding `codexSandboxMode` into it would
  be the schema bump, with a `FormatMigrations.ts` migration.
- **Credentials and network** (parts 2 and 3 of the principle) are out of scope. Copilot's
  credential-masking proxy is the most complete native model so far; watch for the others to
  converge before designing a cross-harness version.
- **Qwen,** if it gains a per-run, per-tool sandbox that keeps MCP and hooks.

## Possible follow-up: a ctrlyoke-owned container backend

Out of scope for this plan. Recorded so the main feature doesn't close off the option.

Worktrees went this way: ctrlyoke built its own feature instead of unifying the harnesses'
`--worktree` flags (`dev/implemented/WORKTREE_SUPPORT_PLAN.md`). Containment could follow
the same pattern, but only at the **container** level. An OS-level sandbox ctrlyoke builds
itself (Seatbelt, bubblewrap) was considered and rejected:

- It has to wrap the whole harness process, not just the commands the agent runs. That
  process needs its model API, its own state dirs (`~/.claude`, `~/.codex`), its
  credentials and Keychain, and ctrlyoke's run state. Every hole opened for the harness is
  open to the agent too, including writes that plant hooks or widen settings for a later
  unsandboxed run. That is the same flaw that makes Qwen's whole-CLI sandbox unusable here.
- Closing the network would need an allowlisting proxy, because the harness itself must
  reach its API.
- The OS tools are uneven: `sandbox-exec` is deprecated, bubblewrap is often blocked by
  AppArmor on recent Ubuntu, and Windows has no primitive usable without native code
  (Microsoft's MXC, which Copilot uses, might be worth a look).
- ctrlyoke would own a security boundary, so every bug in it would be a ctrlyoke
  vulnerability.

A container backend avoids most of that. The step runs inside the
[`DOCKER_SERVER_IMAGE_PLAN.md`](DOCKER_SERVER_IMAGE_PLAN.md) image, with only the execution
root (usually a ctrlyoke managed worktree) mounted. It:

- works the same for all six harnesses, including Qwen and OpenCode;
- runs on Windows through WSL2;
- gives scoped credentials (part 2 of the principle) for free, since the harness logs in
  separately on the container's home volume.

The costs: Docker is required, every step starts slower, and the user logs in to each
harness inside the container.

Shape, if it is built:

- The object form gains `sandbox: { backend: "harness" | "container" }`. `true` stays
  shorthand for `backend: "harness"`.
- `ISandboxMapper` already describes the outcome, not a flag. A container backend becomes a
  second mapper that changes how the process is spawned, not a seventh harness.
- Prerequisite: the server image ships first and is reused (entrypoint harness install,
  login volume, `node-pty` on slim).
- Open questions:
  - how hosted-dashboard PTY streaming and hooks cross the container boundary;
  - the mount path, given the git common dir of a linked worktree;
  - per-step startup cost and whether to keep a container warm across steps.
