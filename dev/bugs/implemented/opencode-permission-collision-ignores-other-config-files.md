# OpenCode permission collision detection only reads `opencode.json`, so `deniedTools` can be overridden by user config in other OpenCode config files

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/opencode/OpenCodeInlineConfig.ts`
- **Resolution:** fixed in this commit

## Symptom

**Security issue.** A workflow's `toolPermissions.deniedTools` can be silently overridden, and so can the custom-mode `"*": "ask"` catch-all. This happens when the user's OpenCode permission keys live in a config file that ctrlyoke's collision resolver does not read: `opencode.jsonc`, the global `config.json`, `.opencode/opencode.json[c]`, or a project config in a parent directory. A denied tool such as `bash` then runs without approval.

## Steps to Reproduce

1. Create `~/.config/opencode/opencode.jsonc` containing `{"permission": {"bash": "ask", "*": "ask"}}`, with no `~/.config/opencode/opencode.json`.
2. Run an `opencode-cli` workflow step with `toolPermissions: { mode: allowAll, deniedTools: ["bash"] }`.
3. `resolveOpenCodePermissionCollisionContext` never reads the `.jsonc` file, so it returns empty `topLevelKeys`. `buildPermissionPolicy` then emits the `OPENCODE_CONFIG_CONTENT` permission `{"*": "allow", "bash": "deny"}` without renaming anything to `bash*` or `**`.
4. OpenCode deep-merges the inline config over the global layer. The merged keys keep the global layer's order, which gives `{bash: deny, *: allow}`.
5. OpenCode applies the last matching rule. `*: allow` matches `bash`, so the step runs bash commands even though they were denied.

## Root Cause

`resolveOpenCodePermissionCollisionContext` (`src/core/harness/opencode/OpenCodeInlineConfig.ts:100-138`) finds the user's existing permission keys. `OpenCodeToolPermissionMapper.allocateKey` uses those keys to rename colliding emitted keys (`bash` becomes `bash*`, `*` becomes `**`). The renaming is needed because OpenCode deep-merges config layers, a merged key keeps the position it had in the lower-precedence layer, and OpenCode picks the last matching rule.

The resolver builds a fixed path list at lines 104-117 that contains only:

- `~/.config/opencode/opencode.json`
- `$OPENCODE_CONFIG`
- `<workspaceRoot>/opencode.json`

OpenCode 1.19 loads more layers below `OPENCODE_CONFIG_CONTENT`, and the resolver reads none of them:

- `config.json` and `opencode.jsonc` in the global config dir
- `opencode.json` and `opencode.jsonc` found by searching up from the cwd to the worktree root
- `.opencode/opencode.json[c]`
- managed config dirs

Line 112 has a separate defect. It resolves a relative `OPENCODE_CONFIG` against the extension host's `process.cwd()`, not against the OpenCode process cwd (the workspace root).

`OpenCodeToolPermissionMapper.allocateKey` (`src/core/harness/opencode/OpenCodeToolPermissionMapper.ts:369-392`) renames only keys that are in this incomplete set. `buildPermissionPolicy` (lines 149-210) therefore emits bare `*` and tool keys. Those keys merge into the positions the user's keys already hold. That breaks the ordering the mapper relies on, which its doc comment (lines 141-148) describes as allow rules first and deny rules last.

## Decision

Verified against the installed OpenCode 1.18.15 config docs and upstream config source: collision discovery covers the global `config.json`, `opencode.json`, and `opencode.jsonc` files, `OPENCODE_CONFIG`, ancestor project config files, `.opencode` config files, and `OPENCODE_CONFIG_DIR`. System-managed config is excluded because OpenCode applies it after `OPENCODE_CONFIG_CONTENT`, so it is not a lower-precedence layer whose permission keys can reorder ctrlyoke's rules. OpenCode merges config layers in precedence order while retaining existing object key positions, which reproduces the permission collision described above.

## Suggested Fix

- Make `resolveOpenCodePermissionCollisionContext` follow OpenCode's config discovery order:
  1. Global dir: `config.json`, `opencode.json`, `opencode.jsonc`.
  2. `OPENCODE_CONFIG`, resolved against the OpenCode process cwd (the workspace root), not `process.cwd()`.
  3. Project `opencode.json` and `opencode.jsonc` in each directory from the worktree root down to the workspace root, root first.
  4. `.opencode/opencode.json[c]` in those directories, plus `OPENCODE_CONFIG_DIR` and managed config dirs if feasible.
- Put the config file name lists in shared constants.
- Add unit tests in `src/test/unit/OpenCodeCliProvider.test.ts` showing that a key defined in only one of these files still causes renaming.
- A more robust option is to always emit renamed keys (e.g. `**`, `bash*`) that cannot collide with plain user keys. Another is to check the merged ordering with `opencode debug config` before launch.
