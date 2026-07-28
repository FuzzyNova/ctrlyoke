# Cross-Harness Tool Permission Parity Plan

> **Status:** Proposed
>
> **Priority:** P1 — immediate honesty, then parity
>
> **Parent architecture:** `HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`

---

## Problem

ctrlyoke exposes a shared `toolPermissions` model:

- permission mode;
- allowed tool patterns;
- denied tool patterns.

The coarse permission mode has a meaningful provider mapping, but granular tool
lists are not reliably enforced across the supported harnesses.

Current code overstates support in several places:

- `QwenToolPermissionMapper` emits `--allowed-tools`, `--exclude-tools`, and
  `--approval-mode`, but this is not behaviorally verified against the currently
  supported Qwen CLI and has been observed not to work.
- `OpenCodeToolPermissionMapper` says permissions are written to
  `opencode.json`, but `OpenCodeCliProvider` only merges the MCP block; it never
  writes the permission block.
- Codex and Antigravity are intentionally mode-only, but the caveat is not
  consistently visible across every permissions surface.
- Mapper unit tests assert generated strings. They do not prove that a harness
  accepts the configuration or blocks/allows a real tool call.

This is a security and trust issue. A denied rule that is silently ignored is
materially different from an unavailable convenience feature.

## Current Baseline

Treat granular allow/deny support as follows until behavioral verification says
otherwise:

| Harness         | Permission mode                             | Allowed/denied lists              | Current disposition                              |
| --------------- | ------------------------------------------- | --------------------------------- | ------------------------------------------------ |
| Copilot CLI     | Supported                                   | Supported                         | Retain and integration-test                      |
| Claude CLI      | Supported                                   | Supported through translation     | Retain and integration-test                      |
| Qwen Code       | Supported                                   | Broken/unverified                 | Warn now; implement workspace config             |
| OpenCode        | Supported                                   | Not implemented                   | Warn now; implement workspace config             |
| Codex CLI       | Supported through sandbox/approval controls | No general equivalent             | Mode-only; investigate safe partial translations |
| Antigravity CLI | Supported                                   | No documented granular equivalent | Mode-only                                        |
| Copilot Chat    | Harness-managed                             | Not applicable                    | Unsupported                                      |

This table belongs in the shared capability registry once that registry exists.
Do not copy it into multiple UI components.

## Phase 0 — Honest UI Now

Until a harness has a passing behavioral test, the permissions UI must state that
Allowed Tools and Denied Tools are currently supported only by Copilot CLI and
Claude CLI.

Update every surface that exposes the lists:

- workflow properties panel;
- prompt properties drawer;
- default permissions page;
- advanced permissions help;
- schema/settings documentation and tooltips.

Required behavior:

- Qwen must temporarily be classified as unsupported for granular lists despite
  the existing mapper.
- A harness-specific warning explains whether the lists are ignored,
  unverified, or require workspace configuration.
- Fields that cannot affect the selected harness are disabled at the
  workflow/prompt level.
- The defaults page, which has no single effective harness, keeps fields editable
  but displays the support summary.
- The warning must state that a denied list is **not enforced**. Avoid softer
  wording such as "may behave differently."

The first implementation may use the existing shared helper, but it must migrate
to the capability registry in the same vertical slice so the UI and execution
cannot drift again.

## Workspace-Configuration Support

Qwen and OpenCode support project-scoped permission configuration:

- Qwen: `.qwen/settings.json`, using `permissions.allow` and
  `permissions.deny`.
- OpenCode: project `opencode.json`, using `permission` rules with
  `allow`, `ask`, and `deny` decisions.

Implement this through one reusable, ownership-aware workspace configuration
mutation service. Reuse the locking, baseline, reference-counting, and cleanup
lessons in `SettingsJsonHooksTracker` and `SettingsJsonMcpTracker`; do not create
two unrelated ad hoc writers.

### Required mutation semantics

- Read-modify-write only the owned permission keys.
- Preserve unrelated user settings, formatting limitations permitting.
- Capture the original value before the first active owner.
- Reference-count identical active configurations.
- Reject or serialize conflicting configurations in the same workspace. Two
  parallel workflows must never silently replace one another's security policy.
- On final release, restore only ctrlyoke-owned changes.
- Do not overwrite edits the user made while the workflow was running. Use an
  ownership/three-way comparison and surface a cleanup conflict.
- Persist enough recovery metadata to remove stale ctrlyoke-owned values after a
  crash without replacing the user's whole file.
- Use atomic writes and the existing workspace-scoped path/security guards.
- Hold the configuration for the lifetime of the harness process that consumes
  it, including a retained interactive session.

### Required disclosure

Project settings are discovered by every matching harness process in that
workspace. While ctrlyoke's injected permission policy is active, it can affect:

- other ctrlyoke workflows using that harness;
- a manually launched harness in the same workspace;
- an interactive session that outlives the workflow step.

Show this caveat before execution and in dry-run output. The caveat should name
the exact file and whether ctrlyoke will restore its owned changes.

## Qwen Implementation

Replace the unverified CLI-list mapping with project configuration for verified
versions:

- translate ctrlyoke patterns to Qwen's current canonical tool aliases and
  specifier syntax;
- write `permissions.allow` and `permissions.deny`;
- preserve existing `permissions.ask`;
- preserve the documented precedence `deny` > `ask` > `allow`;
- account for permission arrays merging across Qwen configuration scopes;
- do not claim an exclusive allowlist if Qwen's semantics only auto-approve
  matching tools;
- retain coarse mode arguments only where the installed version accepts them.

Version differences matter because Qwen has changed both its settings schema and
CLI arguments. Detect the installed version and mark unverified versions rather
than falling back to stale flags.

Behavioral tests must launch Qwen in an isolated fixture workspace and prove that:

- an allowed harmless tool call proceeds as intended;
- a denied harmless fixture operation is refused;
- deny wins when a pattern appears in both lists;
- the original `.qwen/settings.json` is restored after normal exit, cancellation,
  and startup failure.

## OpenCode Implementation

Implement the behavior currently promised by comments in the provider:

- merge a `permission` block into the project configuration OpenCode actually
  discovers;
- start custom mode from an explicit `"*": "ask"` baseline;
- translate known ctrlyoke tools to OpenCode permission keys;
- translate shell argument patterns to OpenCode's wildcard syntax;
- apply denied rules after allowed rules because OpenCode uses last-match wins;
- preserve unrelated permission rules and all non-permission config;
- coordinate the mutation with the existing MCP writer so both features cannot
  race on the same file.

Do not delete the entire OpenCode config during workflow cleanup. The current MCP
cleanup contract must also be corrected/refactored as needed so owned MCP and
permission entries are removed without destroying pre-existing user settings.

Behavioral tests must prove allow and deny decisions with safe fixture tools and
cover a config containing pre-existing MCP and permission entries.

## Codex Partial Support Investigation

Codex has useful security primitives, but they do not form a general mapping for
ctrlyoke tool names:

- project `.codex/config.toml`;
- project-local command rules;
- sandbox/approval settings and permission profiles;
- MCP server `enabled_tools` and `disabled_tools`.

Investigate translations by category:

- `shell(command:*)` may map to project-local command prefix rules;
- MCP tool patterns may map to per-server enabled/disabled tool lists;
- broad read/write patterns may map only approximately to permission profiles.

Only advertise `partial` for categories with behavioral tests. A partial mapping
must emit diagnostics for every untranslatable rule. Never translate a broad
denial into a weaker rule silently.

Codex remains mode-only for the generic lists until this investigation lands.

## Antigravity

Keep Antigravity mode-only unless its supported CLI/configuration exposes a
documented granular policy mechanism.

Do not infer granular support from Gemini/Qwen configuration merely because the
products share history or directories. Antigravity needs its own verified
contract.

## Interface Changes

`IToolPermissionMapper.buildArgs()` cannot represent a permission policy applied
through a workspace file or report lossy translations. Evolve the abstraction:

```typescript
interface ToolPermissionApplication {
  cliArgs: string[];
  workspaceMutation?: WorkspacePermissionMutation;
  diagnostics: CompatibilityDiagnostic[];
}

interface IToolPermissionMapper {
  describeSupport(version?: string): ToolPermissionCapability;
  prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication>;
  hasFullPermissions(config: ToolPermissionConfig): boolean;
}
```

The final names may differ, but command arguments, workspace side effects, and
diagnostics must be returned through one preparation contract.

## Testing Strategy

Keep mapper unit tests, but add:

- capability completeness tests for every harness;
- workspace writer merge/restore/conflict/crash-recovery tests;
- provider command/config snapshot tests;
- UI tests for each support state;
- integration tests against pinned harness versions;
- negative behavioral tests that exercise safe denied operations.

An argument/config snapshot is not sufficient evidence for the `supported`
capability state.

## Acceptance Criteria

- Every permission UI clearly states the current granular-support boundary.
- Qwen no longer emits unverified tool-list flags as if they were enforced.
- OpenCode no longer claims a permission config side effect it does not perform.
- Qwen and OpenCode granular policies pass behavioral allow/deny tests before
  their UI support state becomes enabled.
- Conflicting workspace permission policies cannot run concurrently without an
  explicit resolution.
- Cleanup preserves pre-existing settings and user edits.
- Codex and Antigravity never silently ignore configured granular rules; the
  compatibility layer emits a pre-execution warning.
- Dry run shows the exact permission translation and workspace file side effect.

## Non-goals

- Pretending all harness permission systems have identical semantics.
- Writing user-global harness configuration.
- Leaving workspace permission mutations behind as persistent project policy.
- Treating prompt instructions such as "do not use shell" as a security control.
- Marking support complete based only on provider documentation or emitted flags.
