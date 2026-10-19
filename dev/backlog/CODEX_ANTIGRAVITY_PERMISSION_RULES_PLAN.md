# Codex and Antigravity Permission Rules Plan

**Status:** backlog, not started. Proposed 2026-10-19, after the release-defaults review.

## Goal

Give Codex and Antigravity the same granular `allowedTools` / `deniedTools` support that
Copilot, Claude, Qwen and OpenCode have, so a workflow's tool lists mean the same thing on
every harness.

## Where things stand

- **Codex** enforces `deniedTools` entries of the form `mcp__<server>__<tool>`, but only for
  servers the workflow attaches. `CodexCliProvider` folds them into that server's
  `disabled_tools` (`foldMcpToolDenialsIntoServers` in `src/types/ToolPermissionUtils.ts`). It
  enforces no shell or built-in tool patterns, and no allow list.
- **Antigravity** enforces neither list. Its mode mapping is coarse: `allowAll` passes no
  flag, and `custom` passes `--sandbox`.
- A tool list that is still the shipped default shows an information note on these harnesses,
  not a warning (`isShippedDefaultToolList`). This keeps new users from seeing warnings about
  defaults they never chose. Any list they edit still warns.

Both CLIs now have real rule engines. The problem is getting rules to them: **neither CLI
accepts rules per run.** Rules load only from config files, unlike OpenCode, which reads its
config from `OPENCODE_CONFIG_CONTENT`.

## Research (2026-10-19)

The findings below were checked against Codex 0.162.1 and agy 1.4.2 on Windows. "Verified" means
confirmed in the docs, the CLI's help, or an offline CLI check. Nothing here started a model
session.

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

### Antigravity (agy)

- **Flags.** `--dangerously-skip-permissions`, `--sandbox`, and `--mode accept-edits|plan`.
  `--mode` is new and ctrlyoke doesn't use it yet.
- **Rule syntax.** A `permissions: { allow, deny, ask }` block. Entries look like
  `command(git push)` (a literal, word-by-word prefix; `command(regex:…)` and `command(*)` also
  exist), `write_file(src/)`, and `mcp(server/tool)` or `mcp(server/*)`. Precedence is Deny >
  Ask > Allow. Source: <https://antigravity.google/docs/permissions?tab=cli>.
- **Where rules load from.** Only `~/.gemini/antigravity-cli/settings.json` is documented. The
  `/permissions` panel in the terminal UI shows Project, Shared and Global scopes, but the docs
  don't give the file paths for the first two
  (<https://antigravity.google/docs/cli/commands/permissions>). There is no flag or env var for
  rules (<https://antigravity.google/docs/cli/headless/>).
- **Headless behaviour.** A tool that needs approval is soft-denied: the run continues, exits
  0, and prints a notice to stderr. Shell commands default to Ask, so they are soft-denied
  headless. How an explicit deny behaves headless isn't documented.
- **Under `--dangerously-skip-permissions`.** Headless runs report `permission_mode`
  `always-proceed`, so deny rules may be ignored. Needs a test.
- **Windows.** The new rules engine is macOS/Linux only. Windows still uses the older
  `toolPermission` setting, and its sandbox is in preview.

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
  `harness-cli-providers.instructions.md` that ctrlyoke passes per-run config without touching
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

### Antigravity

There is no per-run delivery that doesn't touch the user's state:

- Merging a ctrlyoke-tagged block into the global `settings.json` and restoring it afterwards
  is invasive, and it races with other agy sessions.
- Redirecting `HOME` breaks login, because `oauth_creds.json` lives under `~/.gemini`.

Wait for one of these:

- a flag or env var for rules;
- documented project-scope rule paths;
- the rules engine reaching Windows.

## Also to fix

- **The dashboard is less precise than the runtime for Codex.** Codex declares its deny-list
  support as "partial", and the dashboard works from that declaration. So a deny list made
  only of MCP entries Codex enforces still gets a "partially translated" warning in the editor,
  while the run itself reports nothing. To match, the analyzer would call
  `foldMcpToolDenialsIntoServers` with each step's attached servers, the way the Codex mapper
  does at runtime.
- **A noisy Codex log line.** `CodexToolPermissionMapper.buildCodexSpecificArgs()` logs "does
  not support granular tool patterns" on every run that has any list, including the shipped
  defaults. Drop it, or limit it to entries Codex can't enforce.

## Phases

1. Write the two "needs a test" checks above as harness tests (`npm run test:harness`, opt-in
   only): Codex `forbidden` under the bypass flag, and agy deny rules in headless runs and
   under the bypass flag.
2. Make the dashboard's Codex check per-entry (see "Also to fix").
3. Implement Codex shell rules (option A) once rules are no longer experimental. Then update the
   capability declaration, `docs/workflows/permissions.md` and `docs/harnesses/codex-cli.md`,
   and regenerate the compatibility docs.
4. Revisit Antigravity when per-run or project-scope rules exist, or the rules engine reaches
   Windows.
