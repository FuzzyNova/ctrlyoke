# `auto` Tool Permission Mode Plan

**Status:** Proposed 2026-11-12, after the 0.7.0 agy fix
(`bc60bcbff`, `dev/bugs/implemented/antigravity-auto-mode-runs-unlisted-chained-command.md`).

## Goal

Add a fifth permission mode, `auto`, that turns on each harness's own judged-approval mode:
a classifier or reviewer model approves what it judges safe and blocks or asks about the rest.
The deny list still blocks, and the allow list pre-approves without the judge. Today the only
way to get this is a per-harness additionalArgs trick that works with `mode: none` on most
harnesses and is silently overridden or crashes with `custom`/`allowAll` (see "Workarounds
today").

## Findings (probed 2026-11-12)

Every row was probed headless with the harness-test models (`HARNESS_MODELS` in
`src/test/harness/helpers/harnessRunner.ts`; agy on `gemini-3.8-flash-low`), from a fresh scratch
repo. User settings were excluded where they would interfere: this machine's
`~/.claude/settings.json` allows `Bash(node:*)`, so Claude ran with
`--setting-sources project`. The "unlisted" probe ran `echo hi && node marker.js out.txt` with
only `echo` allowed. The "deny" probe ran `node marker.js out.txt` with `node` denied. The
"risky" probe ran `rm -rf ~/<scratch dir>` on a real throwaway directory.

| Harness (version)   | Auto mechanism                                                                            | Unlisted command      | Deny rule                                                  | Risky command                                                          | Notes                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code 2.1.323 | `--permission-mode auto`                                                                  | ran (judge approved)  | blocked                                                    | **ran** (the prompt asked for it explicitly)                           | An `ask` rule still blocks headless. An ineligible model (`claude-haiku-4-5`) fails closed: the command is refused, with no error. `dontAsk` with the same rules refused the unlisted command, as expected.                                                                                                                                |
| Copilot CLI 1.0.110 | `--assisted-approval` (`-p` only)                                                         | ran                   | blocked (`--deny-tool` wins even with `--allow-all-tools`) | blocked ("mandatory confirmation")                                     | `--autopilot` is **not** a permission mode. It is the continuation loop (`--max-autopilot-continues`, default 5). Under autopilot a request that would prompt is denied: the unlisted command was refused with "no one to approve".                                                                                                        |
| Codex 0.167.2       | `-c approvals_reviewer=auto_review -c approval_policy=on-request` (or `--approve-for-me`) | n/a (sandbox governs) | not probed                                                 | n/a                                                                    | With it, `codex exec` reports `approval: on-request` instead of its fixed `never`, and the reviewer **approved a sandbox escalation** to write outside the workspace. `--approve-for-me` cannot be combined with `-s`, so use the `-c` form, which works alongside `-s workspace-write`.                                                   |
| Qwen Code 0.27.2    | `--approval-mode auto`                                                                    | ran                   | blocked (`--exclude-tools`)                                | blocked                                                                | Headless `auto`, like headless `default`, **drops `run_shell_command` from the session** unless an allow rule names it. With bare `--allowed-tools ShellTool` the judge still engages: risky `rm -rf` was blocked, since auto mode stashes broad allow rules.                                                                              |
| agy 1.5.7→1.5.8     | settings `agentMode: "auto"` (also agy's own default from 1.5.7)                          | ran                   | blocked                                                    | **contained**: ran inside agy's sandbox, `EPERM` outside the workspace | `--mode auto` prints `--mode auto is not available for this account; continuing in the default mode`, yet a session with no `agentMode` still runs in auto. An explicit `agentMode: ""` wins over `--mode auto`. Workspace writes from commands worked under auto, unlike `--sandbox` on 1.4.12. agy self-updated to 1.5.8 during probing. |
| OpenCode 2.2.7      | none                                                                                      | —                     | —                                                          | —                                                                      | `opencode run --auto` is "auto-approve permissions that are not explicitly denied", i.e. `allowAll`, not a judge. Its docs list no judged mode.                                                                                                                                                                                            |

Two things hold on every harness that has a judge:

- **The allow list stops limiting what runs.** It only skips the judge for matching requests.
  This is what broke ctrlyoke's `custom` mode on agy 1.5.7, and it's why `auto` must be its own
  mode and never something `custom` falls into.
- **The deny list keeps working.** It is evaluated before the judge.

Documented but not probed (from official docs, Nov 2026):

- **Claude.**
  - Auto mode drops broad allow rules (`Bash(*)`, interpreter wildcards, package-manager runs,
    `Agent`) and keeps narrow ones.
  - An `autoMode` block (`environment`, `allow`, `soft_deny`, `hard_deny`, `classifyAllShell`)
    is read only from user settings, managed settings or `--settings`.
  - `permissions.defaultMode: "auto"` is ignored in project settings.
  - Since 2.1.283, interactive sessions start in auto by default.
  - Model eligibility is Opus 4.6+, Sonnet 4.6+, Haiku 5.5 or Fable on the Anthropic API, and
    stricter on Bedrock, Google's Agent Platform and Foundry.
  - After 3 consecutive or 20 total blocks, `-p` keeps going, but blocked actions still don't
    run.
- **Copilot.**
  - Requests already allowed by rules skip the judge.
  - Interactive sessions get assisted mode only through `defaultPermissionMode: "assisted"` in
    `~/.copilot/settings.json` or `/permissions assisted`.
  - `COPILOT_ASSISTED_APPROVAL` makes an interactive session refuse to start.
  - The flag is "ignored, with a warning" when `AUTO_APPROVAL` is disabled or blocked by
    policy.
- **Codex.** The reviewer only sees actions that already need approval: sandbox escalations,
  network, `request_permissions`, and MCP/app calls. It fails closed.
- **Qwen.** The judge fails closed when the classifier is unreachable, and falls back to manual
  approval after 3 consecutive blocks.
- **agy.**
  - Auto needs the terminal sandbox.
  - It is unavailable on business and enterprise accounts, and on Windows before 11 24H2.
  - Where unavailable, it continues in default mode.

## Workarounds today

`additionalArgs` are inserted **before** ctrlyoke's permission args (see the comments in each
`*HarnessAdapter.ts`), so with `custom`/`allowAll` ctrlyoke's own flag comes last:

| Harness  | With `mode: none`                                                                                                                                                            | With `custom` / `allowAll`                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `--permission-mode auto` works. Interactive already starts in auto (2.1.283+) unless the user's `defaultMode` says otherwise.                                                | **Overridden**: last `--permission-mode` wins (probed: `auto` then `dontAsk` refused the unlisted command).                                                                                 |
| Copilot  | `--assisted-approval` works headless.                                                                                                                                        | **Works**: it is additive, so ctrlyoke's allow/deny rules apply first and the judge handles the rest.                                                                                       |
| Codex    | `-c approvals_reviewer=auto_review` (+ `-c approval_policy=on-request` headless) works.                                                                                      | **Works**: it is additive to `-a on-request` and `-s`.                                                                                                                                      |
| Qwen     | `--approval-mode auto` works. Headless also needs `--allowed-tools ShellTool`.                                                                                               | **Crashes**: a duplicate `--approval-mode` fails with `TypeError: value.trim is not a function`.                                                                                            |
| agy      | Nothing needed: 1.5.7+ starts in auto. ctrlyoke writes no settings file in `none`, and `agentMode: ""` is only written for `custom`/`allowAll`, which is the intended split. | **Overridden**: the pinned `agentMode: ""` beats `--mode auto`. A user `--settings` file in additionalArgs makes ctrlyoke skip its translation entirely (`ANTIGRAVITY_SETTINGS_COLLISION`). |
| OpenCode | n/a                                                                                                                                                                          | n/a                                                                                                                                                                                         |

The `none` workaround has a real cost: ctrlyoke's deny list is dropped. That includes the
`mcp__ctrlyoke-commit__*` filtering used by commit-message generation, which is why `auto`
should be a first-class mode rather than a documented additionalArgs recipe.

## Design

### Mode semantics

`auto`: "the harness's own safety judge approves or blocks each request; `deniedTools` always
blocks; `allowedTools` are pre-approved and skip the judge but do **not** limit what runs."

- Safety order for the picker and docs: `dangerouslyAllowAll` > `allowAll` > `auto` > `custom`
  > `none`. Place `auto` between `allowAll` and `custom` in `PermissionsQuickPicker`.
- `permissionModeAppliesToolList` (`src/types/DashboardConstants.ts`): `auto` applies both
  lists. Update its doc comment so it says the allow list is pre-approval, not a limit, in
  `auto`.
- **Unsupported harness, or a version older than the gate:** behave exactly like `custom` and
  emit a warning `CompatibilityDiagnostic`, e.g. "Auto permission mode is not supported by
  OpenCode; ran with custom tool permissions". Failing toward `custom` is the safe direction:
  unmatched requests are refused headless and asked about interactively. Never fall back to
  `allowAll`.
- Headless refusals need no new handling: each judge refuses in-band, and the agent reports it.

### Per-harness mapping

| Harness  | Headless                                                                                                                                                                 | Interactive                                                                                                                                                                                | Version gate                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Claude   | `--permission-mode auto` + `--allowedTools` + `--disallowedTools`                                                                                                        | same                                                                                                                                                                                       | Probe the earliest version that accepts `auto`. Docs suggest ~2.1.17x; 2.1.283 only changed the _default_. |
| Copilot  | `--assisted-approval` + `--allow-tool` + `--deny-tool` (no `--allow-all-tools`)                                                                                          | **unsupported**: no per-run flag, and the env var refuses interactive. Fall back to `custom` with a diagnostic that names `/permissions assisted` and `defaultPermissionMode: "assisted"`. | Probe when `--assisted-approval` appeared                                                                  |
| Codex    | `-c approvals_reviewer=auto_review -c approval_policy=on-request` (keep `-s` from `CodexSandboxMapper`)                                                                  | `-a on-request -c approvals_reviewer=auto_review`                                                                                                                                          | Probe                                                                                                      |
| Qwen     | `--approval-mode auto` + `--allowed-tools` (always including bare `ShellTool`, so the shell tool stays registered headless; the judge still engages) + `--exclude-tools` | `--approval-mode auto` + lists (no bare `ShellTool` needed, since interactive keeps the tool)                                                                                              | Probe                                                                                                      |
| agy      | settings file: `toolPermission: "request-review"`, `agentMode: "auto"`, allow/deny lists                                                                                 | same                                                                                                                                                                                       | `>=1.5.7` (reuse `ANTIGRAVITY_AGENT_MODE_SETTING_RANGE`); older agy rejects the key                        |
| OpenCode | unsupported → `custom` + diagnostic                                                                                                                                      | same                                                                                                                                                                                       | —                                                                                                          |

Notes per harness:

- **Claude.** Consider passing an `autoMode.environment` entry through the existing per-run
  `--settings` so the classifier knows it is running under ctrlyoke automation. That is
  optional, so leave it out of v1. Ineligible models fail closed silently. Detecting that is
  out of scope; document the eligible models instead.
- **Copilot.** `--assisted-approval` "is ignored, with a warning" under policy. Surface its
  stderr warning if the adapter already captures stderr diagnostics; otherwise document it.
- **Codex.** This is the one harness where `auto` can _widen_ access beyond `custom`: headless
  `custom` is sandbox-only with no escalation path, while `auto` lets the reviewer approve
  escalations out of the sandbox. Say so in the docs and the mode description.
- **agy.** The `--mode auto` flag is refused on some accounts even when settings-driven auto
  works, so use the settings key, never the flag. Auto runs commands in agy's sandbox. Re-check
  the "workspace is read-only under the sandbox" note in `harness-adapters.instructions.md`:
  under auto on 1.5.8 workspace writes worked, and that note describes `--sandbox` on 1.4.12.

### Capability metadata

`PermissionCapabilityDescriptor` (`src/types/CompatibilityTypes.ts`) has `mode`,
`allowedTools` and `deniedTools`. Add `autoMode: CapabilityDeclaration` to every harness's
`*_PERMISSION_CAPABILITIES`:

- OpenCode is `unsupported`.
- Copilot is `partial` with a caveat code for "headless only".
- The rest are `native`, verified by the new harness cases below.

The generated `docs/harnesses/compatibility.md` then shows it. Add the key to
`PERMISSION_CAPABILITY_KEYS`.

### Schema and settings

Adding an enum value is a **no-bump** change ("Changing the schemas" in `CONTRIBUTING.md`):

- Add `"auto"` to the `mode` enum in `schemas/workflow-schema.json` and
  `schemas/settings-schema.json`, and rewrite the description to cover the semantics above.
- Then run `npm run schema:update`.
- Add `AUTO: "auto"` to `PERMISSION_MODES`.
- Check every `switch (config.mode)` and `=== PERMISSION_MODES.ALLOW_ALL` site (list via
  `grep -rn "PERMISSION_MODES\." src`) for one that would treat `auto` as `custom` by falling
  through.

## Implementation steps

1. Constants and schema: `PERMISSION_MODES.AUTO`, both schema enums, `schema:update`, and
   `permissionModeAppliesToolList`.
2. Mappers: add an `auto` branch to each `*ToolPermissionMapper.prepare`, with a shared helper
   in `ToolPermissionMapperBase` for the "unsupported → custom + diagnostic" fallback.
   - Version gates come from `PermissionContext.cliVersion`. The agy adapter already passes it;
     do the same in any adapter whose gate needs it.
3. UI:
   - Add an `auto` option and description to `PermissionsQuickPicker.tsx`, `permissionUtils.ts`
     and `SchemaUiMetadata.ts`.
   - In the drawer or picker, show a per-harness "falls back to custom" hint, reusing the
     compatibility-diagnostic display that `allowedTools` warnings already use.
4. Unit tests (`src/test/unit/HarnessToolPermissionMappers.test.ts`):
   - Exact args per harness, headless and interactive.
   - The agy settings body under `auto` at `1.5.6` (fallback) and `1.5.7`.
   - The Qwen headless bare `ShellTool`.
   - The Copilot interactive fallback diagnostic and the OpenCode fallback.
5. Harness tests (`src/test/harness/`, run only when asked): one case per supported harness for
   each of the three findings that matter:
   - The deny list still blocks under `auto`.
   - An unlisted, benign chained command runs.
   - The `custom` regression case "an allowed command does not allow an unlisted one chained
     to it" stays green.
6. Docs:
   - Update the permissions guide page: the mode list, the per-harness table, the Codex
     escalation caveat, the Claude model eligibility, and Copilot interactive being
     unsupported.
   - Add a short "using a harness's auto mode before ctrlyoke 0.8" note with the `none` +
     additionalArgs recipe from the table above.
7. `CHANGELOG.md` under `## [Unreleased]` → **Added**.
8. Instruction file: replace the agy 1.5.7 sentence in `harness-adapters.instructions.md` with
   the general rule. Under every judge the allow list stops limiting and the deny list still
   applies, so `custom` must pin each harness out of its auto mode, and `auto` is the only
   mode that may enter it.

## Open questions

- **Resolved: Claude `custom` interactive** passes `--permission-mode default`. Claude 2.1.323's
  `--help` lists `manual` but not `default`. The probe used user settings with
  `defaultMode: "bypassPermissions"`, and `--permission-mode default` still refused an unlisted
  chained `python3`, while omitting the flag ran it. So `default` is still the manual mode and
  overrides the user's `defaultMode`. Consider switching to `manual` once the oldest supported
  Claude accepts it.
- **Name.** `auto` matches Claude, Qwen and agy. Copilot calls it "assisted" and Codex calls it
  "auto review". Keep `auto`, and use "Auto (harness judges each request)" in the picker.
- **Default.** Should a later release make `auto` the default instead of `allowAll`? Not in this
  change.
