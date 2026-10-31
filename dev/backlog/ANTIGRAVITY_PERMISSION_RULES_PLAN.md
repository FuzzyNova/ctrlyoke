# Antigravity Permission Rules (Full Translation)

**Status:** Ready to implement. Phase 0 research finished 2026-10-31 against agy 1.4.10 and
1.4.12 on Windows 11 (26200). Results are under "Phase 0 findings".
**Priority:** P1. Commit message generation is broken on Antigravity until phase 1 lands.

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

## Phase 0 findings (2026-10-31)

Probes ran on Windows 11 (26200) against agy 1.4.12 on `PATH` and 1.4.10 from GitHub
releases. Each behavioral probe was one headless turn
(`agy -p <prompt> --model gemini-3.8-flash-low --output-format stream-json --settings <file>`)
in its own empty workspace. A tool was allowed if the `step_update` with `step_type: "tool"`
reached `state: "DONE"`, and denied if it reached `state: "ERROR"` with a denial message.
`-p "/permissions"` and `-p "/config"` answer without a model turn, so they cost nothing.

> Run agy from PowerShell, or with `MSYS_NO_PATHCONV=1`. Git Bash rewrites the argument
> `/permissions` into `C:/Program Files/Git/permissions`, which starts a model turn instead.

### Version floor: 1.4.10

- **1.4.10 (released 2026-10-29) is the first release with `--settings`.** The flag is in
  1.4.10's `--help`. 1.4.9 rejects it: `flags provided but not defined: -settings`. 1.2.6,
  1.3.6 and 1.4.6–1.4.9 don't list it either. `agy changelog` never mentions the flag.
- 1.4.10 behaves like 1.4.12 for everything this plan uses: the per-list merge, setting
  `toolPermission`, the MCP allow that commit generation needs, and a regex deny of a chained
  command under `--dangerously-skip-permissions`.
- Release binaries are at
  `gh release download <ver> -R google-antigravity/antigravity-cli -p agy_cli_windows_x64.zip`.
  The executable inside is named `antigravity.exe`, not `agy.exe`.

### `--settings` delivery

- The value is inline JSON or a file path. Absolute paths, relative paths (from the cwd) and
  paths containing spaces all work.
- **A missing or malformed file exits 1** before anything runs:
  `Error: reading --settings file: open …: The system cannot find the file specified.` or
  `Error: --settings must be a JSON object of settings.json keys: unexpected end of JSON input`.
  The file must exist for the whole life of the process.
- **With two `--settings` flags, the last one wins outright.** The two files aren't merged.
- Any `settings.json` key works. `toolPermission` and `permissions` from `--settings` both
  show up in `-p /config`.
- **Interactive (PTY) sessions honor it.** The `/permissions` Global view lists the injected
  rules, and an injected deny blocked a command.
- **Injected rules never leak into the user's file.** In a session started with `--settings`,
  a global rule the user added through `/permissions` was saved to `settings.json`. Neither
  the injected deny nor the injected allow list was written, and the user's original allow
  rules were kept. agy writes edits against the on-disk file, not its merged view.
- agy logs the effective global lists once per run in
  `~/.gemini/antigravity-cli/log/cli-*.log`:
  `cli_setting_manager.go:96] CLI settings initialized: permissions=&{Allow:[…] Deny:[…] Ask:[…]}, toolPermission=…`.
  This is the quickest way to debug a translation.

### Scopes and merging

- **Per-list replacement applies only to the global scope.** `--settings`
  `permissions.allow` replaces the user's global `allow`, and the same goes for `deny`. Lists
  `--settings` doesn't set are kept. **An empty list wipes the user's list** (verified with
  `allow: []`).
- **The project and shared scopes are untouched by `--settings` and stay enforced:**
  - Shared is `userSettings.globalPermissionGrants.{allow,deny}` in
    `~/.gemini/config/config.json`. Its rules stay listed alongside injected ones.
  - Project is `permissionGrants.permissionGrants.{allow,deny}` in
    `~/.gemini/config/projects/<projectId>.json`. A project deny blocked a command headless,
    with or without `--settings`.
  - Both shapes were found by adding rules through the `/permissions` editor and diffing the
    files. Neither is documented.
- `-p /permissions` never lists project rules, even though they are enforced. Every CLI run
  resolved to `default-cli-project` unless `--project` was passed (log:
  `Backend project ID updated dynamically to: default-cli-project`).
- **Ask rules didn't block anything in the cases ctrlyoke cares about.** An `ask` rule
  identical to an `allow` rule let the command run headless under `request-review`. An `ask`
  rule was ignored under `always-proceed` too. Both contradict the docs ("Deny > Ask > Allow";
  `always-proceed` runs everything "except actions that match an ask or deny rule"). The
  docs can't be trusted on this, so the translation still never emits `ask`, but it needs no
  ask-overlap diagnostic.

### `command` rule matching (the important part)

- **On Windows, a literal target is an exact whole-line match, never a prefix.** Neither
  `command(echo)` nor `command(git)` matched `echo zzprobe42` or `git --version`, as allow or
  as deny. `command(echo zzprobe42)` did match that exact line. The docs hint at this:
  "To match a command and its subcommands on Windows, use the `regex:` prefix". Whether
  literal prefixes work on macOS and Linux is unverified. The translation doesn't depend on
  them.
- **`regex:` is anchored to the whole line.** `regex:echo .*` matched `echo zzprobe42`, but
  neither `regex:echo` nor `regex:cho zzprobe42` did. The regex flavor is Go RE2: `(?i)`
  works, and lookarounds and backreferences aren't available.
- **The line is not split into chain segments before matching (Windows, verified):**
  - `allow regex:echo .*` **also allowed `echo zz7 && whoami`**, which over-grants.
  - `deny regex:whoami` and `deny command(whoami)` **did not block `echo zz7 && whoami`**,
    which is a deny bypass.
  - A deny written as `regex:.*\bwhoami\b.*` blocked the chained line.
  - **`.` doesn't match a newline**, so a two-line command `echo zzline1\nwhoami` bypassed
    `.*\bwhoami\b.*`. Adding `(?is)` fixed it.
  - An allow that excludes chain metacharacters and newlines,
    ``regex:echo(?: [^;&|`$()<>\r\n]*)?``, allowed `echo zzprobe42` and refused both the
    `&&` chain and the two-line command.
- Deny messages name the kind as `unsandboxed(<line>)` outside the sandbox (even on a
  non-business account) and `command(<line>)` inside it. For example:
  `Permission denied for unsandboxed(echo zz7 && whoami). Matches user-configured deny rule.`
- `command(*)` as a deny blocks every command, including under
  `--dangerously-skip-permissions`.

### Deny under each mode

| Mode                                                | Deny `command(regex:…)` holds? |
| --------------------------------------------------- | ------------------------------ |
| `request-review` (default)                          | yes                            |
| `toolPermission: "always-proceed"` via `--settings` | yes                            |
| `--dangerously-skip-permissions`                    | yes                            |
| `--sandbox` (with `request-review`)                 | yes                            |

The early "deny ignored under `--dangerously-skip-permissions`" result came from a literal
`command(echo)` rule. It didn't match at all, so the mode wasn't the cause.

`--sandbox` with `request-review` and no allow rule still soft-denied `echo` headless. The
sandbox doesn't auto-run in-sandbox commands in that mode. That takes `proceed-in-sandbox`.

### Which kinds gate which tools

The `init` event of `--output-format stream-json` lists about 60 tool names, but the model
is only offered this set. It was the same for `gemini-3.8-flash-low`,
`gemini-3.8-flash-high` and `claude-sonnet-4-6`: `read_file`, `write_file`, `edit_file`,
`run_command`, `search_web`, `ask_question`, `invoke_subagent`, `define_subagent`,
`manage_subagents`, `manage_task`, `schedule` and `send_message`, plus `call_mcp_tool` when
MCP servers are configured. There is no list, glob or grep tool. The model lists and searches
through `run_command`.

| agy tool                                   | Gated by                            | Verified                                                                        |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------- |
| `read_file`                                | `read_file`                         | deny `read_file(*)` blocked it                                                  |
| `write_file`, `edit_file`                  | `write_file`                        | deny `write_file(*)` blocked both; `read_file` still worked                     |
| `run_command`                              | `command`                           | above                                                                           |
| `call_mcp_tool`                            | `mcp(server/tool)`                  | allow `mcp(ctrlyoke-probe/probe_tool)` let it run                               |
| `search_web`                               | **nothing**                         | ran under `toolPermission: "strict"` with `read_url(*)` and `command(*)` denied |
| subagent / task / schedule / message tools | no rule kind                        | not probed further                                                              |
| `read_url_content`, browser tools          | `read_url` / `execute_url` per docs | not offered to the model in these headless runs; unverified                     |

### MCP server ids

agy doesn't normalize server ids. It builds the tool name `mcp_<serverId>_<toolName>` and
drops any tool that fails `^[a-zA-Z0-9_-]{1,64}$` (`encountered invalid tool …` in agy's
log). So a server id or tool name containing a dot or a space loses **all** its tools
before permissions are even checked. This is a separate, existing bug, filed as
`dev/bugs/backlog/antigravity-mcp-dotted-server-id-drops-tools.md`. Hyphenated ids work:
`mcp(ctrlyoke-commit/submit_commit_message)` let the commit tool run on 1.4.10 and 1.4.12.

## Proposal

### Delivery

`AntigravityToolPermissionMapper.prepare()` builds a settings object and returns it as
`--settings <path>`:

- Write the JSON to a per-run file under `.ctrlyoke/temp/` (owned by `TempFileManager`) and
  pass the absolute path. Don't pass inline JSON: it would cross `parseArgString` and, for
  interactive spawns, the PTY's shell quoting.
- The file must exist until the agy process exits, because agy exits 1 on a missing file.
  For an interactive PTY that means the life of the PTY, not the prompt. Register it for
  cleanup through the provider's existing `getAdditionalCleanupFilePaths()` path (today it
  returns only `statusLineSnapshotPaths`), so parallel workflows don't delete each other's
  file early.
- Emit no `--settings` for `none`, and none when the computed object is empty. For
  `dangerouslyAllowAll`, emit one only when there is a deny list (see "Mode mapping").
- If the workflow's `additionalArgs` already contains `--settings`, don't emit a second one.
  The last flag wins outright, so either file would silently shadow the other. Report a
  compatibility diagnostic saying ctrlyoke's permission translation was skipped because the
  workflow supplies its own session settings.

### Mode mapping

| ctrlyoke mode         | agy flags / settings                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `dangerouslyAllowAll` | `--dangerously-skip-permissions` (unchanged). Lists ignored, matching every other harness.                                     |
| `allowAll`            | `toolPermission: "always-proceed"` plus `permissions.deny` from `deniedTools`.                                                 |
| `custom`              | `toolPermission: "request-review"`, `permissions.allow` and `permissions.deny`. `--sandbox`: see "Sandbox is a separate axis". |
| `none`                | nothing                                                                                                                        |

- `allowAll` finally means what the schema says ("auto-grants all but respects deny list"):
  deny rules hold under `always-proceed` (verified). This fixes Gap 2 of
  `dev/implemented/TOOL_PERMISSION_PARITY_PLAN.md` properly instead of by omission.
  `hasFullPermissions()` then returns true for `allowAll` too, which matches the base class
  and stops the headless warning for `allowAll` runs.
- `dangerouslyAllowAll` keeps ignoring ctrlyoke's lists, as on other harnesses. The user's
  own global deny list needs no help either: `--settings` isn't emitted, so their
  `settings.json` applies unchanged.
- Whether `custom` keeps `--sandbox` is not a permission-mapping question. See "Sandbox is a
  separate axis" below.
- Never emit `ask`. ctrlyoke has no ask list, and an `ask` list in `--settings` would replace
  the user's.

### Translating patterns

A new `convertToAntigravityRules(patterns, listKind)` in the mapper returns rules plus lossy
entries, reported through `createLossyTranslationDiagnostic` the way Qwen does.
**`listKind` matters: allow and deny rules for the same pattern are different regexes.**
Unknown tools are **never passed through**: agy accepts any kind silently, so a pass-through
would look enforced and do nothing.

#### Commands: always `regex:`, never literal

Literal targets are exact-match only on Windows, and agy matches the raw line without
splitting chains. So every `command` rule ctrlyoke emits is a `regex:` rule built per list.
Let `W` be the command's words, each RE2-escaped (`regexp.QuoteMeta` semantics) and joined
with `\s+`:

| ctrlyoke pattern                                               | allow rule                                      | deny rule                                           |
| -------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `shell`, `bash`, `run_shell_command`, `shell(*)`, `shell(*:*)` | `command(*)`                                    | `command(*)`                                        |
| `shell(git push:*)` (prefix)                                   | ``command(regex:W(?:\s[^;&\|`$()<>\r\n]*)?)``   | `command(regex:(?is)(?:.*[^\w.-])?W(?:[^\w.-].*)?)` |
| `shell(npm run test)` (exact, no `:*`)                         | `command(regex:W)`                              | same as the prefix deny                             |
| `shell(git * main:*)` (inner wildcard)                         | `*` becomes ``[^\s;&\|`$()<>\r\n]+`` inside `W` | `*` becomes `\S+` inside `W`                        |

(`\|` in the table is Markdown escaping. The emitted rule contains a plain `|`.)

Rationale:

- **Allow is strict.** The trailing character class refuses `;`, `&`, `|`, backticks, `$`,
  parentheses, redirects and newlines. A chain that contains an allowed command plus anything
  else is not allowed as a whole: it falls through to `request-review` and is soft-denied
  headless. That is stricter than harnesses that split chains, but never broader. Document it
  as the caveat on `allowedTools`.
- **Deny is broad.** `(?is)` makes `.` cross newlines and matching case-insensitive (Windows
  commands are). The `[^\w.-]` boundaries stop `git push` from matching `xgit push` or
  `git pushx` while still catching it after `&&`, `;`, `|`, a newline or `(`.
  Over-matching a deny (for example `echo "git push"`) is the safe direction.
- Only the `.*\bwhoami\b.*` and `(?is)` forms were probed. **The exact boundary expressions
  above must be covered by phase 3's harness tests before release.**
- Escape every regex metacharacter in the user's command words. A malformed RE2 pattern is
  probably ignored silently (agy ignores unparseable rules). Unit-test the generated strings
  against Go-compatible semantics. JavaScript `RegExp` is close enough for the tested
  constructs as long as only `(?is)` at the very start is used. JS has no inline flags, so
  strip the flag and pass `is` in tests.

#### Everything else

| ctrlyoke pattern                                                             | agy rule                             | Notes                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`                                                                       | `read_file(*)`                       | Verified.                                                                                                                                                                                                               |
| `glob`, `grep`, `ls`, `list`, `list_directory`, `lsp`                        | allow: `read_file(*)`; deny: lossy   | agy has no such tools. The model lists and searches through `run_command`, so a deny can't be enforced, and an allow needs a `shell(...)` rule to be useful. Lossy diagnostic either way, naming the shell rule to add. |
| `write`, `edit`, `create`, `multiedit`, `multi_edit`, `patch`, `str_replace` | `write_file(*)`                      | Verified for `write_file` and `edit_file`. Write implies read on agy, so an allowed `write` also allows reads of the same path. Note it in the docs.                                                                    |
| `web_fetch`, `webfetch`, `web_fetch(<domain>)`                               | `read_url(*)` / `read_url(<domain>)` | Not offered to the model headless, so not behaviorally verified. It also feeds the sandbox network allowlist. Keep it.                                                                                                  |
| `web_search`, `search`                                                       | allow: no rule; deny: lossy          | `search_web` is ungated on agy (verified under `strict`). It is always allowed, and a deny can't be enforced.                                                                                                           |
| `mcp__<server>__<tool>`                                                      | `mcp(<server>/<tool>)`               | Use `parseMcpPattern`. Verified for hyphenated ids. Use the same (sanitized) server id that `planMcpConfigArgs` writes; see the dotted-id bug.                                                                          |
| `mcp__<server>`, `mcp__<server>__*`                                          | `mcp(<server>/*)`                    | Grammar from the docs. Not probed: cover it in phase 3.                                                                                                                                                                 |
| server `deniedTools` (`McpServerConfig.deniedTools`)                         | `mcp(<server>/<tool>)` in deny       | Set `formatMcpToolName` on the mapper and declare `mcp.perServerToolFiltering` exact/translated-cli in `AntigravityCliProvider`, so `ExecutionPlanBuilder` merges them. This also closes Gap 1 of the parity plan.      |
| `task`, `agent`, `skill`, `question`, `todo`, `delete`, `remove`             | none                                 | Lossy diagnostic. agy has subagent/task tools but no rule kind for them.                                                                                                                                                |
| `browser`, `execute_url(<domain>)`                                           | skip                                 | ctrlyoke has no browser tool name, and agy doesn't offer browser tools headless.                                                                                                                                        |

### Merging with the user's rules

`--settings` replaces only the global `allow`/`deny` lists it sets. The project and shared
scopes are unaffected and stay enforced. So ctrlyoke unions just the user's **global** lists
into the ones it emits. Otherwise a workflow with a deny list would silently drop the user's
own global `deny` rules for the session, which is a safety regression.

- Read `permissions.{allow,deny}` from `~/.gemini/antigravity-cli/settings.json`. Today
  `StatuslineManager` builds that path inline for the `antigravity-cli-settings` tracker
  (`src/core/harness/shared/StatuslineManager.ts`). Hoist it into one exported helper and use
  it in both places. Tolerate a missing or malformed file, as agy itself ignores unparseable
  rules.
- Emitted `deny` = user `deny` ∪ translated `deniedTools`.
- Emitted `allow`:
  - `custom`: user `allow` ∪ translated `allowedTools`. The user already trusts those rules
    in their own sessions, and since Deny > Allow (verified), a ctrlyoke deny still wins.
  - `allowAll`: don't emit `allow`. `always-proceed` already allows.
- **Never emit an empty list.** `[]` wipes the user's list. Omit the key when the union is
  empty.
- Don't read or touch the project/shared files, and don't emit `ask`.
- In-session edits made by the user are saved against their own file, and the injected lists
  aren't persisted (verified). No cleanup of the user's `settings.json` is needed.

### Version floor

Raise `versionPolicy.minimum` in `AntigravityCliProvider` from `1.2.6` to **`1.4.10`** (the
first release with `--settings`), and `testedWith` from `1.4.5` to **`1.4.12`** (or whatever
the phase 3 harness run used). Nathan approved raising the floor for this.

- Update the comment above `versionPolicy`: "1.4.10 added `--settings`, which delivers
  per-run permission rules."
- Regenerate `docs/harnesses/compatibility.md` (its "Minimum" row currently says 1.2.6) with
  `npm run generate-compatibility-docs`.
- Update `dev/reference/HARNESS_VERSION_SUPPORT.md` where it discusses the Antigravity floor.
- Note the new minimum under **Changed** in `CHANGELOG.md`.

### Capability declarations

In `ANTIGRAVITY_PERMISSION_CAPABILITIES`:

- `mode`: `exact`, `translated-cli`. Drop the `COARSE_PERMISSION_MODES` caveat.
- `allowedTools` / `deniedTools`: `partial`, `translated-cli`, with a caveat code (new, in
  `PERMISSION_CAVEAT_CODES`) covering:
  - untranslatable tools: web search, subagents, list/search on deny;
  - allow being whole-line, so chained commands aren't allowed piecemeal.
- `verification`: change `ANTIGRAVITY_PERMISSION_VERIFICATION` from `[">=1.1.12"]` to
  `[">=1.4.10"]`, pointing at the new harness tests.

Then regenerate the compatibility docs and re-check
`src/test/unit/HarnessCapabilityRegistry.test.ts` and the "Cross-mapper consistency" suite in
`HarnessToolPermissionMappers.test.ts`.

### Interactive runs and terminal reuse

The `--settings` file is a spawn-time property, like `--sandbox`, and interactive sessions
honor it (verified). `CliIntegration`'s terminal-reuse compatibility check already compares
`toolPermissions`. Confirm that a change in the effective rules retires the PTY rather than
reusing a terminal started with old rules. That includes a change to the user's global lists
picked up by the union. Keep the file alive for the life of the PTY.

## Phases

0. **Research.** Done 2026-10-31; see "Phase 0 findings". Not covered, and left to phase 3:
   - literal-prefix behavior on macOS/Linux (the translation doesn't rely on it);
   - `mcp(server/*)`;
   - `read_url`;
   - the exact boundary regexes.
1. **Mapper and delivery.** Mode mapping, the per-list command regexes, the other pattern
   rows, the `--settings` file and its lifetime, the union with the user's global lists, the
   empty-list rule, lossy diagnostics, server `deniedTools`, and `hasFullPermissions`. Unit
   tests in `src/test/unit/HarnessToolPermissionMappers.test.ts` (the Antigravity suite) for:
   - every table row above, including the generated regex strings for allow and deny;
   - the regexes against sample lines: plain, `&&`, `;`, `|`, a newline, mixed case, and
     `git pushx`/`xgit push`;
   - the merge rules, including the user's file being missing or malformed;
   - the `additionalArgs` `--settings` collision.
2. **Version floor and capabilities.** Bump `minimum`/`testedWith`, flip the declarations,
   regenerate the compatibility docs, update the capability registry tests.
3. **Harness tests** (opt-in, `npm run test:harness`). Run only the new cases while
   developing. The probe shape that worked: a fresh workspace with `.agents/mcp_config.json`
   and the `buildMcpProbeServerScript()` server, headless `--output-format stream-json`, and
   tool steps judged by their final `state`. Prompts must name agy's real tool (`run_command`,
   `read_file`, `call_mcp_tool`), say "exactly once" and forbid alternatives.
   - `commit-permissions.harness.test.ts` passes for `antigravity-cli`. This is the
     acceptance test for the commit-generation bug.
   - In `inline-config.harness.test.ts`, mirror the OpenCode permission cases for
     Antigravity:
     - allow proceeds;
     - deny blocks;
     - deny wins over allow;
     - **a chained `echo … && <denied>` and a two-line command are blocked**;
     - **a chain that includes an allowed command plus an unlisted one is not allowed**;
     - a deny survives a conflicting user `settings.json` (in an isolated `HOME` copy, never
       the real one);
     - an MCP tool allowed by exact and by whole-server patterns.

     Skip the dotted-server-id case until the bug in
     `dev/bugs/backlog/antigravity-mcp-dotted-server-id-drops-tools.md` is fixed, or fix it
     first.

   - `allowAll` runs a shell command without asking and still refuses a denied one.
4. **Docs and changelog.**
   - `docs/workflows/permissions.md`: the per-harness table, and the paragraphs saying
     Antigravity ignores both lists. Add the whole-line allow caveat and the unenforceable
     web-search deny.
   - `docs/harnesses/antigravity-cli.md`.
   - `CHANGELOG.md` under **Changed**: lists are now enforced on Antigravity, `allowAll`
     auto-approves, and the new minimum version.

   Run `npm run check:docs`.

5. **Clean up the older plan.** Remove the Antigravity sections from
   `CODEX_ANTIGRAVITY_PERMISSION_RULES_PLAN.md`, leaving Codex only.

After phase 1, consider adding the `CLI settings initialized: permissions=…` log line and
the "regex rules see the raw unsplit line" gotcha to
`.github/instructions/harness-cli-providers.instructions.md`. Both are durable and not
discoverable from the code.

## Compatibility

- No workflow or settings schema change: the fields already exist and are documented as
  translated per harness.
- **Behavior change users will notice:** on Antigravity, `custom` lists start being enforced,
  and `allowAll` starts auto-approving. A workflow that relied on Antigravity ignoring its
  deny list will now hit those denials. This goes under **Changed**.
- Raising the minimum agy version blocks older installs with the existing version-policy
  message and `agy update` as the fix. Without the floor, agy 1.4.9 or older would fail with
  `flags provided but not defined: -settings`.

## Sandbox is a separate axis (decided)

**Decided 2026-10-30:** a workflow-level `sandbox` property, independent of
`toolPermissions.mode`, planned in `HARNESS_SANDBOX_PLAN.md`. Its phase 3 moves agy's
`--sandbox` off the permission mode.

Background: `custom` → `--sandbox` dates from when agy had no granular rules. Folding
containment into the permission mode gives the same workflow a different result per harness:
a `custom` run is OS-sandboxed on Antigravity, sandboxed by `codexSandboxMode` on Codex, and
not sandboxed anywhere else. The decision and the per-harness sandbox survey live in
`HARNESS_SANDBOX_PLAN.md`.

**Interim for this plan:** don't change agy's sandbox behavior as a side effect of
translating rules. Keep `custom` → `--sandbox` until the sandbox plan lands, then move it in
that plan's commit, under **Changed**. If the sandbox plan is rejected, remove `--sandbox`
from `custom` here instead, so Antigravity's `custom` means the same as on other harnesses.

Probed facts that affect the interim:

- Deny rules still hold under `--sandbox`.
- An unlisted command is still soft-denied headless under `--sandbox` with
  `request-review`.
- Per the docs, a `command` allow rule lets the matching command run **outside** the
  sandbox. So `custom` + `--sandbox` contains only the commands that weren't explicitly
  allowed.
- An allowed command that needs the network fails inside the sandbox unless `read_url`
  rules allow the domain, and ctrlyoke's lists can't express those today.
- On machines without sandbox support (Windows before 11 24H2, some Linux containers),
  `--sandbox` silently does nothing.

## Open questions

- **`unsandboxed` rules** apply only to business and enterprise accounts, and ctrlyoke can't
  tell the account type. Emit only `command` rules. agy's deny messages say
  `unsandboxed(…)` even for `command` rules on a personal account, so don't key any parsing
  off the kind name in that message.
- **Path-scoped file rules.** ctrlyoke's `read`/`write` patterns carry no paths today. If they
  ever do, agy's directory targets are a natural fit, but in-path globs are undocumented.
- **macOS/Linux literal prefixes.** If a later probe shows literal `command(git push)` prefix
  matching with chain splitting on POSIX, the regex translation still works there. Don't add
  a per-platform branch unless it buys something concrete.
