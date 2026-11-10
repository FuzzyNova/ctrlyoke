# Codex Permission Rules Plan

**Status:** Codex work remains in the backlog. Proposed 2026-10-19, after the
release-defaults review. Antigravity work moved to
`dev/implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md`.

## Status (2026-10-26)

- **Shipped:** the noisy Codex log line ("does not support granular tool patterns" on every
  run with a tool list) was removed from `CodexToolPermissionMapper.buildCodexSpecificArgs()`
  in `5c255d3b0`. The runtime mapper's `prepare()` already reports only the deny entries that
  `foldMcpToolDenialsIntoServers` could not fold (`.unfolded`).
- **Remaining:** Codex harness tests for the "needs a test" questions, the per-entry
  dashboard check, and Codex shell rules.

## Goal

Give Codex granular `allowedTools` / `deniedTools` support comparable to the other
harnesses, so a workflow's tool lists behave more consistently across harnesses.

## Where things stand

- **Codex** enforces `deniedTools` entries of the form `mcp__<server>__<tool>`, but only for
  servers the workflow attaches. `CodexHarnessAdapter` folds them into that server's
  `disabled_tools` (`foldMcpToolDenialsIntoServers` in `src/utils/ToolPermissionUtils.ts`). It
  enforces no shell or built-in tool patterns, and no allow list.
- A tool list that is still the shipped default shows an information note, not a warning
  (`isShippedDefaultToolList`). This keeps new users from seeing warnings about defaults they
  never chose. Any list they edit still warns.

Codex has a real rule engine, but no per-run rule delivery. Rules load only from config files,
unlike OpenCode, which reads its config from `OPENCODE_CONFIG_CONTENT`.

## Research (2026-10-19)

The findings below were checked against Codex 0.162.1 on Windows. "Verified" means confirmed
in the docs, the CLI's help, or an offline CLI check. Nothing here started a model session.

### Codex

- **Command rules.** These are `.rules` files written in Starlark:
  `prefix_rule(pattern=["git","push"], decision="forbidden", justification="…")`. A decision
  is `allow`, `prompt` or `forbidden`, and the most restrictive match wins. Verified with
  `codex execpolicy check`: a `["git","push"]` forbidden rule beat a `["git"]` allow rule.
  Source: <https://learn.chatgpt.com/codex/rules>, which says "Rules are experimental and may
  change."
- **Where rules load from.** The `rules/` folder in each config layer: `~/.codex/rules/*.rules`,
  and `<repo>/.codex/rules/` only when the project is trusted. No config key or flag points
  Codex at an extra rules file (verified). `codex exec --ignore-rules` turns rules off.
- **Headless denial.** A forbidden command returns "`<cmd>` rejected: <justification>" to the
  model, and the run continues. Under the approval policy `never`, a `prompt` decision becomes
  forbidden. This comes from reading the source (`codex-rs/core/src/exec_policy.rs`); I didn't
  run it.
- **Whether `forbidden` rules hold under `--dangerously-bypass-approvals-and-sandbox`.** Not
  documented. The forbidden path never consults the sandbox, so they probably do still apply.
  Needs a test.
- **Permission profiles (beta, about 0.138 and later).** `[permissions.<name>.filesystem]`
  maps paths and globs to `read`, `write` or `deny`, and the same section can allow or deny
  network domains. Profiles can't be combined with `--sandbox` or `sandbox_mode`. Source:
  <https://learn.chatgpt.com/docs/permissions>.
- **MCP tool filters.** Already used; see "Where things stand". An override that names a server
  Codex has no transport for makes Codex refuse to start ("invalid transport in
  `mcp_servers.<id>`", verified). That is why only servers the workflow attaches get filters.

## How rules could reach the CLI

### Codex

- **A. Temporary global rules file.** Write `~/.codex/rules/ctrlyoke-<runId>.rules`, then
  delete it when the run ends.
  - Every other Codex session that starts while the file exists, including the user's own,
    picks it up.
  - Codex reads rules only at startup, so a crash that skips cleanup leaves the rules behind
    for future sessions. A startup sweep of stale `ctrlyoke-*.rules` files would have to clean
    them up.
- **B. Redirect `CODEX_HOME`.** Point it at a temp directory that holds the rules.
  - `CODEX_HOME` also moves `auth.json`, `config.toml`, session logs and the user's own rules,
    so all of them would need copying or linking in.
  - `CodexLogParser` reads session logs from `CODEX_HOME`, so it would have to follow the
    redirect.
- **C. Project rules.** Write the rules into `<workspace>/.codex/rules/`. This only works in a
  trusted project, and it writes into the user's repo. That goes against the rule in
  `harness-adapters.instructions.md` that ctrlyoke passes per-run config without touching
  workspace files. Rejected.

Lean towards A, plus a lease and a stale-file sweep, but only once Codex rules are no longer
experimental.

Translating ctrlyoke patterns into Codex rules:

- A `shell(cmd:*)` entry becomes `prefix_rule(pattern=[...cmd tokens], decision=...)`:
  `forbidden` for a deny entry, `allow` for an allow entry.
- A Codex rule pattern is a literal token prefix. So a wildcard that isn't at the end, a
  wildcard in the middle of a command, or a non-shell built-in tool name can't be expressed.
  Report those through `createLossyTranslationDiagnostic`, the way Qwen does.
- Keep the read-only sandbox clamp that `custom` already applies when it denies a
  write-capable tool.

## Also to fix

- **The dashboard is less precise than the runtime for Codex.** Codex declares its deny-list
  support as "partial" (`CodexToolPermissionMapper`'s capabilities), and the dashboard works
  from that declaration (`CompatibilityAnalyzer`'s `permissionFields`). So a deny list made
  only of MCP entries Codex enforces still gets a "partially translated" warning in the editor,
  while the run itself reports nothing. To match, the analyzer would call
  `foldMcpToolDenialsIntoServers` (with `CODEX_FOLD_EXCLUDED_SERVER_IDS`) on each step's
  attached servers, the way `CodexToolPermissionMapper.prepare()` does at runtime.

## Phases

1. Write the "needs a test" Codex `forbidden` check under the bypass flag as an opt-in harness
   test (`npm run test:harness`).
2. Make the dashboard's Codex check per-entry (see "Also to fix").
3. Implement Codex shell rules (option A) once rules are no longer experimental. Then update the
   capability declaration, `docs/workflows/permissions.md` and `docs/harnesses/codex-cli.md`,
   and regenerate the compatibility docs.
