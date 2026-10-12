# Claude Code `custom` permission mode does not enforce the Allowed Tools list

- **Found:** 2026-10-12 by Claude while writing `docs/workflows/permissions.md`
- **Area:** `src/core/harness/claude/ClaudeToolPermissionMapper.ts`
- **Severity:** high

## Symptom

The schema describes `toolPermissions.mode: custom` as "uses allowedTools + deniedTools only"
(`schemas/workflow-schema.json:1910`) and lists Claude CLI as supporting Allowed Tools
(`:1917`). The Claude mapper declares `allowedTools` with `fidelity: "exact"`
(`ClaudeToolPermissionMapper.ts:30-34`), and the generated compatibility matrix repeats that.
On Claude Code, though, `custom` behaves like `allowAll` minus the deny list. Any tool that is
not on **Denied Tools** runs without a prompt, whether or not it is on **Allowed Tools**. A user
who builds a narrow allow list (for example, only `write` and `shell(git status)`) gets no
restriction from it.

`docs/workflows/permissions.md` already warns about this ("rely on Denied Tools"), but the
schema, the capability table and the dashboard all say otherwise.

## Steps to Reproduce

1. Run a Claude Code step with:
   ```yaml
   toolPermissions:
     mode: custom
     allowedTools: ["shell(git status)"]
     deniedTools: []
   ```
   and the prompt "Run `node -e "console.log(1)"` in the shell, then create `scratch.txt`".
2. ctrlyoke launches Claude with
   `--permission-mode bypassPermissions --allowedTools Bash(git status)`.
3. Claude runs the `node` command and writes the file without asking. Neither is on the allow
   list.

## Root Cause

`ClaudeToolPermissionMapper.prepare` uses `--permission-mode bypassPermissions` for both
`allowAll` and `custom` (`src/core/harness/claude/ClaudeToolPermissionMapper.ts:88-90`). In
`custom` mode it then adds `--allowedTools` (`:94-104`). In Claude Code, `--allowedTools` only
adds allow rules, which mean "run this without prompting". It does not limit which tools are
available. `bypassPermissions` already skips every prompt, so the allow rules change nothing.
Only deny rules (`--disallowedTools`, `:107-115`) and `--tools` (which limits the built-in tool
set) restrict anything under `bypassPermissions`. The design note in
`dev/implemented/CLAUDE_CLI_DESIGN.md:386-389` checked that bypass respects the deny list, but
not that it respects an allow list.

## Suggested Fix

Make `custom` mean "only what is allowed" on Claude Code:

- Headless: use `--permission-mode dontAsk` (listed in `src/test/fixtures/harness-help/claude-cli.txt:140-143`)
  with `--allowedTools` and `--disallowedTools`. `dontAsk` auto-denies anything that is not
  pre-approved, which is what the schema promises. Note that the user's own
  `~/.claude/settings.json` allow rules also count as pre-approved.
- Interactive: use the default permission mode with the same allow and deny rules, so tools
  that are not listed prompt the user, as `docs/workflows/permissions.md:33` describes for
  `custom` ("Anything else is left to the harness to ask about").
- Optionally, derive `--tools` from the allow list's tool names, so tools that aren't listed are
  not offered to the model at all.

Confirm the behavior with one real Claude run before and after the fix (this is the only
evidence the code can't give). Then update the mapper's tests in
`src/test/unit/ToolPermissionMappers.test.ts` and `HarnessToolPermissionMappers.test.ts`,
the header comment at `ClaudeToolPermissionMapper.ts:48-51`, and the Claude row and caveat in
`docs/workflows/permissions.md:136`, `:148-149`. Until the fix ships, lower the `allowedTools`
fidelity to `partial` so the compatibility matrix stops claiming exact support.
