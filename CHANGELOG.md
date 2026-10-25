# Changelog

All notable changes to ctrlyoke will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Editor `@` completions resume budgeted scans across narrowed file results, so later files can appear as a query is extended.
- Workspace viewer file history now returns bounded partial `--follow` results,
  pages densely across trusted-root filtering, and keeps commit history available
  when Git cannot count the full history.
- VS Code workflow pickers now show Git-ignored workflow files when
  `hideGitIgnoredFiles` is disabled.
- Git-backed file listings now skip broken nested repositories and fall back to
  filesystem walks when Git is unavailable or refuses the repository.
- Editor paste and output-capture placeholders are removed after five minutes if no reply arrives, while late successful replies still insert their references; preview reply resolvers expire after five minutes.
- Dashboard history searches use the available index while another process rebuilds; complete CLI searches can wait for a live rebuild.
- Dashboard history searches now rebuild missing or stale indexes in the background and show the active query's results when the rebuild finishes.
- Workspace viewer diff downloads stream Git output without a size cap and
  report failures to the user, including the working tree's untracked file list.
- Workspace viewer worktree diffs page from frozen branch snapshots and show
  retryable errors when a page fails to load.
- Workspace viewer commit and file history now page from frozen Git tip hashes,
  keeping snapshots small and each Git history request bounded to one page.
- Skills registry resolution ranks slug matches across folder paths and probes
  candidates with bounded concurrency, reporting when its safety bound applies.
- Skills registry resolution and update checks fall back to a bounded walk when
  GitHub truncates a repository's recursive tree.
- Run bundle loading streams `events.jsonl` and limits individual event lines,
  so exported bundles can exceed the small JSON file size cap.
- Dashboard completion requests from separate sources no longer cancel each
  other, and a run-view load reply reaches a reconnecting client.
- Copilot model discovery retries in the background up to two times after a
  subprocess timeout, while its fallback models remain available for validation.
- Timed-out statusline commands keep any output already produced, and failures
  to spawn Windows `taskkill` remain non-fatal.
- Subprocess timeouts are recognized consistently across interpreter probes,
  Git operations, and CLI model discovery; Codex probes do not spawn after the
  launcher resolution outlives their timeout.

### Fixed

- Managed language-server disposal stops servers before awaiting in-flight starts,
  and an unanswered initialize request now times out after 60 seconds and is reported as a crash.

### Added

- **`workflow_status` reports per-step git outcomes.** Finished prompt steps show HEAD at start and end for captured repositories, plus whether the workspace was dirty when the step ended.

- **MCP `append_step` accepts agent and skills overrides and reports effective settings.** The append result shows the resolved harness, model, execution mode, session behavior, and condition preset names for every added step, including parallel members.

- **Condition presets for MCP-queued steps.** Workflows can define named,
  author-controlled condition scripts that MCP agents attach to steps by name.

- **MCP `append_step` and `edit_step` can set `executionMode`.** Their results warn when a step resolves to Codex in interactive mode, since Codex cannot wait on background work in either mode.

- **Subagent calls have dedicated output cards** labelled **Subagent:**, showing agent details, live progress, the prompt the agent was given, and the final result. Rows from a subagent's own activity carry the same **Subagent:** label.

- **The `workflow_status` MCP tool reports execution mode.** Its metadata gives the workflow's
  `executionMode`, and each prompt step lists the `harness` and `executionMode` it ran with (or will
  run with). The built-in workflow orchestrator and workflow composer agents use this to tell
  queued steps how to wait for long commands. A headless step can't wait on background work,
  because its process exits when the agent ends its turn. codex-cli can't in either mode.

- **Install skills from skills.sh in the Agent & Skills Manager.** The Skills list has a
  **skills.sh** tab that searches the public skills.sh directory, sorted by install count, with
  each skill's security audit verdict. Before you search it lists the top skills on skills.sh, from
  a snapshot bundled with the release, and the results can be filtered by install count or to
  skills that passed every audit. On wide windows it sits beside the skills list. **Import** shows the audits and the skill's `SKILL.md` on
  GitHub, then installs that commit into your workspace or user ctrlyoke skills folder. A skill
  with audit warnings or no audit needs an extra confirmation. **Check for updates** compares
  installed skills with their GitHub repositories, and **Update** reviews and installs the newer
  version, asking first before it replaces files you edited.

### Changed

- **Workflow file discovery uses Git candidates in checkouts and an asynchronous walk elsewhere.** Ignored workflow files are loaded on demand when the hosted picker is configured to show them.

- **Workspace search and `@` completions include files inside nested Git repositories and initialized submodules.** Directory entries are excluded from search file results and the completion index.

- **Large Git file listings use the long Git timeout.** Git listing failures are no longer mistaken for non-repositories; recovery paths log when they use a degraded filesystem walk, and the hosted workspace explorer marks children of wholly ignored directories as ignored.
- **Editor `@` completions resume budgeted scans across keystrokes.** Extending a query continues from the last scanned index position, so files later in large workspaces can appear without sacrificing fuzzy ranking.
- **Run-view loads no longer retry or roll back because of slow responses.** The panel waits for its reliable message transport; hosted clients retry after reconnect, duplicate requests join in-flight work, and a late snapshot can still complete the latest navigation.
- **Editor file operations stay responsive and complete after slow replies.** Prompt conversion, pasted images, output snapshots and image preview lookups bypass the shared route queue; client deadlines report that work is still pending, and late replies are applied or surfaced without caching preview timeouts.
- **Dashboard completion requests no longer block other clients and are superseded immediately by newer keystrokes.** Slow workspace symbol lookups and file-index polling stop emitting results after cancellation.
- **Statusline forwarding preserves the last good custom output when a command times out.** The wrapper allows 1.5 seconds, skips unused forwarding in ctrlyoke-style mode, and kills Windows command process trees on timeout.
- **Python and PowerShell interpreter probes no longer block the extension host.** Timed-out or failed probes fall back for one script and retry on the next resolution.
- **Codex quota refresh works with Windows npm installs.** The app-server probe now resolves the Codex launcher before spawning it.
- **`ctrlyoke commit` handles large commits.** Git add and commit output no longer hits Node's default 1 MiB buffer limit.

- **Copilot and OpenCode model discovery handles slow and large CLI output.** Discovery waits up to the shared 30-second CLI check limit, retries Copilot in the background after a timeout, and no longer accepts truncated OpenCode output as a complete model list.

- **Failed push, pull and commit in the workspace viewer show git's own
  error.** When a push is rejected, a pull would overwrite local changes, or a
  pre-commit or pre-push hook fails, the Source Control tab shows what git and
  the hook printed instead of `HTTP 500: Internal server error`. Long hook
  output scrolls in place and opens at its end, where the verdict is. The same
  applies to staging, unstaging and discarding a file. A commit, push or pull
  whose hook prints more than 1 MB of output no longer fails because of it.
- **A claude-cli step that starts a Claude Code workflow waits for the
  workflow.** A step whose agent launched a `Workflow` and then ended its turn
  used to complete right away while the workflow's agents were still running.
  It now waits, like it does for other background work, until the workflow
  reports back and Claude's follow-up turn ends. The workflow shows as a
  subagent card listing each of its agents and the current phase. Each agent's
  activity streams into the output under that card, and its tokens count
  toward the step's usage.

- **Subagents still running when an interactive step completes keep streaming.**
  Their later activity now appears as follow-up output instead of stopping at
  the step's completion.

- **claude-cli notices are labelled System message, not User message.** Notes
  that Claude Code adds to the conversation itself, such as the image-resize
  note after a screenshot is read, appear in the output as **System message**
  (in the dashboard, the CLI and Markdown exports) and as `<systemMessage>` in
  `$previous` context. Messages you type into the terminal are still labelled
  **User message**.

- **Workspace search loads results as you scroll and shows a result count.**
  The workspace viewer's Search tab no longer has a **Load more** button: the
  next results load when you scroll near the end of the list. A count above the
  results reads like **150+ results** while the search is still looking and
  becomes exact once every file has been read. A search stops after 10,000
  results.

- **Workspace search finds git-ignored files again.** With **Include git-ignored
  files** on, a workspace with a large ignored folder such as `node_modules/`
  returned no results at all, because listing every ignored file used up the
  search's time limit before any file was searched. It also briefly froze the
  extension host. Ignored folders are now searched after your other files, and
  only as far as the results you scroll to need.

- **A step's file changes are no longer lost in a workspace with many changed
  files.** Once a workspace had roughly 15,000 or more uncommitted or untracked
  files, for example a virtual environment or dependency folder created before
  it was git-ignored, `git status` produced more output than ctrlyoke accepted.
  Every step then recorded no file changes and offered nothing to undo. The
  limit is now 50 MB. If `git status` still fails when a step starts, files that
  were already changed are no longer reported as the step's changes, so undo
  cannot revert your own work.

- **Source Control shows an error when git status fails, not a clean tree.** In
  the workspace viewer, a large checkout whose `git status` timed out after 10
  seconds or produced too much output showed **no changes**. Status now gets
  the same limits as other long Git operations, and a failure shows its error.
  Discarding a file and opening its diff also fail with that error instead of
  guessing the file's state.

- **The workspace viewer reopens where you left it.** Closing and reopening it
  keeps the Search tab's query and results, and the commit, ref or file-history
  diff shown in Source Control, instead of clearing them.

- **Web searches show what they found, on every harness.** A web search row now
  shows the query as its heading, with the answer and sources in the same
  collapsible output as other tool calls. Searches from Claude and OpenCode
  previously appeared as generic tool calls, Copilot's appeared as an MCP call
  to `github-mcp-server`, and Codex's did not appear at all; all of them now
  show as web searches. Codex's page opens and in-page searches are shown too.
  Search results are also included in prior-step context, run history search,
  and markdown export.

- **Parallel web searches keep their own results.** When two web searches ran at once, for
  example in two subagents, one search's result or error could show on the other's row while
  that row stayed pending. Each search is now paired with its result by its tool call ID.

- **Copilot steps finish when the workspace is a subdirectory of a repository.** Copilot loads
  hooks only from the repository root's `.github/hooks/`, but ctrlyoke wrote its hook files under
  the workspace folder, so Copilot never reported a step's start or end. Hook files now go in the
  repository root's `.github/hooks/`, and your own workflow hooks still run in the workspace folder.

- **Faster startup on Windows.** Reading stored secrets and license details no longer starts a
  new PowerShell process for every value. One helper process serves them all, so VS Code no
  longer pauses for several seconds while ctrlyoke starts, and saving or removing a secret takes
  a fraction of a second.

- **Workspace tool permissions wider than yours need approval.** A `defaults.toolPermissions`
  value in a workspace's `.ctrlyoke/settings.json` that grants more than your user setting (for
  example `dangerouslyAllowAll`, a removed denied tool, or `none`) now waits for the same
  one-time approval as workspace hooks and default scripts, through the dashboard prompt or
  `ctrlyoke trust-workspace-settings`. Until you approve it, your user value applies, and a
  noninteractive `ctrlyoke run` exits with code `2`. A workspace value that only narrows your
  permissions still applies without asking.

- **Run definitions changed outside ctrlyoke are refused.** ctrlyoke now keeps a record of every
  run definition it writes, under `~/.ctrlyoke/projects/` in both storage modes, so an agent that
  edits a run file in `<workspace>/.ctrlyoke/.runs/` can no longer change a pending step's
  scripts, end conditions or tool permissions. A running workflow ignores such a change, puts back
  the definition ctrlyoke last wrote and shows a warning on the current step. Any other run
  becomes read-only, with a **Definition changed outside ctrlyoke** banner, until you choose
  **Restore** or **Accept change** (or run `ctrlyoke step restore-definition` /
  `ctrlyoke step accept-definition`). Hand-editing a run file now needs the same review. In
  `workspace` mode, a run ctrlyoke has no record of writing, such as one created outside it or
  pulled from another machine, is read-only until you accept it. Runs already in your history
  when you upgrade are trusted.

- **Headless steps warn when they end with background work still running.** The warning appears as a ctrlyoke notice rather than in the reply; headless prompts also tell agents to wait for long commands in the foreground.
- **Antigravity cost estimates now include separately reported thinking tokens.**
- **Cost tooltips flag upper-bound estimates.** When a model has no known cache-read price, its cache reads are still priced at the full input rate, but the tooltip now says the figure is an upper bound and how to get an exact one with a pricing override.
- **Sonnet 5.5 cache reads use the corrected $0.20/M rate.** The sync script
  checks the upstream value so the temporary correction can be removed when
  models.dev is updated.
- **Step cost estimates include parent agent tokens and price subagents at their own model.**

- **MCP `edit_step` no longer lets agents set or clear harness arguments.** The deprecated
  `additionalArgs` input remains accepted by the schema for compatibility, but calls using it
  fail without applying any edits. Workflow authors retain control of harness command flags.
- **Nested Claude subagent spawn cards now receive their progress and completion updates.**
  Updates emitted while a subagent starts another subagent stay attributed to the nested card,
  so it completes in place instead of leaving a running card and adding a duplicate row.
- **Step token totals and cost estimates include foreground subagents.** Subagent work was
  missing from every harness except Copilot; in measured Claude Code interactive sessions it was
  about 40% of the cost. Claude Code headless uses its per-model result totals, Qwen Code
  headless its process-wide usage (which also counts background memory calls), and the other
  harnesses follow each subagent's own log. Each model is priced at its own rates, so a subagent
  on a cheaper model is no longer billed at the parent's. If a subagent's log can't be read, the
  token count is shown as a lower bound and no cost estimate is given. Earlier runs keep their
  recorded totals.
- **Subagent activity is attributed to its spawn in headless and interactive output.**
  Child commands, text and thinking are indented and labelled under their spawn card, so parallel
  and nested subagents stay distinct. The `history show --json --events` payload replaces the
  always-`direct` `callerType` field with optional subagent attribution and spawn metadata;
  existing run histories with `callerType` remain readable.
  Background subagents (Claude Code launches parallel `Agent` calls this way by default, and Qwen
  Code and Copilot CLI have background modes too) are attributed the same way as foreground ones.
- **A Copilot step that reads its background shells until they finish now completes when its turn
  ends.** When Copilot waited on a background shell with `read_powershell` and the shell finished
  during that wait, ctrlyoke kept treating the shell as running. The step stayed running for 10
  minutes after Copilot was done, until the idle timeout completed it.
- **An interactive Qwen Code step waits for its background work.** When Qwen Code started
  background shells, monitors or subagents and ended its turn, the step completed straight away,
  before the work finished or Qwen Code dealt with its result. Each task's completion
  notification was also shown as a message you had typed. The step now keeps running until the
  last task's follow-up turn ends, like Claude Code, Copilot and Antigravity steps.
- **The "CLI is older than this extension" notice only names a CLI installed with npm.** After an
  extension update, it could name the CLI copy bundled in the previous extension version's folder,
  which runs whenever you or an agent type `ctrlyoke` in a VS Code terminal, even if you never
  installed the npm CLI.
- **The MCP Manager and the Stats tab name where their data comes from.** The MCP Manager's
  "Registry" tab is now **MCP Registry** and says it searches `registry.modelcontextprotocol.io`.
  The Stats tab says cost estimates use list prices from models.dev, bundled with each release.
- **A step you stop stays stopped, and Continue runs the next step.** If the harness reported the
  stopped step finished after you pressed Stop, the step turned completed and the following step
  was marked stopped without running, so Continue skipped it.
- **Token totals for Claude Code, Copilot, OpenCode and Antigravity now include cache writes.**
  Cache-created tokens are input the model processed for the first time, but these harnesses
  report them separately from input, and the attempt total left them out. A Claude Code step's
  total could be many times lower than a Codex step doing the same work. The step tooltip, the
  CLI and the Stats tab now count them. Totals already recorded for earlier runs are unchanged.
  [Reading a step's token counts](https://ctrlyoke.dev/docs/guide/usage-and-stats#token-counts)
  explains how each harness reports tokens.
- **Claude Code cost estimates price 1-hour cache writes correctly.** Claude Code writes its prompt
  cache with a 1-hour lifetime, which Anthropic bills at twice the input rate, but ctrlyoke priced
  every cache write at the cheaper 5-minute rate. Estimates for Claude Code steps were up to about a
  quarter too low and now match the cost Claude Code reports itself. Costs already recorded for earlier runs
  are unchanged.
- **A model pricing override now applies even when the harness reports its own cost.** OpenCode
  steps, and Claude Code steps run headless, used the harness's figure and ignored your
  override.

## [0.2.1] - 2026-10-22

### Changed

- **Settings → Worktrees shows each worktree's Git status.** Every row starts with a posh-git
  style line such as `[feature/x ↑18 +1 ~0 -0 | +0 ~3 -0 !]`: commits ahead of and behind your
  checkout's branch, then staged and unstaged changes. A label beside it says whether the branch
  is ready to merge, has uncommitted changes or conflicts, or is behind. Branch names use the
  commit graph's colors.
- **ctrlyoke tool calls in the output pane name the tool that was called.** Rows for ctrlyoke's
  own MCP tools showed only a result summary such as "Step 7/7 · running · Codex"; the header now
  starts with the tool name (`workflow_status · Step 7/7 · running · Codex`), find-in-output
  matches it, and hovering it shows the full `MCP: <server>.<tool>` label.
- **Ctrl/Cmd+C copies selected output text again in the VS Code panel.** Since VS Code 1.143,
  the copy shortcut moved focus back to the last focused control (such as the prompt editor)
  before copying, so the output selection was lost and nothing was copied.
- **"Hide full output" stays at the top of the output pane while you scroll an expanded result.**
  It now sticks below the pinned run banner, so a long output can be collapsed from anywhere
  inside it. Before, it scrolled away with the output, and with the run banner pinned it was
  drawn over the output's first lines.
- **OpenCode permission request hooks now run when a tool needs approval.** OpenCode delivers the
  request through its plugin event handler; the compatibility matrix now reflects that the event
  is available but allow/deny decisions are not supported.
- **OpenCode enforces per-server MCP tool denials.** Denied tool names now match OpenCode's
  sanitized `<server>_<tool>` names, including server IDs with punctuation.
- **Qwen remote MCP servers use their configured transport.** Streamable HTTP servers now use
  Qwen's `httpUrl` field, while SSE servers continue to use `url`.
- **Qwen MCP servers receive resolved managed secrets.** Secret values are substituted into the
  per-process inline MCP config, and the config is redacted from displayed command lines.
- **Qwen API errors now fail the step.** Qwen stream-json can exit with code 0 after an API
  rejection; ctrlyoke now reports its in-band error instead of completing the step successfully.
- **Codex approval settings remain compatible with current CLI releases.** The deprecated
  `untrusted` setting maps to `on-request` for Codex 0.149.0 and newer while retaining its
  original behavior on older supported releases.
- **Codex starts in read-only sandboxes.** It no longer receives `--add-dir` for the workspace
  itself or for external roots when the effective sandbox is read-only.
- **`general.autoLoadRecentSession` (now labelled "Reopen last workflow on startup") works
  when turned off.** Off now starts every new window on a new workflow. Before, the dashboard
  reopened the workflow it was last showing regardless, and the setting only mattered when there
  was nothing to reopen. A hosted browser without a workflow in its URL now shows the panel's
  workflow instead of the most recently modified one while the setting is off. On (the default)
  behaves as before: the last viewed workflow, otherwise the most recently modified one.
- **Harness CLI version policy.** A CLI below its minimum supported version is no longer refused:
  ctrlyoke launches it, warns when a workflow that uses it starts, and repeats the update command
  if a step fails. A CLI at or above the minimum never warns, even when a newer release exists, so
  opening a new ctrlyoke no longer flags every harness you haven't just updated. The compatibility
  docs' "Recommended" row is now "Tested with" and is informational.
- **Raised minimum CLI versions.** The minimum is now the oldest release with every CLI feature
  ctrlyoke uses: Codex 0.129.0 (older releases reject `--enable hooks`, so every step fails to
  start), Qwen Code 0.15.5 (older releases reject `--mcp-config`, so steps with MCP servers fail),
  and Antigravity 1.2.6 (older releases cut headless steps off after 5 minutes). Per-feature
  verified versions now start at each harness's minimum, so supported CLIs no longer get
  "unverified" warnings.
- **Every harness now counts as image-capable.** Image references (`@path` to a `.png`, `.jpg`,
  `.gif` or `.webp`) reach Qwen Code, Antigravity and interactive OpenCode natively, so the
  compatibility matrix and the prompt editor no longer warn that images are unsupported or only
  partly supported for them. The docs' verified-versions table now labels this row **Images**.
- **Tested with the latest harness CLIs.** The compatibility docs' "Tested with" row now lists
  Copilot CLI 1.0.103, Codex 0.163.0, OpenCode 1.19.4, Qwen Code 0.26.0 and Antigravity 1.4.5
  (Claude Code stays at 2.1.308). Minimum versions are unchanged.

### Fixed

- **Codex MCP calls appear in the run timeline.** Codex rollout logs now report MCP
  calls as completed `McpToolCall` items in `event_msg`; ctrlyoke records those rows
  while continuing to read the earlier response-item representation.
- **Claude Code asks before unlisted tools in interactive `custom` mode.** ctrlyoke now starts
  Claude with `--permission-mode default`. Before, it passed no mode, so a `defaultMode` such as
  `bypassPermissions` in your own Claude settings ran every tool without asking and the allow list
  had no effect.
- **Antigravity `preToolUse` and `postToolUse` hooks run.** ctrlyoke wrote them in a form agy
  ignores for tool events, so they never fired. They now fire on every tool call.
- **Codex errors are shown instead of an exit code.** When Codex rejects a request (for example a
  model that doesn't exist or that your account can't use), the step now fails with Codex's own
  message instead of "Process exited with code 1".
- **Pro license activation on macOS.** Activating a license no longer fails with "could not save
  it to this machine's credential store". Secrets of any length (including license files) are now
  saved to the macOS keychain intact; previously, values were truncated or saved empty. If an
  earlier activation on macOS seemed to succeed, activate again to save the license properly.
- Opening a folder could land the dashboard on an empty New Workflow instead of the previous or
  most recent session, when the dashboard was slow to load during startup.
- **Copilot context window and tokens on follow-up steps.** A step sent to Copilot's running
  terminal after the workflow had finished (for example a follow-up prompt) showed the previous
  step's context-window size and token counts unchanged. Each step now shows its own token usage
  and the context window as it grows.
- Warnings that include an error now show the error's message in the log instead of `{}`.
- Opening a folder that isn't in a Git repository no longer logs a worktree discovery warning.

## [0.2.0] - 2026-10-20

This release renames many settings and workflow fields. Old keys are not migrated: they are
ignored, and unknown workflow fields now produce a warning. See **Changed** for the full list.

### Added

- **Telemetry.** The VS Code extension now sends operational telemetry (harness and execution
  mode, counts and durations, outcome and error types, versions) through Microsoft's
  `@vscode/extension-telemetry` library. It follows VS Code's `telemetry.telemetryLevel`; set it
  to `off` to turn telemetry off. Prompts, code and AI output are never sent, and the headless
  CLI and `ctrlyoke-mcp` send no telemetry. See the Privacy and telemetry docs page.
- **Workflow files can name their workflow.** A multi-step workflow file's root `name` (or a
  `.prompt.md` file's frontmatter `name`) sets the name shown in the dashboard, recent workflows and
  history; without one, the file name is used as before. Save writes the workflow's current name,
  including a rename made in the dashboard, back to the file's `name`.

- **Language intelligence in the dashboard editor.** ctrlyoke can install and manage language
  servers (Settings > Language Servers, `languageServers.*`), so the workspace file editor gets
  diagnostics, hovers, go-to-definition, find references, rename and code actions, including
  multi-file edits. Symbol completions in prompts use them too, and the configured servers can
  be exported to harness configs.
- **Workflow file intelligence everywhere.** Workflow YAML/JSON files get schema-aware key, value,
  script and prompt-token completions, schema diagnostics, outline hovers and prompt lint, both in
  VS Code and in the dashboard's workspace editor. The prompt editor highlights prompt text as
  Markdown (including fenced code languages), shows `{{var}}` placeholders, and treats inline code
  as literal text.
- **Standalone dashboard server.** `ctrlyoke server` runs the hosted dashboard without VS Code,
  with prompt and symbol completions. **ctrlyoke: Start/Stop Hosted Dashboard Server** are in the
  command palette, and `server.autoStart` starts it when the extension activates.
- **Connect from anywhere (Pro).** `server.publicHostname` adds a Tailscale, dynamic-DNS or public
  address to the generated certificate and the Connect via link/QR code. A new docs page covers
  remote access. The server warns when its TLS certificate doesn't cover the LAN address, and
  Chrome on Android can download the certificate.
- **Multi-select steps.** Select several steps to reorder, recolor, delete, or edit shared prompt
  properties in bulk.
- **Reply to Step.** Right-click a finished step to continue that step's session with a follow-up
  prompt.
- **Templates:** Bug Hunt Loop, Bug Drain Loop and Feature-Driven Loop built-in templates; a
  `model` variable type that follows a harness variable; required variables; and saved default
  values per variable in the new Templates settings tab (`templates.variableDefaults`).
- **Workflow limits and guardrails.** A workflow-level `maxSteps` caps the queue (overriding
  `queue.maxSteps`), and runs stopped by a step, time or retry guardrail say which limit stopped
  them, in the dashboard, CLI and run file.
- **Prior context:** `$previous:N` for the last N outputs, run-address sources that pick an earlier
  run by workflow name and run number (`priorContext.workflow` / `run`), and a `:summary` detail
  (`$previous:summary`, `$step:summary:1,3-5`) with a matching `priorContextDetail` Full / Summary
  choice. Script verdicts are included in prior context.
- **CLI:** new `ctrlyoke status`, `ctrlyoke history steps`, `ctrlyoke history trash`,
  `ctrlyoke about` and `ctrlyoke uninstall` commands; `ctrlyoke history show` gains step selectors,
  filters and paging. Runs render tool calls,
  file edits, commands, user steers and ctrlyoke MCP calls live, matching the dashboard summary.
  `--force` applies run flags to individual steps. `ctrlyoke export` writes a finished run to a
  portable `.ctrlyokerun` bundle with workspace and home paths tokenized and secrets redacted.
- **Pro on headless machines.** `ctrlyoke license status`, `activate` and `deactivate` manage a
  license without the dashboard; the key is read from a hidden prompt or `--stdin`, never an
  argument. `ctrlyoke server` can also activate from `CTRLYOKE_LICENSE_KEY` or
  `CTRLYOKE_LICENSE_KEY_FILE`. On hosts without an OS keyring (containers, headless Linux), the
  license, server token and managed secrets persist in an owner-only `secrets.json` instead of
  living only in memory.
- **Keyboard flow.** A new workflow needs no mouse: Ctrl+N, type the name, Tab, write the prompt,
  Ctrl+Enter. Alt+H/M/R open the workflow's harness, model and resume-session pickers, and
  Alt+Shift+H/M/R open the step footer's pickers.
- Right-click or long-press in the prompt editor and the workspace file editor opens Cut, Copy,
  Paste, Select Word, Select Line and Select All.
- Output rows show their start time, duration and step on hover. New rows fade in and the live
  autoscroll glides, both respecting reduced-motion preferences.
- The status bar shows the ctrlyoke logo with the license tier ("ctrlyoke Pro", "ctrlyoke Free").
- User skills are discovered in `~/.ctrlyoke/skills` and every harness's user skill folder, and
  user agents in `~/.agents` and each harness's user agent folder. Agent and skill tooltips show
  where the copy that runs is saved and list any other copies.
- The editor's token count for a file-reference prompt counts the referenced file's content, and
  the workspace viewer shows the estimate for `.prompt.md` files.
- **Recently deleted.** Every history delete, including Clear all history, now moves runs to a
  per-project trash with an Undo toast; they can be restored for `storage.trashRetentionDays`
  (default 30). Clear all history moved to Settings > General > Run History behind a typed
  confirmation.
- Uninstalling ctrlyoke now removes its status line from the global settings of Claude Code,
  Copilot, Qwen Code and Antigravity, restoring any command you had before, and deletes
  `~/.ctrlyoke/bin/`. The extension does this when VS Code restarts after you uninstall it; for
  the npm CLI, run the new `ctrlyoke uninstall` before `npm uninstall -g ctrlyoke`. While another
  ctrlyoke installation is still in use, the status line is left for it.
- Every harness CLI has a supported-version window: a CLI below the minimum is reported as
  unavailable with its update command, and one below the recommended version is flagged as
  outdated in the harness picker.
- The bundled `ctrlyoke-syntax` skill teaches agents ctrlyoke's reference syntax, and agent
  frontmatter can declare `skills:`. File, range, symbol and commit references cited in a reply
  become clickable links in Output.
- Settings search; output and editor font size settings (`ui.outputFontSize`,
  `ui.editorFontSize`); `ui.wordWrap` for code views; and a theme control for the browser
  dashboard.
- Copy buttons on fenced code blocks, blockquotes and missing-harness install commands.
- Run time is shown on recent workflow rows, run rows and the run summary in one clock format,
  ticking live while running.
- Enterprise licenses show seat usage in the License tab. Codex steps show reasoning summaries and
  token counts for encrypted reasoning. Getting Started walkthrough steps have themed screenshots.
- Workflow and settings files carry a `schemaVersion`, and versioned schemas are published for
  editor validation.

### Changed

- **Renamed settings.** Update `.ctrlyoke/settings.json` by hand; the old keys are ignored:
  - `permissions.statusLineTracking` → top-level `statusLine`, with per-harness formats under
    `statusLine.byHarness.<harness-id>` (for example `claude-cli`)
  - `permissions.allowedExternalFileRoots` → `permissions.trustedExternalRoots`
  - `execution.injectMode` → `execution.reuseRunningTerminal`
  - `execution.maxPromptTimeout` → `execution.maxPromptTimeoutSec`;
    `execution.scriptTimeout` → `execution.scriptTimeoutSec`
  - `execution.strictContextResolution` → `execution.contextResolutionFailure`
  - `ctrlyokeMcpMode` → `execution.ctrlyokeMcpMode`
  - `queue.maxSize` → `queue.maxSteps`;
    `queue.maxWorkflowExecutionTime` → `queue.maxWorkflowExecutionTimeSec`
  - `coordination.maxEntryAgeDays` → `coordination.maxNoteAgeHours` (default 24)
  - `enableDiagnosticLogs` → `diagnostics.verboseLogging`;
    `ui.logRawCliOutput` → `diagnostics.logRawCliOutput`
  - `ui.hideCost` → `ui.showCostEstimates` (inverted)
  - `server.enabled` → `server.autoStart`
  - `commit.prompt` → `commit.systemPrompt`
  - The `off`/`never` values of `ui.stepColorMode`, `notifications.toastLevel` and
    `notifications.events.*` are now `none`.
  - `defaults.worktree` accepts the same `false`, shorthand and object forms as a workflow's
    `worktree`.
- **Renamed workflow fields.** All durations are now in seconds: `timeout` → `timeoutSec` (steps,
  `endCondition`, `preCondition`) and `errorBehavior.retryDelayMs` → `retryDelaySec`.
  `errorBehavior.onError: stop` is now `stopWorkflow`, and `priorContext` run sources use
  `workflow` / `run` instead of `workflowKey` / `runRef`.
- `defaults.resumeSession` now defaults to `true`, so a workflow continues its conversation like a
  chat. The built-in loop templates still set `resumeSession: false`.
- `defaults.harness` now defaults to auto-detect: the first installed harness in alphabetical
  order. Harness pickers are sorted alphabetically.
- One execution of a workflow's final step is now called a "pass" everywhere (`--step final:N`).
- `read_notes` returns only unread coordination notes, and a note expires once it is older than
  `coordination.maxNoteAgeHours` and its author has left the board.
- The hosted server token is scoped to each workspace, so regenerating it no longer breaks every
  saved phone link.
- Prior output references include commands, tool calls and results, search results, file changes,
  and other structured events, consistently across machines. Command output is tail-truncated and
  file reads include only their path and line range.
- Run timeline format v2 drops duplicate prompt and flattened response fields from output records.
  v1 runs still display, including a v1 run continued under v2.
- Copy Output copies the assistant's text; the new Copy Full Output copies the complete structured
  transcript. Script search matches use `matchField: "output"` and come from recorded stdout and
  stderr.
- A prompt sent to a running terminal shows under a "Prompt sent to running terminal:" header in
  Output.
- Inserting, moving or removing steps never rewrites step references in other prompts' text;
  the dashboard warns when an insert shifts them instead.
- The default status line ends with an "edit in ctrlyoke" hint, and its usage field is labeled
  "usage" for every harness.
- `@` file completions come from a workspace file index built in a background worker and stream
  in as you type, covering every Git-visible file instead of stopping at a walk cap.
- The extension and an npm CLI on different versions keep separate history search indexes and
  share a stable `~/.ctrlyoke/bin` status line launcher.
- `.ctrlyoke/` is only created after you opt a folder in, and settings that run programs, or add
  external workspace roots, require approval when they come from workspace settings.
- **Default tool permissions.** The default deny list now targets commands git can't undo or
  that reach beyond the machine: it no longer blocks `rm`/`del`/`Remove-Item`/`rd`/`rmdir`,
  `chmod`/`chown` or `docker rm`/`rmi`, narrows `git reset` to `git reset --hard`, and adds
  `git restore` and `npm`/`yarn`/`pnpm publish`. The starter allow list matches `git status` and
  `git diff` with arguments and adds `git show`, `git mv` and `git rm`. The deny list is not a
  security boundary. Codex and Antigravity no longer warn about the shipped default lists, and
  Codex now enforces `mcp__<server>__<tool>` denials.
- When agents or skills share a name, the copy in the workspace `.ctrlyoke` folder wins, then
  `~/.ctrlyoke`, then harness folders.
- A resumed session is no longer re-sent agents and skills it already received, including when it
  is resumed from another run, workflow, the CLI or MCP.

### Removed

- `general.includeFullDiffsInPriorContext`, `queue.unlimitedMode` (use `-1` limits instead),
  `queue.notifyOnExtension`, and `server.standalonePort`.
- The Clear History item in the workflow dropdown (now in Settings).

### Fixed

- Secrets split across PTY output chunks or other output streams are redacted, workflow hook and
  MCP secrets are no longer granted to script steps, and an unapproved grant with no value warns
  instead of failing.
- Paused workflows stay paused across a VS Code restart, a crashed owner's in-flight step is
  settled so its run can continue, and a recorded step failure no longer also fails the next
  step.
- Script steps and condition scripts are terminated with their whole process tree on cancel or
  timeout, honor `timeoutSec` in headless runs, and report timeouts as timeouts. Exit codes
  compare numerically for `eq`/`ne`, and regex comparisons are time-limited
  (`execution.regexTimeoutSec`).
- Error retries are counted separately from end-condition retries, and retry prompts resolve their
  sources correctly.
- Hook timeouts are honored (and written in seconds for Antigravity); timed-out hook trees are
  killed on Windows; each hook gets its own environment; stale Qwen and Antigravity hook groups
  are cleaned up.
- A harness that rejects a resumed session is retried without resume; Claude subagent prompts are
  no longer recorded as user steers; Copilot, OpenCode, Claude and Codex token and context-window
  usage is reported correctly; failed OpenCode and Antigravity tool calls are surfaced.
- The hosted server authenticates WebSocket upgrades, rejects empty tokens, contains workspace
  viewer paths (including through symlinks and outside links), validates icon colors, and blocks
  saves of redacted or stale files.
- Reconnecting to the dashboard no longer duplicates a running step's output, live terminals
  replay to newly connected clients, and the terminal replay buffer survives panel reconnects.
- Undo restores overwritten files correctly and keeps per-file redo state.
- Managed worktrees land branches the agent committed itself, run setup in the configured script
  shell outside the mutation lock, and release their lease on setup errors.
- `ctrlyoke run`, `rerun` and `append` reject unknown `--harness` values, exit 3 when the harness
  executable is missing, persist `--var` overrides, resolve workflows by exact name, and shut
  down gracefully.
- Commit messages are generated for the SCM repository you clicked, with restricted permissions,
  and large staged diffs are read instead of falling back to unstaged changes.
- Many file-lock, runner-lock and credential-store fixes for Windows (delete-pending `EPERM`,
  torn writes, stale-lock recovery).
- Resuming a session across final-step passes reuses the terminal that holds it, and resuming a
  closed session no longer kills a reusable terminal holding a different conversation.
- `$previous` and `$previous:summary` include a follow-up sent after a step finished.
  `#selection` and `#sym` references work anywhere in files over 512 KB, skipped-reference
  warnings name the reference as typed, and context references that resolve through a link to
  outside the workspace are blocked.
- Completions stay reachable while a reference is typed (`@dir/` queries fall back to a fuzzy
  path match), Backspace deletes a reference chip in one press, and `$step:` completion opens in
  plain YAML prompt values.
- The hosted dashboard no longer stalls on startup, and the extension host does less work
  redacting secrets and scanning snapshots. The workspace file index is bounded by a memory
  budget.
- Ctrl/Cmd+A selects only within the focused panel, output stays rendered when a continuation
  starts on a finished run, and the step list shows each pending step's inherited model for its
  own harness.
- Inline `[mcp_servers]` entries in Codex `config.toml` are parsed, and Qwen file references with
  spaces are formatted correctly.
- Many dashboard fixes, including High Contrast Light preflight commands, narrow and mobile
  layouts, the minimap, modal Escape handling, keyboard navigation in the step context menu, and
  machine deactivation feedback in the License tab.

## [0.1.2] - 2026-09-25

### Added

- The `ctrlyoke` CLI ships inside the extension and is on `PATH` in VS Code's integrated
  terminals and in the harness processes ctrlyoke starts. For other shells and CI it is also
  published to npm as `ctrlyoke` at the same version; **ctrlyoke: Install CLI for Use Outside VS
  Code** types the install command for you.
- The CLI and the extension each record their version, and warn when an npm CLI is older than the
  installed extension.
- Shared run, lock, trust and coordination state carries a schema version. An older ctrlyoke
  refuses to write state created by a newer one instead of silently dropping fields.
- History search: `ctrlyoke history` commands on the CLI, plus regex and deep search in the
  dashboard drawer, with results streamed as they're found.
- Fuzzy-ranked file and symbol completions, with the matched characters highlighted.
- End-condition scripts compare stdout/stderr through an explicit operator.
- Prepare a run without starting it, final-step progress on workflow rows, and parallel-group
  highlighting in the prompt chip rail.

### Changed

- The `passthrough` permission mode is renamed to `none`, and `none` no longer escalates to
  bypass.
- The harness portability report is now a compatibility accordion.
- History search streams its index instead of holding it in memory.

### Fixed

- Steps wait for harness background tasks to finish, and the dashboard shows why a step is held.
- Interactive steps whose CLI exits non-zero before completing now fail instead of hanging.
- `ctrlyoke run` picks the harness from the workflow instead of defaulting to Copilot CLI.
- `--no-color` disables colored CLI output.
- Codex session logs are read from `CODEX_HOME`, and OpenCode resumes interactive prompts through
  its plugin.
- Headless output and session IDs survive stream-chunk boundaries, including multi-byte UTF-8.
- A cancelled headless run no longer leaves an orphaned harness process.
- The runner lock hands off cleanly between consecutive runs.
- MCP tools refuse operations they can't perform instead of reporting success.
- Many dashboard fixes: undo for workflow properties and step reorders, status-badge flicker,
  context-window gauge restore, and mobile layout of the dry-run dialog.

## [0.1.1] - 2026-09-17

### Changed

- Save As now creates a portable workflow bundle by copying generated attachments into a sibling
  `<workflow>.assets/` directory and inlining lone generated prompt files. The new ignore rules do
  not untrack files already committed; the only migration gap is a new screenshot added to an
  already-committed workflow that is never re-saved.
- `.ctrlyoke/settings.json` is tracked by default as project configuration. `server.certPath` and
  `server.keyPath` remain machine-local paths and should be configured separately on each machine.

## [0.1.0] - 2026-05-12

Initial release.

### Added

- Multi-harness execution: Copilot CLI, Claude Code, Codex, OpenCode, Qwen Code, and Antigravity CLI
- Parallel workflow execution with independent pause, resume, and cancel per workflow
- React dashboard with CodeMirror 6 prompt editor, live output viewer, and embedded terminal
- Script-based end conditions with retry logic, timeout protection, and template variable substitution
- Dynamic workflows via MCP tools — the AI can append steps to a running workflow at runtime
- Agent injection via `.agent.md` files and per-prompt `agent:` field
- Skills injection with per-prompt `skills:` field
- IntelliSense completions for `@file`, `#file:`, and `#sym:` references with gitignore-aware filtering
- Output history with run selector and persistent per-run snapshots
- Workflow templates: blank, simple-feature, fix-tests, and full-feature
- Multi-format workflow files: `.ctrlyoke.yaml`, `.ctrlyoke.json`, `.prompt.md` with unified JSON Schema validation
- Status bar showing real-time execution state
- Standalone CLI binary (`ctrlyoke run`, `ctrlyoke validate`)
- MCP server binary (`ctrlyoke-mcp`) for tool-based queue operations from AI assistants
- Variable substitution with `--var key=value` flag and `{{varName}}` placeholders in workflows
- Per-prompt session management with three-tier resolution (prompt > workflow > global)
- Side-by-side diff view for comparing AI-generated changes
- Stale-state recovery with atomic file locking and PID-based runner detection
