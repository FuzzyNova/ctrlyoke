# Antigravity Permission Rules (Full Translation)

**Status:** Not started. Written 2026-10-30 against current code and agy 1.4.12.
**Priority:** P1. Commit message generation is broken on Antigravity until phase 2 lands.

Supersedes the Antigravity half of `CODEX_ANTIGRAVITY_PERMISSION_RULES_PLAN.md`. That plan
was blocked on "no per-run delivery" for rules. agy's `--settings` flag removes the blocker.

## Problem

Antigravity is the only harness that ignores `allowedTools` and `deniedTools` entirely. The
mapping in `AntigravityToolPermissionMapper.prepare()` is coarse:

| ctrlyoke mode         | agy today                        | Effect                                                                         |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `dangerouslyAllowAll` | `--dangerously-skip-permissions` | Correct.                                                                       |
| `allowAll`            | no flag (agy `request-review`)   | Not "allow all": shell, URLs and MCP tools ask, and headless soft-denies them. |
| `custom`              | `--sandbox`                      | Both lists ignored. Everything not auto-allowed is soft-denied.                |
| `none`                | no flag                          | Correct.                                                                       |

The capability declaration says so honestly (`allowedTools`/`deniedTools`
`fidelity: "unsupported"`), and the dashboard warns. But the practical cost is real:

- **Commit message generation fails on Antigravity.** It runs headless in `custom` mode
  allowing only `mcp__ctrlyoke-commit__submit_commit_message`. agy refuses the call
  (`permission check failed for mcp "ctrlyoke-commit/submit_commit_message": user denied
permission for mcp(ctrlyoke-commit/submit_commit_message)`). The run still exits 0, so the
  message is silently never submitted. `src/test/harness/commit-permissions.harness.test.ts`
  fails for `antigravity-cli` until this plan lands. That failure is correct.
- A workflow's tool lists mean something different on Antigravity than on the other five
  harnesses.
- Deny lists, including the shipped default (`shell(sudo:*)`, `shell(git push:*)`, …), are
  not enforced at all.

## What changed in agy (verified 2026-10-30, agy 1.4.12, Windows 11)

### `--settings` delivers rules per run

`agy --help`: `--settings  Settings for this session only, never saved: a JSON object of
settings.json keys, inline or as a file path`. This flag is not in the public docs or the
changelog, so the version that introduced it is unknown (see phase 0).

All of the following were checked with `agy -p "/permissions" --settings <file>`. Print mode
answers `/permissions` without starting a model turn, so it costs no quota.

- `permissions.allow`, `permissions.ask` and `permissions.deny` are all read from `--settings`.
  Rules from `--settings` are listed under the `global` scope.
- **Merging is per list, not per rule.** With the user's `settings.json` holding
  `allow: ["command(npm run)"]`:
  - `--settings {"permissions":{"deny":["command(rm)"]}}` lists the user's allow rule **and**
    the new deny rule.
  - `--settings {"permissions":{"allow":[…]}}` lists only the new allow rules. The user's
    `command(npm run)` is gone for that session.

  So a list ctrlyoke sets replaces the user's global list of the same name. That is harmless
  for `allow` in a headless run, but **replacing `deny` would drop the user's own denials**.
  The translation must union the user's global lists into its own (see "Merging with the
  user's rules").

- **Rule kinds are not validated.** `frobnicate(x)`, `shell(ls)` and `view_file(**)` are all
  accepted and listed. A wrong kind silently does nothing, so every kind ctrlyoke emits needs
  a behavioral harness test, not just a `/permissions` check.

### The rules are enforced on Windows

The older plan recorded that "the new rules engine is macOS/Linux only; Windows still uses the
older `toolPermission` setting". That is out of date. On Windows 11 (26200), with commit
generation's exact settings and the probe MCP server, changing only the `--settings` allow list
flipped the result:

| `--settings`                                                               | Result                     |
| -------------------------------------------------------------------------- | -------------------------- |
| `{"permissions":{"allow":["mcp(ctrlyoke-commit/submit_commit_message)"]}}` | Tool called.               |
| `{"permissions":{"allow":[]}}`                                             | `user denied permission …` |

### Rule grammar (from <https://antigravity.google/docs/permissions?tab=cli>)

Rules are `action(target)`. Precedence is **Deny > Ask > Allow**, independent of order, and
explicit rules beat defaults. Per the modes page, explicit rules keep precedence in every
execution mode, including `always-proceed` (`--dangerously-skip-permissions`). The settings
page says "Deny rules apply in every mode".

| Kind          | Targets                                             | Default                         |
| ------------- | --------------------------------------------------- | ------------------------------- |
| `read_file`   | `/abs/path`, `rel/dir` (recursive), `*`             | Ask (auto-allowed in workspace) |
| `write_file`  | `/abs/path`, `rel/dir`, `*`                         | Ask (auto-allowed in workspace) |
| `read_url`    | `domain` (covers subdomains), `*`                   | Ask                             |
| `execute_url` | `domain`, `*` (browser clicks and typing)           | Ask                             |
| `command`     | literal word-by-word prefix, `regex:<pattern>`, `*` | Ask                             |
| `unsandboxed` | as `command`; business/enterprise accounts only     | Ask                             |
| `mcp`         | `server/tool`, `server/*`, `*`                      | Ask                             |

- Write implies read. Denying a read implies denying a write.
- Relative file targets are relative to the workspace roots. On Windows, drive letters are
  stripped and `\` becomes `/` before matching.
- Globs inside a path (`src/**/*.ts`) are not documented. Only a whole-target `*`, a directory
  target and a trailing `/*` on MCP targets are.
- `command` prefix matching survives pipelines, `&&`, `||`, `;`, quoting, `$VAR` and simple
  redirects. Command substitution, backticks, process substitution, brace expansion and
  similar constructs force an exact or full-line `regex:` match. On Windows, commands that
  can't be split cleanly also need an exact match.
- `toolPermission` (a settings key, so also settable via `--settings`) is the base policy:
  `request-review` (default), `proceed-in-sandbox`, `strict`, `always-proceed`.
- Headless: an action that needs approval is soft-denied. The run continues, exits 0 and
  prints a notice. Since 1.1.5, `-p` honors `settings.json` policies.

### The terminal sandbox (from <https://antigravity.google/docs/sandbox?tab=cli>)

The sandbox and the permission rules are not independent in agy:

- **Ways to turn it on:**
  - `--sandbox` (per session, overrides `settings.json`);
  - `"enableTerminalSandbox": true` (default `false`);
  - `"toolPermission": "proceed-in-sandbox"` (sandboxed commands run without asking, and
    commands that leave the sandbox still ask);
  - `--mode auto` / `"agentMode": "auto"` (sandbox on, plus a reviewer agent that approves
    safe out-of-sandbox commands). Auto is not available to business accounts.
- **It contains terminal commands only.** Whether file tools or MCP servers go through it is
  undocumented.
- **What it restricts:**
  - Commands can write the workspace, temp dirs and build caches. `~/.ssh` and `.env` are
    blocked.
  - Network is off by default.
  - On Windows (an AppContainer), folders outside the user profile are read-only, and the
    rest of the profile is hidden.
- **The permission rules configure it.** There are no separate sandbox rules:
  - `read_file` paths are mounted read-only.
  - `write_file` paths are mounted read-write.
  - `read_url` domains join the outbound network allowlist.
  - Denied paths are blocked.
  - A `command` allow rule lets that command run _outside_ the sandbox without asking
    (business accounts use `unsandboxed(...)` instead).
- **Platforms:**
  - Linux uses namespaces, and macOS uses `sandbox-exec`.
  - Windows needs Windows 11 24H2 with the August 2026 update.
  - Where the sandbox can't run (Windows 10, older Windows 11, some Linux containers),
    `--sandbox` and `enableTerminalSandbox` **silently do nothing**, and
    `proceed-in-sandbox` acts like `request-review`.
- **Headless:** a command that needs to leave the sandbox is undocumented. It is presumably
  soft-denied like any other unapproved action.

Consequences for this plan, once rules are translated:

- `shell(git push:*)` in `allowedTools` becomes `command(git push)`, which runs _outside_ the
  sandbox. So "custom + `--sandbox`" doesn't sandbox the commands the workflow explicitly
  allowed. It sandboxes only the commands that would have been soft-denied anyway.
- An allowed command that needs the network fails inside the sandbox unless ctrlyoke also
  emits `read_url` rules, and ctrlyoke's lists can't express those today.
- On machines without sandbox support, ctrlyoke's `custom` mode silently gets no sandbox at
  all.

## Proposal

### Delivery

`AntigravityToolPermissionMapper.prepare()` builds a settings object and returns it as
`--settings <path>`:

- Write the JSON to a per-run file under `.ctrlyoke/temp/` (owned by `TempFileManager`) and
  pass the absolute path. Don't pass inline JSON: it would cross `parseArgString` and, for
  interactive spawns, the PTY's shell quoting.
- Register the file for cleanup through the provider's existing
  `getAdditionalCleanupFilePaths()` path, so parallel workflows don't delete each other's
  file early.
- Emit no `--settings` for `none` and `dangerouslyAllowAll`, and when the computed object is
  empty.
- If the workflow's `additionalArgs` already contains `--settings`, don't emit a second one.
  Report a compatibility diagnostic saying ctrlyoke's permission translation was skipped
  because the workflow supplies its own session settings. (Whether agy takes the first or last
  `--settings` is unverified; don't depend on either.)

### Mode mapping

| ctrlyoke mode         | agy flags / settings                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `dangerouslyAllowAll` | `--dangerously-skip-permissions` (unchanged). Lists ignored, matching every other harness.                                     |
| `allowAll`            | `toolPermission: "always-proceed"` plus `permissions.deny` from `deniedTools`.                                                 |
| `custom`              | `toolPermission: "request-review"`, `permissions.allow` and `permissions.deny`. `--sandbox`: see "Sandbox is a separate axis". |
| `none`                | nothing                                                                                                                        |

- `allowAll` finally means what the schema says ("auto-grants all but respects deny list"),
  because deny rules hold under `always-proceed`. This fixes Gap 2 of
  `dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md` properly instead of by omission.
  `hasFullPermissions()` then returns true for `allowAll` too, which matches the base class
  and stops the headless warning for `allowAll` runs.
- Whether `custom` keeps `--sandbox` is not a permission-mapping question. See "Sandbox is a
  separate axis" below.
- Never emit `ask`. ctrlyoke has no ask list, and `request-review` already asks for
  everything not allowed. An empty `ask` list in `--settings` would also replace the user's.

### Translating patterns

A new `convertToAntigravityRules(patterns)` in the mapper returns rules plus lossy entries,
reported through `createLossyTranslationDiagnostic` the way Qwen does. Unknown tools are
**never passed through**: agy accepts any kind silently, so a pass-through would look enforced
and do nothing.

| ctrlyoke pattern                                                                         | agy rule                                   | Notes                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`, `bash`, `run_shell_command`, `shell(*)`, `shell(*:*)`                           | `command(*)`                               |                                                                                                                                                                                        |
| `shell(git push:*)`                                                                      | `command(git push)`                        | agy prefix is word-by-word, so `git push` does not match `git pushx`.                                                                                                                  |
| `shell(npm run test)` (exact, no `:*`)                                                   | `command(regex:npm run test)`              | Escape regex metacharacters. Verify that `regex:` is anchored to the whole line on the CLI (the docs only say so for the App). If not, emit `^…$`.                                     |
| `shell(git * main:*)` (inner wildcard)                                                   | `command(regex:git \S+ main(?: .*)?)`      | Same anchoring check. Lossy if the pattern can't be expressed.                                                                                                                         |
| `read`, `glob`, `grep`, `ls`, `list`, `list_directory`, `lsp`                            | `read_file(*)`                             | agy treats listing and searching as reads (verify in phase 0).                                                                                                                         |
| `read(<path>)`                                                                           | `read_file(<path>)`                        | Only if ctrlyoke patterns carry paths for read; otherwise lossy.                                                                                                                       |
| `write`, `edit`, `create`, `multiedit`, `multi_edit`, `patch`, `str_replace`             | `write_file(*)`                            | Write implies read on agy, so an allowed `write` also allows reads of the same path. Note it in the docs.                                                                              |
| `web_fetch`, `webfetch`, `web_fetch(<domain>)`                                           | `read_url(*)` / `read_url(<domain>)`       |                                                                                                                                                                                        |
| `browser`, `execute_url(<domain>)`                                                       | `execute_url(*)` / `execute_url(<domain>)` | Only if ctrlyoke has a browser tool name; otherwise skip the row.                                                                                                                      |
| `mcp__<server>__<tool>`                                                                  | `mcp(<server>/<tool>)`                     | Use `parseMcpPattern` (added in ~93aa1133e).                                                                                                                                           |
| `mcp__<server>`, `mcp__<server>__*`                                                      | `mcp(<server>/*)`                          |                                                                                                                                                                                        |
| server `deniedTools` (`McpServerConfig.deniedTools`)                                     | `mcp(<server>/<tool>)` in deny             | Set `formatMcpToolName` on the mapper and declare `mcp.perServerToolFiltering` exact/translated-cli, so `ExecutionPlanBuilder` merges them. This also closes Gap 1 of the parity plan. |
| `web_search`, `search`, `task`, `agent`, `skill`, `question`, `todo`, `delete`, `remove` | none                                       | Lossy diagnostic. Phase 0 checks whether agy has a rule kind for any of these.                                                                                                         |

Server ids: confirm whether agy normalizes MCP server names from `.agents/mcp_config.json`
(dots, spaces) before matching `mcp(server/tool)`. The opencode harness test uses
`opencode.probe-server` for exactly this. Mirror it.

### Merging with the user's rules

Because `--settings` replaces each list it sets, ctrlyoke must union the user's own global
lists into the ones it emits. Otherwise a workflow with a deny list would silently drop the
user's own `deny` rules for the session. That is a safety regression.

- Read `permissions.{allow,deny}` from `~/.gemini/antigravity-cli/settings.json` (the same
  file `StatuslineManager` already resolves for the `antigravity-cli-settings` tracker;
  single-source that path). Tolerate a missing
  or malformed file: agy itself ignores unparseable rules.
- Emitted `deny` = user `deny` ∪ translated `deniedTools`.
- Emitted `allow`:
  - `custom`: user `allow` ∪ translated `allowedTools`. The user already trusts those rules
    in their own sessions, and since Deny > Allow, a ctrlyoke deny still wins.
  - `allowAll`: don't emit `allow`. `always-proceed` already allows.
- Don't touch `ask`. If the user has an `ask` rule that matches an allowed tool, Ask beats
  Allow, and headless soft-denies it. Detect the overlap and report a diagnostic naming the
  user's rule. Don't silently override the user's choice.
- Verify that project and shared scopes are unaffected by `--settings` (the probe only showed
  global rules). If they are separate, document that a project-scope deny still applies.

### Version floor

Raise `versionPolicy.minimum` in `AntigravityCliProvider` to the first agy release with
`--settings` (phase 0), and `testedWith` to the version the harness tests ran against
(1.4.12 or later). Nathan approved raising the floor for this.

- Update the comment above `versionPolicy` with the reason.
- Regenerate `docs/harnesses/compatibility.md` (its "Minimum" row currently says 1.2.6) with
  `npm run generate-compatibility-docs`.
- Update `dev/reference/HARNESS_VERSION_SUPPORT.md` if it records the Antigravity floor.
- Note the new minimum under **Changed** in `CHANGELOG.md`.

### Capability declarations

In `ANTIGRAVITY_PERMISSION_CAPABILITIES`:

- `mode`: `exact`, `translated-cli`, once `allowAll` maps to `always-proceed`. Drop the
  `COARSE_PERMISSION_MODES` caveat.
- `allowedTools` / `deniedTools`: `partial`, `translated-cli`, with a caveat code for the
  untranslatable tools (or `exact`, if phase 0 finds a rule kind for every ctrlyoke tool).
- `verification`: point at the new harness tests.

Then regenerate the compatibility docs and re-check
`src/test/unit/HarnessCapabilityRegistry.test.ts` and the "Cross-mapper consistency" suite in
`HarnessToolPermissionMappers.test.ts`.

### Interactive runs and terminal reuse

The `--settings` file is a spawn-time property, like `--sandbox`. `CliIntegration`'s
terminal-reuse compatibility check already compares `toolPermissions`. Confirm that a change
in the effective rules retires the PTY rather than reusing a terminal that was started with
old rules. Keep the file alive for the life of the PTY, not just the prompt.

## Phases

0. **Research (no code).** Each check below is cheap: `/permissions` costs nothing, and a
   one-tool headless probe costs a few cents. The throwaway probe used for this plan built a
   workflow from `buildCommitWorkflowOverrides`, set `additionalArgs: "--settings <file>"`
   and ran it through `runWorkflowFile`. Reuse that shape.
   - Find the first agy release with `--settings`, from the
     `google-antigravity/antigravity-cli` GitHub releases, or by installing older builds if
     `agy update` can pin a version.
   - Whether `regex:` is full-line anchored on the CLI.
   - Which rule kind gates agy's search, glob/list and web-search tools. Run a probe with
     everything denied and read the denial notices.
   - MCP server-id normalization for ids with dots.
   - Whether project and shared scopes survive `--settings`.
   - Deny under `--dangerously-skip-permissions`, and allow/deny under `--sandbox`.
   - What two `--settings` flags do.
   - Record the findings in this file.
1. **Mapper and delivery.** Mode mapping, pattern translation, `--settings` file, union with
   the user's lists, lossy and ask-overlap diagnostics, server `deniedTools`, `hasFullPermissions`.
   Unit tests in `src/test/unit/HarnessToolPermissionMappers.test.ts` (the Antigravity suite)
   for every table row above, the merge rules and the `additionalArgs` collision.
2. **Version floor and capabilities.** Bump `minimum`/`testedWith`, flip the declarations,
   regenerate the compatibility docs, update the capability registry tests.
3. **Harness tests** (opt-in, `npm run test:harness`). Run only the new cases while
   developing.
   - `commit-permissions.harness.test.ts` passes for `antigravity-cli`. This is the
     acceptance test for the commit-generation bug.
   - In `inline-config.harness.test.ts`, mirror the OpenCode permission cases for
     Antigravity: allow proceeds, deny blocks, deny wins over allow, a deny survives a
     conflicting user `settings.json` (in an isolated `HOME` copy, never the real one), an
     MCP tool allowed by exact and whole-server patterns, and a denied MCP tool with a dotted
     server id.
   - `allowAll` runs a shell command without asking and still refuses a denied one.
4. **Docs and changelog.** `docs/workflows/permissions.md` (the per-harness table, and the
   paragraphs saying Antigravity ignores both lists), `docs/harnesses/antigravity-cli.md`, and
   `CHANGELOG.md` under **Changed** (lists are now enforced on Antigravity, `allowAll`
   auto-approves, the new minimum version). Run `npm run check:docs`.
5. **Clean up the older plan.** Remove the Antigravity sections from
   `CODEX_ANTIGRAVITY_PERMISSION_RULES_PLAN.md`, leaving Codex only.

## Compatibility

- No workflow or settings schema change: the fields already exist and are documented as
  translated per harness.
- **Behavior change users will notice:** on Antigravity, `custom` lists start being enforced,
  and `allowAll` starts auto-approving. A workflow that relied on Antigravity ignoring its
  deny list will now hit those denials. This goes under **Changed**.
- Raising the minimum agy version blocks older installs with the existing version-policy
  message and `agy update` as the fix.

## Sandbox is a separate axis (undecided)

`custom` → `--sandbox` dates from when agy had no granular rules. Mapping to `--sandbox` was
the closest available stand-in for "restricted". That mixes two different controls:

- **Permissions (approval):** which actions run without asking. This is what
  `toolPermissions.mode` and the tool lists describe on every harness.
- **Sandboxing (containment):** what a command can touch _when it runs_ (files, network).

Folding containment into the permission mode produces a different end result per harness for
the same workflow. A `custom` run is OS-sandboxed on Antigravity, sandboxed by
`codexSandboxMode` on Codex, and not sandboxed anywhere else. Users can't see this from the
workflow, as the surprise that prompted this section shows.

Codex has the same coupling. "What we did for Codex" is not a free-standing toggle:
`CodexToolPermissionMapper.resolveSandboxMode()` derives the sandbox from the mode:

- `allowAll` forces `workspace-write`.
- `dangerouslyAllowAll` uses `--dangerously-bypass-approvals-and-sandbox`, which turns off
  both controls in one flag.
- Only `custom` reads `permissions.codexSandboxMode`, clamped to `read-only` when a
  write-capable tool is denied.

Native sandbox controls, checked from each CLI's `--help` (2026-10-30):

| Harness     | Native sandbox                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Codex       | `-s read-only \| workspace-write \| danger-full-access`. Independent of `-a` approvals, except for the bypass flag.    |
| Antigravity | `--sandbox`, `enableTerminalSandbox`, `proceed-in-sandbox`, `--mode auto` (above).                                     |
| Copilot     | `copilot sandbox` subcommand ("Manage command sandboxing"). Flags and semantics not yet checked.                       |
| Qwen        | `-s, --sandbox true \| false \| docker \| podman \| sandbox-exec`. Container-style; a different model from the others. |
| Claude      | No CLI flag in `--help`. A settings-file sandbox may exist; unverified.                                                |
| OpenCode    | None found.                                                                                                            |

Options:

1. **A workflow `sandbox` property** (plus a `defaults.sandbox` user setting), independent of
   `toolPermissions.mode`. It is mapped per harness, and the existing capability and
   compatibility-diagnostic machinery reports harnesses that can't honor it (OpenCode, maybe
   Claude). A workflow then states containment explicitly and gets the same intent
   everywhere it can be honored.
2. **Per-harness settings toggles** ("Enable Antigravity sandbox", like `codexSandboxMode`).
   This needs less design, but it repeats today's problem: containment is invisible in the
   workflow and differs by harness.
3. **Status quo:** keep `custom` → `--sandbox`.

Recommendation: option 1. Semantics would be one level to start (`sandbox: true` means
"terminal commands may write only the workspace and temp dirs, with no network unless
allowed"), mapped to Codex `workspace-write`, agy `--sandbox`, and whatever Copilot's sandbox
supports. Leave Qwen's container backends as harness-specific options. It needs its own plan
(`dev/backlog/HARNESS_SANDBOX_PLAN.md`), because:

- it is an additive schema property (`npm run schema:update`);
- `codexSandboxMode` needs a compatibility path (kept as a Codex-specific override, or
  migrated);
- Codex's `--dangerously-bypass-approvals-and-sandbox` would have to become `-a never` plus an
  explicit `-s`, so the two axes really separate;
- the "silently no effect" platforms (agy below Windows 11 24H2) need a diagnostic.

**Interim for this plan:** don't change agy's sandbox behavior as a side effect of translating
rules. Keep `custom` → `--sandbox` until the sandbox decision lands, then move it in that
plan's commit, under **Changed**. If the sandbox plan is rejected, remove `--sandbox` from
`custom` here instead, so Antigravity's `custom` means the same as on other harnesses.

## Open questions

- **`unsandboxed` rules** apply only to business and enterprise accounts. ctrlyoke can't tell
  the account type, so emit only `command` rules.
- **Path-scoped file rules.** ctrlyoke's `read`/`write` patterns carry no paths today. If they
  ever do, agy's directory targets are a natural fit, but in-path globs are undocumented.
