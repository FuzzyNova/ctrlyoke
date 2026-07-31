# Qwen Inline MCP and Hook Isolation Plan

> **Status:** Stage 1 complete; Stage 2 proposed
>
> **Priority:** P1 for inline MCP; exploratory for extension-backed hooks
>
> **Related:** [`HARNESS_SETTINGS_FILE_WRITE_AUDIT.md`](HARNESS_SETTINGS_FILE_WRITE_AUDIT.md), [`OPENCODE_INLINE_CONFIG_PLAN.md`](OPENCODE_INLINE_CONFIG_PLAN.md), [`CODEX_INLINE_HOOKS_PLAN.md`](CODEX_INLINE_HOOKS_PLAN.md), [`WORKTREE_SUPPORT_PLAN.md`](WORKTREE_SUPPORT_PLAN.md)

## Recommendation

Stage 1 delivers Qwen MCP servers through its native per-invocation
`--mcp-config` argument. This removes ctrlyoke's writes
to `{workspace}/.qwen/settings.json` for MCP and makes concurrent workflows
independent without an MCP tracker, ref counts, baseline restoration, or an
`--allowed-mcp-server-names` isolation workaround.

Do **not** move Qwen hooks to an extension yet. Qwen 0.20.1 has no CLI option
for inline hooks, a hook-config path, or a settings-path override. Its user
extension mechanism is a credible route to eliminate both the workspace hook
file and `~/.qwen/trusted_hooks.json`, but it is a user-global installation
with extension-selection and dynamic-user-hook semantics that need a real
prototype before it becomes the default. Until then, retain the workspace hook
tracker and fix the global trusted-hook update to be parallel-safe.

This deliberately differs from the OpenCode recommendation: Qwen already has
a first-class CLI MCP boundary, but has no equivalent hooks boundary.

## Verified findings

All CLI findings below were checked against the installed Qwen Code **0.20.1**
on Windows with `qwen hello --help` on 2026-07-31. Source findings were checked
against `c:\dev\qwen-code` at `af63c9d54e3cb855c23b6b0e8cb055105f8b11f1`.

### MCP is natively per invocation

`qwen --help` exposes:

```text
--mcp-config  MCP server configuration as JSON string or file path.
              Can be a path to a JSON file or inline JSON with
              {"mcpServers": {...}} format.
```

The source confirms this is intentional, not a help-text accident:

- `packages/cli/src/config/config.ts:1395-1454` parses either a file or inline
  JSON and accepts both the wrapper object and a direct server map.
- `:2035-2055` gives `--mcp-config` top-tier precedence over settings and
  project `.mcp.json`; it survives `--bare` because it is an explicit
  per-invocation input.
- Top-tier CLI MCP servers are not approval-gated (`:2040-2056`). ctrlyoke
  should therefore pass only the MCP servers the prompt explicitly requests.

A live `--bare --mcp-config` probe reached Qwen's runtime without creating a
workspace `.qwen` file. The request stopped before inference because the local
Qwen OAuth free tier was discontinued, not because the MCP argument was
rejected. The command-line contract and source parsing are sufficient evidence
for the migration; real-harness coverage should run under a configured Coding
Plan or other supported provider.

### There is no inline or path-addressable hook configuration

The same 0.20.1 help output has no `--hooks`, `--settings`, or configuration
path flag. Qwen loads hooks from the user and workspace settings objects:

- `packages/cli/src/config/settings.ts:609-625` returns user hooks and trusted
  workspace hooks separately.
- `packages/cli/src/config/config.ts:2325-2335` passes those settings-derived
  hook objects into the runtime.

So a unique hook file cannot be passed like Claude's `--settings <temp-file>`.
Changing `QWEN_HOME` is not an alternative: it redirects settings, credentials,
OAuth state, extensions, and `trusted_hooks.json` together
(`packages/core/src/config/storage.ts:183-208, 367-368`). Copying that state per
run would be both unsafe and harder to maintain than the current tracker.

### A user-level extension is a promising, but not free, hook carrier

Qwen extensions are installed under `~/.qwen/extensions`; an extension can
declare hooks in `qwen-extension.json`. `HookRegistry` loads active extension
hooks directly and labels them as `Extensions` (`packages/core/src/hooks/
hookRegistry.ts:265-275`), rather than reading the workspace hook settings or
consulting `trusted_hooks.json`. Command hooks inherit sanitized process
environment plus their declared environment (`hookRunner.ts:590-607`), so a
static extension hook can route each ctrlyoke process through
`CTRLYOKE_QWEN_*` spawn variables.

However, `--extensions` is an **allow-list**, not an additive load. It enables
only named extensions (`extensionManager.ts:563-585`) and `Config.getExtensions`
filters the result again (`config.ts:6836-6847`). Passing only
`--extensions ctrlyoke` would suppress a user's other Qwen extensions during a
workflow. A globally enabled ctrlyoke extension avoids that filtering, but it
would be invoked by manual Qwen processes too and must be an inert no-op unless
an explicit ctrlyoke environment marker is present.

Finally, ctrlyoke user hooks are dynamic per workflow (`UserHookConfig` is an
event, command, and optional timeout). A static extension must either dispatch
those commands from a process-local payload without changing hook output
semantics, or the extension route must remain unavailable when user hooks are
configured. This is why it is not a drop-in replacement today.

## Stage 1 — migrate MCP to `--mcp-config` (complete)

In `QwenCliProvider`:

1. Replace `SettingsJsonMcpTracker` use with a pure builder. Continue using
   `CliProviderUtils.buildSettingsJsonMcpEntries(...)` for the Qwen-shaped
   server entries, but serialize them as:

   ```ts
   ["--mcp-config", JSON.stringify({ mcpServers: entries })];
   ```

   Rename the helper in a later cleanup only if its remaining callers can move
   together; it is still the shared Qwen/Antigravity entry-schema builder.

2. Return `null` only when neither ctrlyoke's dynamic server nor prompt-level
   user servers exist. Do not create `.qwen/`, `settings.json`, a sibling
   `.gitignore`, or `settings.json.orig`.
3. Remove the static `mcpTracker`, MCP registration/unregistration, and
   `getAllowedServerNames` call. There are no other ctrlyoke MCP servers in
   workspace state to hide once each process gets its own config object, so
   `--allowed-mcp-server-names` is no longer needed for ctrlyoke isolation.
   Qwen's user-owned settings and `.mcp.json` continue to behave as Qwen
   normally defines them.
4. Remove the unconditional cleanup of `.qwen/settings.json.orig`. Without a
   ctrlyoke-owned settings file, deleting a Qwen-created backup risks deleting
   user state.
5. Preserve ordering: Qwen currently puts base MCP arguments before model,
   resume, additional arguments, and permission arguments. Keep
   `--mcp-config` as a two-token argument and do not embed it in an
   `additionalArgs` string.

The serialized config may contain MCP environment values. Never emit the JSON
in `Log.debug`, process-error diagnostics, output history, dry-run displays, or
test snapshots. The existing `QwenCliProvider.buildCliArgs()` full-argument
debug logging must redact `--mcp-config`'s following value before this change
ships. The value is necessarily visible to the child process command line; the
migration's security gain is removing a durable, workspace-readable copy.

Implemented on 2026-07-31. Qwen now receives the prompt's complete MCP set as
the two-token `--mcp-config <inline-json>` argument, and the provider no longer
registers or unregisters MCP entries in `.qwen/settings.json`. The tracker is
temporarily retained only as the hook-registration mutex until Stage 2.

## Stage 2 — retain hooks, make global trust writes safe

Keep `SettingsJsonHooksTracker` and workspace `.qwen/settings.json` hook
registration. It continues to preserve user hooks and permits simultaneous
workflows to contribute separate hook groups.

Move the ad hoc read-modify-write of `~/.qwen/trusted_hooks.json` out of
`QwenCliProvider.registerHooksInSettings()` into a dedicated shared tracker:

- serialize all reads and writes in this extension-host process;
- preserve unknown workspace entries and user-added trust keys;
- reference-count only ctrlyoke-owned keys by workflow key; never remove a
  pre-existing trust entry;
- use atomic write/replace and a per-file cross-process lock or lease before
  claiming cross-window safety;
- retain trust keys after a workflow if Qwen's trust model is intentionally
  persistent, but make that persistence explicit in the tracker rather than
  leaving an unguarded provider-local mutation.

`SettingsJsonMcpTracker.withLock()` currently serializes hook mutations only
because both mutations target the same workspace settings file. After Stage 1,
give `SettingsJsonHooksTracker` (or a neutral settings-file lock helper) that
responsibility rather than retaining an otherwise-dead MCP tracker solely as a
mutex.

## Stage 3 — extension-backed hooks spike (not committed migration work)

Prototype a single **user-level** `ctrlyoke` Qwen extension before committing
to this route. The extension has a static manifest and a static command hook;
ctrlyoke supplies per-process routing data through spawn environment variables.
The hook wrapper exits successfully without side effects unless
`CTRLYOKE_QWEN_HOOK_ACTIVE=1` is present.

The spike must prove all of the following:

1. The installed 0.20.1 CLI loads extension hooks in both `-i` and headless
   stream-json runs with no `trusted_hooks.json` prompt or mutation.
2. `SessionStart`, `UserPromptSubmit`, `Stop`, notification events, and
   `PermissionRequest` retain the current notification and decision behavior.
3. Two workflows started concurrently pass distinct notification directories
   and decision data through inherited environment without cross-routing.
4. User workflow hooks preserve command input, exit-code, timeout, and
   permission-decision semantics. If that cannot be proven, the extension path
   is unsupported for runs with user hooks rather than silently degrading them.
5. Normal Qwen use has no observable hook side effect when the marker is
   absent. Alternatively, if `--extensions` is used, ctrlyoke must preserve
   every user-selected active extension; do not replace the user extension set
   with a singleton `ctrlyoke` value.
6. Installation, extension-version update, downgrade, and uninstallation are
   explicit user-global lifecycle operations. They must not occur as an
   unannounced side effect of running a workflow.

If the spike passes, write a follow-up implementation plan for an opt-in hook
transport. It may then delete Qwen's workspace hook tracker and global trusted
hooks tracker, but must not duplicate hook-dispatch behavior between the
extension and `ctrlyoke-qwen-hook.js`.

## Test matrix

Unit coverage:

- no MCP input produces no `--mcp-config` argument and no workspace mutation;
- dynamic ctrlyoke MCP, local user MCP, remote user MCP, and environment values
  serialize to the same Qwen entry shape as today's settings JSON;
- two provider instances with different MCP sets produce independent argument
  values with no tracker state;
- cleanup leaves a pre-existing `.qwen/settings.json`, a missing `.qwen`
  directory, and `settings.json.orig` untouched;
- debug-argument rendering redacts the complete inline config value;
- the hooks tracker serializes simultaneous trust updates and preserves an
  external edit made while ctrlyoke hooks are active.

Real-harness coverage, under a supported authenticated Qwen provider:

- an inline MCP tool is callable in headless and interactive runs;
- a config with no workspace `.qwen` directory leaves no `.qwen` directory or
  `.gitignore` behind;
- concurrent workflows with different dynamic MCP tools can call only their
  own ctrlyoke tool, while user-owned Qwen MCP configuration remains available
  according to Qwen's normal rules;
- existing hooks still deliver start, completion, and permission events during
  the Stage 1 MCP-only migration;
- the extension spike's six acceptance criteria above, before any hook
  migration is enabled.

## Outcome

After Stage 1, Qwen no longer writes MCP configuration into the repository.
Parallel workflows get distinct process-local MCP definitions, which removes
the most consequential shared-settings conflict while preserving ordinary
parallel native workflows. Workspace hooks remain a known, contained file
integration until Qwen offers a direct inline/path mechanism or the extension
spike proves it can replace them without changing user behavior.
