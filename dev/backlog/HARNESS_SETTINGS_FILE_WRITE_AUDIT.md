# Harness Settings and Hook File Write Audit

> **Status:** Current-implementation audit
>
> **Snapshot:** 2026-07-31
>
> **Related plans:** [`TOOL_PERMISSION_PARITY_PLAN.md`](TOOL_PERMISSION_PARITY_PLAN.md), [`CODEX_INLINE_HOOKS_PLAN.md`](CODEX_INLINE_HOOKS_PLAN.md), [`OPENCODE_INLINE_CONFIG_PLAN.md`](OPENCODE_INLINE_CONFIG_PLAN.md), [`QWEN_INLINE_MCP_AND_HOOKS_PLAN.md`](QWEN_INLINE_MCP_AND_HOOKS_PLAN.md)

This document records the settings, hook, MCP, and closely related configuration
files that the six supported harnesses currently write. It is an inventory of
the code as it exists today, not a proposal to make all hook files mutually
exclusive.

The important distinction is:

- **Hook duplication is usually acceptable.** If two active workflows produce
  separate hook groups or files, both can receive the event. A duplicate hook
  command is generally less harmful than silently dropping a completion
  notification.
- **MCP and permission pollution is more serious.** A workspace-discovered MCP
  server or permission policy can be visible to another harness process or a
  manually launched process. These are the cases that need ownership, scoping,
  or a lease decision.
- **“Unique” below means unique for two runs with different workflow keys.**
  The current naming schemes generally do not include a run ID, so two runs of
  the same workflow can still target the same path or logical owner.

## Executive summary

| Harness     | Current shared configuration writes                                                                                                    | Two concurrent runs with different workflow keys                                                                     | Lease / conflict priority                                                                  | Future direction                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Qwen        | Workspace `.qwen/settings.json` hooks; global `~/.qwen/trusted_hooks.json`                                                             | Hook groups are retained in the shared file; MCP is passed per invocation through `--mcp-config`                     | MCP shared-file pollution resolved; hook mutations use the hooks tracker mutex; global trust updates use an in-process mutex, cross-process file lock, and atomic replacement | MCP inline migration and Stage 2 trust-write hardening complete; retain hooks pending the Stage 3 extension-backed hook spike |
| Copilot     | Per-prompt `.github/hooks/*.json`; per-execution MCP temp file                                                                         | Hook files are separately auto-discovered and normally coexist                                                       | Medium: path naming and cleanup need run identity; no shared permission file               | Keep files unless a later Copilot inline mechanism is verified                                                  |
| Antigravity | Workspace `.agents/mcp_config.json`; global `~/.gemini/config/hooks.json`; global `~/.gemini/antigravity-cli/settings.json` statusline | Hook groups are retained; MCP entries are merged but visible to every agy process; identical statusline leases share | High for MCP and statusline; medium for hooks                                              | Keep hooks/statusline files; decide whether MCP needs a lease or an inline alternative                          |
| Codex       | None for hooks; Codex MCP configuration is already inline                                                                            | Hook and trust overrides are process-local CLI arguments; user project files are untouched                         | Resolved for hooks; MCP remains inline                                                     | Keep the inline hook path and complete the remaining length-guard/diagnostic stages                            |
| OpenCode    | No normal workspace files; MCP, permissions, and plugin registration are delivered through `OPENCODE_CONFIG_CONTENT`; user hooks use `CTRLYOKE_OPENCODE_HOOKS` | Process-local inline config and hook environment; warning-backed workspace fallback only if the external plugin cannot load | Normal path is isolated; fallback is intentionally visible and cleaned by its provider | Stage 4 complete; path-spec plugin is external and hook sidecar is gone |
| Claude      | Per-prompt `.ctrlyoke/temp` hook and MCP files passed explicitly to Claude                                                             | Separate files normally coexist; same-key/default naming can collide                                                 | Low for discovery/pollution; medium for path ownership                                     | No current inline migration required                                                                            |

## Current write inventory by harness

### Qwen Code

Source: [`QwenCliProvider.ts`](../../src/core/harness/qwen/QwenCliProvider.ts), [`SettingsJsonMcpTracker.ts`](../../src/core/harness/shared/SettingsJsonMcpTracker.ts), and [`SettingsJsonHooksTracker.ts`](../../src/core/harness/shared/SettingsJsonHooksTracker.ts).

| File                                   | What ctrlyoke writes                                                                   | Visibility and cleanup                                                                                                                                                                                      | Parallel behavior                                                                                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{workspace}/.qwen/settings.json`      | Hook groups under `hooks`; no ctrlyoke MCP entries                                     | Qwen auto-discovers the hooks. `SettingsJsonHooksTracker` restores the hook baseline on final unregister and may create a temporary sibling `.gitignore`; MCP configuration is passed inline per invocation | Hook layers are keyed by `workflowKey` and use `SettingsJsonHooksTracker.withLock()`. Different keys are merged. Re-registering the same key replaces that key’s tracked layer, so same-key concurrent runs are not independent; inline MCP values are process-local. |
| `~/.qwen/trusted_hooks.json`           | Adds `:<command>` entries under the workspace path for ctrlyoke and user hook commands | Global and intentionally persistent because Qwen treats this file as an approval store; unregister releases tracker ownership but never removes trust entries | `QwenTrustedHooksTracker` preserves unknown workspace entries and existing keys, reference-counts only ctrlyoke-owned keys by workflow key, serializes in-host updates, and uses `withFileLock()` plus atomic replacement for cross-process safety. |
| `{workspace}/.qwen/.gitignore`         | Temporary ignore file when the settings file is newly created                          | Removed by the hooks tracker when its owned state is gone, unless a user-owned file already existed                                                                                                         | Shared directory artifact; cleanup checks tracker state, not a distributed cross-process lease.                                                                                                                                                                         |
| `{workspace}/.qwen/settings.json.orig` | Created by Qwen itself when it reads settings; ctrlyoke leaves it untouched          | Not a ctrlyoke settings write; cleanup leaves this user-owned Qwen backup in place                                                                                                                          | Its lifecycle is owned by Qwen, so it should not be treated as a ctrlyoke ownership record.                                                                                                                                                                             |

#### Qwen hooks

The hooks tracker stores one `ctrlyoke` layer and one user-hook layer per
workflow key, then writes all layers into the same `hooks` event arrays. Two
different keys therefore receive separate entries, and duplicate commands are
allowed. This is the desired hook behavior in principle.

There is no run-specific identity in the layer key. Two concurrent runs that
resolve to the same `workingFilePath` overwrite the same map entry; the later
registration can also be the one removed during cleanup. The global trust file
is updated by `QwenTrustedHooksTracker`, which covers both the extension-host
mutex and a per-file cross-process lock. Trust remains intentionally persistent
after unregister because removing it would revoke Qwen approval.

#### Qwen MCP

Qwen now receives each prompt’s selected MCP servers through its native
two-token `--mcp-config <inline-json>` argument. The serialized object uses the
same Qwen-shaped entries as the former settings-file export, including server
environment values, but no longer creates or mutates `.qwen/settings.json`, its
sibling `.gitignore`, or `settings.json.orig`. Each provider invocation owns an
independent MCP object, so the former shared-file union and
`--allowed-mcp-server-names` workaround are no longer needed. Qwen’s user-owned
settings and `.mcp.json` continue to follow Qwen’s normal precedence rules.

### Copilot CLI

Source: [`CopilotCliProvider.ts`](../../src/core/harness/copilot/CopilotCliProvider.ts) and [`CopilotNotificationMonitor.ts`](../../src/core/harness/copilot/CopilotNotificationMonitor.ts).

| File                                                             | What ctrlyoke writes                                                                 | Visibility and cleanup                                                                                                                                                           | Parallel behavior                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{workspace}/.github/hooks/ctrlyoke-<stem>-p<index>.json`        | One hook JSON file per prompt; interactive notification hooks or headless user hooks | Copilot auto-discovers every JSON file in `.github/hooks`; the provider deletes files it recorded and removes its temporary `.gitignore` only when no ctrlyoke hook files remain | Different workflow stems normally create different files and Copilot can load both. Same workflow stem plus prompt index produces the same filename, so two concurrent runs can overwrite or delete one another’s hook file. The files are separate, not merged. |
| `{workspace}/.github/hooks/.gitignore`                           | Temporary ignore file for `ctrlyoke-*.json` and itself                               | User-owned `.gitignore` is preserved; ctrlyoke-owned one is removed after the directory has no managed hook files                                                                | The existence check and “any managed files remain” check reduce ordinary cleanup races, but there is no cross-process ownership record.                                                                                                                          |
| `{workspace}/.ctrlyoke/temp/mcp-config-<stem>.json`              | Per-execution MCP configuration passed with `--additional-mcp-config @<file>`        | Explicitly passed to Copilot and deleted through generic artifact cleanup                                                                                                        | Different stems normally produce distinct files. The fallback `default` suffix or two runs using the same working-file stem can collide. This file is not auto-discovered by other Copilot processes.                                                            |
| `{workspace}/.ctrlyoke/temp/ctrlyoke-otel-<stem>-p<index>.jsonl` | Per-prompt OpenTelemetry export file used for context usage                          | Deleted as an additional cleanup artifact                                                                                                                                        | Same naming caveat as hook files; it is telemetry rather than harness settings, but it is still a local write that can collide for the same key.                                                                                                                 |

Copilot therefore does not currently require a merge lease for ordinary
different-workflow hook files. It does need a run-unique filename or equivalent
ownership guard before the “per-prompt files are independent” claim is safe for
same-workflow concurrent runs.

### Antigravity CLI

Source: [`AntigravityCliProvider.ts`](../../src/core/harness/antigravity/AntigravityCliProvider.ts), [`SettingsJsonMcpTracker.ts`](../../src/core/harness/shared/SettingsJsonMcpTracker.ts), and [`AntigravityStatuslineSidecar.ts`](../../src/core/harness/antigravity/AntigravityStatuslineSidecar.ts).

| File                                                    | What ctrlyoke writes                                                                          | Visibility and cleanup                                                                                                                                       | Parallel behavior                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{workspace}/.agents/mcp_config.json`                   | MCP entries under `mcpServers` using agy’s `serverUrl` schema                                 | Auto-discovered by agy; `SettingsJsonMcpTracker` ref-counts entries and restores/removes managed state                                                       | Different server names are merged, but agy has no `--allowed-mcp-server-names` equivalent. Every agy process in the workspace can see the union, so concurrent workflows can pollute one another. Same workflow keys are not independent in the tracker.                                                  |
| `~/.gemini/config/hooks.json`                           | One `ctrlyoke-<sha1(workflowKey)>` group containing the current workflow’s hook specification | Global agy hook file; cleanup removes only the hashed group for that workflow key                                                                            | Different workflow keys get distinct groups and are preserved. The full read-modify-write is protected by `withFileLock`, but the same workflow key hashes to the same group and overwrites it. The name is workflow-unique, not run-unique.                                                              |
| `~/.gemini/antigravity-cli/settings.json`               | The global `statusLine` value, normally a ctrlyoke wrapper command                            | Managed through `SettingsJsonMcpTracker.registerValueLease`; final release restores the baseline. A `.ctrlyoke-lease-statusLine.json` sidecar records owners | Identical wrapper values can share a lease. Conflicting values are rejected by the current value-lease code. Cross-process acquisition is not yet atomic because the lease sequence is not wrapped in `withFileLock`; this is directly covered by the remaining work in `TOOL_PERMISSION_PARITY_PLAN.md`. |
| `{workspace}/.ctrlyoke/temp/agy-statusline-<uuid>.json` | Per-prompt statusline snapshot consumed by the wrapper                                        | Returned as an additional cleanup path                                                                                                                       | The UUID makes these snapshots run-unique; no settings lease is needed.                                                                                                                                                                                                                                   |
| `~/.gemini/config/mcp_config.json`                      | Read as the global MCP baseline by the tracker; not written by the current agy provider       | User-global baseline remains outside ctrlyoke cleanup                                                                                                        | This path must not be listed as a current ctrlyoke write. The current write target is the workspace `.agents/mcp_config.json`.                                                                                                                                                                            |

Antigravity’s hooks are the best current example of acceptable merge semantics:
distinct workflow keys get separate top-level groups, and the file lock makes
the read-modify-write coherent. That still does not solve same-key concurrency,
and it does not make MCP safe because MCP entries have no prompt-local allowlist.

### Codex CLI — inline hooks (Stage 2 complete)

Source: [`CodexCliProvider.ts`](../../src/core/harness/codex/CodexCliProvider.ts) and [`SettingsJsonHooksTracker.ts`](../../src/core/harness/shared/SettingsJsonHooksTracker.ts).

| File                            | What ctrlyoke writes                                                                                       | Current parallel behavior                                                                                                                                                                       | Disposition                                                                                                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{workspace}/.codex/hooks.json` | No longer written by ctrlyoke; any user-owned project file is left untouched                                  | N/A — hook and trust overrides are emitted through repeated `-c` arguments for each Codex process                 | Resolved by [`CODEX_INLINE_HOOKS_PLAN.md`](CODEX_INLINE_HOOKS_PLAN.md); Codex MCP is already inline and writes no MCP settings file. |
| `{workspace}/.codex/.gitignore` | No longer written by ctrlyoke                                                        | N/A — there is no ctrlyoke-owned Codex hook file to hide or clean up                                      | Removed with the inline migration. |

Codex remains in this audit to record the completed migration. Its hook setup
does not require a shared-file lease or workspace cleanup; the remaining Codex
work is command-line budgeting and diagnostics, not file ownership.

### OpenCode — Stage 4 inline plugin delivery complete

Source: [`OpenCodeCliProvider.ts`](../../src/core/harness/opencode/OpenCodeCliProvider.ts), [`OpenCodeNotificationMonitor.ts`](../../src/core/harness/opencode/OpenCodeNotificationMonitor.ts), and [`OpenCodeInlineConfig.ts`](../../src/core/harness/opencode/OpenCodeInlineConfig.ts).

| File                                                                  | What ctrlyoke writes                                                                               | Current parallel behavior                                                                                                                                                                                                                                             | Disposition                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_CONFIG_CONTENT`                                             | Per-step `mcp`, `permission`, and `plugin` slices serialized at spawn time                         | Process-local and isolated per provider instance; no workspace-discovered permission or MCP mutation                 | Resolved for Stage 2; collision handling for user config remains Stage 3                                                                 |
| `OPENCODE_CONFIG_CONTENT.plugin[]`                                   | Absolute extension-installed plugin path                                                           | Process-local; OpenCode resolves the absolute path to a `file://` URL                                                                                                                                        | Normal path is isolated and leaves the repository unchanged                                                                                                                                                                                                                                                                                    |
| `CTRLYOKE_OPENCODE_HOOKS`                                            | JSON user-hook list                                                                               | Process-local and per provider/run                                                                                                                                        | Replaces the shared sidecar without changing hook dispatch semantics                                                                                                                                                                                                                                                                           |
| `{workspace}/.opencode/plugin/*` (fallback only)                     | Compatibility copy when the external plugin cannot be loaded                                       | Warning-backed and provider-cleaned                                                                                                                                                                          | Keep as a clearly marked regression fallback; absent from successful runs                                                                                                                                                                                                                                                                       |

OpenCode no longer consumes the shared permission lease. The remaining
workspace-file entries below describe only the plugin deployment; the shared
value lease remains relevant to Antigravity’s statusline.

### Claude CLI

Source: [`ClaudeCliProvider.ts`](../../src/core/harness/claude/ClaudeCliProvider.ts) and [`CliMcpConfigGenerator.ts`](../../src/core/harness/shared/CliMcpConfigGenerator.ts).

| File                                                                   | What ctrlyoke writes                                           | Visibility and cleanup                                                         | Parallel behavior                                                                                                                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{workspace}/.ctrlyoke/temp/claude-hook-settings-<stem>-p<index>.json` | Per-prompt hook settings passed explicitly with `--settings`   | Claude reads only the path for that invocation; provider tracks and deletes it | Different stems normally coexist. Same workflow stem and prompt index collide; a no-working-file fallback uses a timestamp and is not a durable run identity.           |
| `{workspace}/.ctrlyoke/temp/mcp-config-claude-<stem>.json`             | Per-execution MCP config passed explicitly with `--mcp-config` | Deleted through generic cleanup                                                | Different stems normally coexist; the `default` fallback is shared by concurrent runs without a working-file path. It is not auto-discovered by another Claude process. |

Claude’s files are local execution inputs rather than workspace-discovered
settings. They do not need the workspace permission-policy lease, but the
filename collision caveat should remain visible if parallel same-key execution
is expanded.

## Cross-cutting tracker findings

### `SettingsJsonMcpTracker`

`SettingsJsonMcpTracker` currently provides an **in-process async mutex** around
read-modify-write operations. It also provides MCP reference counting, baseline
preservation, atomic JSON writes, temporary `.gitignore` handling, and the
single-value lease used by Antigravity statusline.

The tracker’s `userConfigPath` is used to read baseline MCP names; it does not
mean that ctrlyoke writes the user-level MCP file. The current provider writes
the configured project path unless a provider explicitly supplies another
project path.

The following limitations are material to the lease audit:

- the ordinary mutex is not a cross-process lock;
- baseline fields are currently singleton state rather than keyed by resolved
  config path, as already called out in `TOOL_PERMISSION_PARITY_PLAN.md`;
- value-lease sidecars expose ownership across processes, but acquisition is not
  atomic across processes until the full prune/check/write sequence is wrapped
  in `withFileLock`;
- workflow keys are generally working-file paths, not run IDs, so same-key
  concurrent runs can replace tracker state.

### `SettingsJsonHooksTracker`

The hooks tracker has no mutex of its own. Callers are required to invoke it
inside the corresponding MCP tracker’s `withLock`. It captures a baseline,
merges all active workflow layers, and restores the baseline only after the
last active workflow unregisters.

That model is appropriate when workflows have distinct keys and duplicate hook
groups are acceptable. It does not provide unique ownership for two concurrent
registrations with the same key, and it is not a distributed lock across
separate ctrlyoke processes.

## Lease classification for the tool-permission plan

The current audit supports these classifications:

1. **Permission-policy lease:** OpenCode’s permission block is now delivered
   through `OPENCODE_CONFIG_CONTENT`; it is no longer a workspace mutation or a
   consumer of the permission lease.
2. **Statusline value lease:** Antigravity’s global `settings.json` statusline
   is a separate single-value lease. It is not a tool-permission policy, but it
   needs the same cross-process ownership rigor and dead-owner recovery.
3. **MCP shared-file ownership:** Antigravity merges server definitions into a
   workspace-discovered file. MCP is not permission policy, but it has a
   stronger pollution risk than hooks. OpenCode now delivers its MCP entries
   inline, while the existing tracker remains relevant to Antigravity.
4. **Hook-file coordination:** Qwen and current Codex use merged hook arrays;
   Antigravity uses named groups; Copilot uses separately auto-discovered files.
   These should preserve multiple active workflows where possible. A lease
   should prevent destructive overwrite/cleanup races, not reject two different
   completion hooks merely because they share a file.
5. **Inline or explicitly passed inputs:** Codex MCP, Copilot/Claude MCP temp
   files, and Claude hook temp files are not workspace-discovered policy files.
   They need run-unique naming and cleanup ownership, not the OpenCode-style
   workspace permission lease.

## Recommended follow-up order

- **Shared prerequisite for all three inline migrations (landed 2026-07-31):**
  `CliIntegration.getInjectIncompatibilityReason` now fails closed with
  distinct reasons when the `spawnedWith` snapshot or current resolved
  properties are unavailable. Every inline mechanism fixes its configuration at
  spawn time (environment for OpenCode, `argv` for Codex and Qwen), so reusing a
  running process whose spawn configuration cannot be compared can silently
  execute a step under the previous step's permission policy, MCP set, or
  hooks. The restart path logs the reason and is covered by unit tests; see
  [`TOOL_PERMISSION_PARITY_PLAN.md`](TOOL_PERMISSION_PARITY_PLAN.md).
- Implement the Codex inline hook plan and remove Codex’s current hook-file
  entry from the long-term shared-file inventory.
- Complete the remaining OpenCode plugin move in Stage 4 of the inline config
  plan, then keep the permission plan scoped to Antigravity statusline and any
  still-file-backed policy writer.
- Add cross-process locking or an equivalent ownership protocol around Qwen’s
  global `trusted_hooks.json` read-modify-write.
- Give Copilot, Qwen, and Antigravity hook ownership a run-specific identity (or
  explicitly document that same-workflow concurrent runs are unsupported) before
  claiming that two concurrent runs are independent.
- Keep Qwen MCP on its per-invocation inline configuration. Decide separately
  whether Antigravity MCP needs a step-scoped lease, a prompt-local isolation
  mechanism, or an inline/config alternative. Do not
  reuse the permission-policy conflict semantics for hooks without considering
  the different duplicate-hook behavior.
- Keep Claude’s and Copilot’s direct-input temp files in the lower-risk category,
  but add run IDs to fallback/default filenames if same-key parallel execution
  becomes a supported scenario.

## Source-of-truth references

- [`SettingsJsonMcpTracker.ts`](../../src/core/harness/shared/SettingsJsonMcpTracker.ts)
- [`SettingsJsonHooksTracker.ts`](../../src/core/harness/shared/SettingsJsonHooksTracker.ts)
- [`TOOL_PERMISSION_PARITY_PLAN.md`](TOOL_PERMISSION_PARITY_PLAN.md)
- [`CODEX_INLINE_HOOKS_PLAN.md`](CODEX_INLINE_HOOKS_PLAN.md)
- [`OPENCODE_INLINE_CONFIG_PLAN.md`](OPENCODE_INLINE_CONFIG_PLAN.md)
