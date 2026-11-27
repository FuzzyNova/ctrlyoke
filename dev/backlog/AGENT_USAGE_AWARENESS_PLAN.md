# Agent usage awareness: quota windows, a quota guard, and a step's own context

## Status (2026-11-27)

Proposed, not started. Pairs with `WORKFLOW_HARNESS_POLICY_PLAN.md`: that plan
limits which harnesses a workflow may use, and this one lets an agent, and ctrlyoke
itself, choose within those limits based on how much each one has left.

## Motivation

In the `workflow-step-plan` run, the orchestrator moved every queued step onto
`claude-cli` / opus (see the policy plan for why). That used up the user's Claude
Code 5-hour window. The user then paused the run by hand near each limit and
resumed it at the reset, and once paid about $15 of extra usage after missing the
window. Copilot had plenty of quota left and offers Opus 5.5 too, but nothing told
the orchestrator either of those facts.

ctrlyoke already has the data, but only people can see it:

- **Quota windows** for each harness, in `HarnessUsageSnapshot`
  (`src/types/UsageTypes.ts`), stored by `HarnessUsageService` in
  `provider-snapshots.json`:
  - Claude: `five_hour` and `seven_day`, from the statusline sidecar or headless
    `rate_limit_info`
  - Codex: primary and secondary windows, from app-server `readRateLimits` or the
    rollout logs
  - Copilot: premium requests or AI credits
  - Antigravity: percentages from its sidecar
  - OpenCode and Qwen: observed usage only
- **Where people see it:** Stats & Usage, the harness picker's percentage, the
  statusline `usage` segments, and the pre-launch `buildUsageSelectionWarning`.
- **Context window per attempt:** `TokenUsage.contextWindowUsed` and
  `contextWindowSize` are recorded in `events.jsonl` and drawn live by
  `ContextWindowBar`.

None of it reaches an agent:

- `list_harnesses` returns only ids, names, availability and models.
- `workflow_status` and `read_output` carry no token or context fields.
- `history steps` has none either. Only `history show --json --summary` includes
  an attempt's `tokens`.
- No `CTRLYOKE_*` variable or tool tells a running step its own context usage.
- There's no CLI command for quota.

## Part 1: quota windows for agents and the CLI

- **MCP `list_harnesses`.** Add a `usage` object to each harness: one entry per
  quota window (`label`, `percentUsed`, `remaining`/`limit` when known,
  `resetsAt`, `windowMinutes`), plus `fetchedAt` and `stale`. Read it from the
  stored `provider-snapshots.json` through `HarnessUsageService`'s read path. The
  MCP server is a separate process, so it reads the file and never refreshes
  providers itself.
  - Leave the object out when `usageTracking.enabled` is off or no snapshot
    exists.
  - Mark it `stale` when it's older than its `staleAt`.
  - This is an additive field.
  - The data is numbers about the user's own account and is low-risk under
    auto-approval. It's a different matter from showing other workflows' text
    (`GLOBAL_STATUS_STEPS_PLAN.md`).
- **CLI `ctrlyoke usage [--harness <id>] [--json]`.** Prints the same windows plus
  the observed day, week and month tokens and cost from
  `ObservedHarnessUsageStore`. Its JSON follows the usual versioned-envelope
  style. Name it in `docs/cli/ctrlyoke.md`.
- **Orchestrator guidance** (`workflow-orchestrator.agent.md`, `<harnessAndModel>`).
  - When the harness a step would use is above `usageTracking.warningPercentUsed`
    on a window that resets after the step would finish, prefer another allowed
    harness that offers the same model family. For example, Copilot's
    `claude-opus-5.5` in place of Claude Code's opus.
  - `list_harnesses` should report each model's family, so the agent doesn't have
    to guess that two names mean the same model. Reuse the `ModelConstants`
    matching that the policy plan needs.

## Part 2: a quota guard that ctrlyoke enforces

The user's manual routine (pause near the limit, resume at the reset) is
deterministic, so ctrlyoke should do it rather than relying on a model's judgment:

```yaml
usageGuard:
  pauseAtPercentUsed: 90 # before dispatching a step, check its harness
  resumeAtReset: true # schedule a resume for the window's resetsAt
```

- **Check before each dispatch.** In `WorkflowExecutor`, before a step starts,
  read the step's harness snapshot. If any window is at or over the threshold and
  resets later, pause at that step boundary (the normal Pause semantics: the
  current step has already finished). Record a timeline event that names the
  window and its reset time, so the dashboard and `ctrlyoke status` can say why
  the run paused.
- **Resume at the reset.** With `resumeAtReset`, the host that owns the run
  resumes it once `resetsAt` passes (plus a small margin) and the snapshot has
  refreshed. If no host is alive then, the run stays paused and says why.
- **Optional fallback instead of pausing:** `fallbackHarnesses: [copilot-cli]`
  moves the step to the first allowed harness with room. Model mapping uses the
  family match from Part 1. Steps with `resumeSession` can't move to another
  harness and always pause.
- **Stale data fails open with a warning.** A stale or missing snapshot doesn't
  pause the run, because a dead sidecar shouldn't stop the workflow. Claude's
  window now updates from headless output too (CHANGELOG, Unreleased), so
  headless-only runs stay current.
- **Additive schema field** at workflow level, also offered as a template option
  in Large Spec Loop and the bug hunt loop. A user-level setting default could
  follow.

## Part 3: a step's own context window

Your question was whether `workflow_status` already shows context usage per step.
It doesn't, and a step can't look up its own.

- **`workflow_status`** gains a `self` block for the calling step: its index or
  `final:N`, plus
  `contextWindow: { usedTokens, size, percentUsed, compactionCount, asOf }`. Each
  finished step's entry gains the same `contextWindow` and `tokens` (with cost) as
  its last attempt, taken from the attempt summary that
  `history show --json --summary` already builds.
- **Design question: where the live value comes from.** The live figure is in the
  extension host's or CLI runner's `OutputCaptureBuffer`, but the MCP server is a
  separate process. Before designing this, check whether mid-turn token records
  reach `events.jsonl` while a step is still running. If they don't, the runner
  writes a small `run-*/live-usage.json` (step address, tokens, `asOf`), throttled
  like its heartbeat, and the MCP server reads that.
- **`history steps --json`** gains the same per-step `contextWindow`, `tokens` and
  `cost`, which makes cost visible per step in the CLI. This addresses the "100×"
  question directly.
- **Lower priority than Parts 1–2.** In this run, the codex steps that stopped
  short ended at 28–62% context, so context wasn't the reason. Most harnesses also
  tell their own model when context runs low. The value is in letting a step check
  "am I really low?" before trimming its work, and in giving the orchestrator
  per-step cost and context when it reviews a round. A guidance line belongs with
  it: "Check `workflow_status.self.contextWindow` before cutting a task short for
  context; finish the work if you're below ~80%."

## Docs and tests

- Generated reference pages for the schema field. Hand-written:
  `docs/cli/ctrlyoke.md` (`usage`), `docs/workflows/coordination.md` or the MCP
  tools page (`list_harnesses.usage`, `workflow_status.self`), and a page on the
  quota guard. CHANGELOG **Added** entries.
- Tests:
  - `McpServer.test.ts`: usage present, stale and absent, plus `self` resolution
    for a queue step and a final pass
  - executor guard: pauses at the boundary, fails open on stale data, uses a
    fallback harness, and never moves a resumed session
  - resume at reset with a fake clock
  - CLI `usage` JSON
