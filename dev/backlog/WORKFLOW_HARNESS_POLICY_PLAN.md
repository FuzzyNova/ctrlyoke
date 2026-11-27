# Workflow harness and model policy

## Status (2026-11-27)

Proposed, not started. Pairs with `AGENT_USAGE_AWARENESS_PLAN.md`: this plan limits
which harnesses and models a workflow may use, and that one lets an agent see quota
and context so it can choose well within those limits.

## Motivation

The `workflow-step-plan` run used the Large Spec Loop template with `codex-cli` /
`gpt-6-luna` as the workflow default and a `claude-cli` / `opus` orchestrator. From
pass 6 onward, the orchestrator began setting `harness: claude-cli, model: opus` on
the steps it queued. By pass 9 it used opus for every step, and it never went back:
steps 49–82 all ran on opus.

What the run record shows (`history show --step final:N`, and the spec's
`## Progress → Decisions`):

- **Pass 6:** "Steps 1 and 2 run on `claude-cli`/`opus`, because Codex has fallen
  short twice on each of these test tasks." The recorded decision is narrow:
  "Real-instance test steps run on `claude-cli`/`opus` from round 6."
- **Passes 7–8:** "the risky ones run on claude-cli/opus", then "Every step except
  step 4 runs on `claude-cli`/`opus`, because codex fell short in these areas
  again."
- **Pass 9:** "all on `claude-cli`/opus". From there on, every review recorded
  that the opus steps "did what they were asked", which reinforced the choice.
  Since no codex steps ran, nothing could argue for switching back.

The evidence behind the switch was real. Codex steps such as 25, 26, 40 and 45
implemented the code but skipped most of the tests they were asked for. Each one
reported that gap honestly. Context wasn't the cause: those steps ended at 28–62%
of a 258k window.

The trouble is that nothing pushed back on the ratchet:

- **No cost signal.** An opus step cost about $7–10 at API prices, against
  $0.03–0.22 for a Luna step, but the orchestrator never sees cost.
- **No quota signal.** The switch used up the user's Claude Code 5-hour window.
  The user then paused the run by hand near each limit, and paid about $15 of
  extra usage once.
- **No way to lose the decision.** The recorded decision covered only "real-instance
  test steps", but nothing held later passes to that scope. Each fresh pass read
  "opus did what was asked" and applied it more widely.
- **Weak guidance.** The `workflow-orchestrator` agent says "Prefer the workflow's
  default harness and model — omit `harness`/`model` on queued steps unless the
  prompt asks you to optimize per step." The Large Spec Loop prompt never asks for
  that, so the guidance says the switch shouldn't have happened. But it's a single
  soft sentence, and a quality argument outweighed it.

A user needs a hard limit they can rely on, and the orchestrator needs better
guidance inside that limit.

## Part 1: guidance (cheap, ship first)

These changes are prompt and template text only.

- **`workflow-orchestrator.agent.md`, `<harnessAndModel>`.** Allow a step to use a
  non-default harness or model only when there's evidence for it: a step on the
  default fell short at that _specific_ task. Escalate that task, not the rest of
  the round. Return to the default for the next task of a different kind. Every
  non-default choice is recorded with its reason, its scope, and a review point
  ("retry the default on the next test-heavy task"). Name the cost gap: the most
  capable models can cost 100× more per step.
- **Large Spec Loop and the bug hunt loop.** Under Decisions in the spec's
  Progress section, any harness or model escalation is listed with its scope. Each
  pass re-checks it: if the escalated steps are now outside that scope, queue them
  on the default.
- **Before escalating, fix the step.** Most codex shortfalls in this run were
  "did the code, skipped the tests". The cheaper first response is a better step
  prompt: smaller scope, tests listed as numbered deliverables, and "do the tests
  first". The run's own recovery after step 5 (splitting it into preparation
  steps) shows this works.

## Part 2: a hard policy in the workflow file

A new optional workflow-level field. This is an additive schema change (no
`schema:bump`), followed by `npm run schema:update`:

```yaml
harnessPolicy:
  # When present, only these may run. Omitted means every harness is allowed.
  allow:
    - harness: codex-cli
    - harness: copilot-cli # any model
    - harness: claude-cli
      models: [sonnet] # only these models on this harness
  # Applied after allow. Use it to block a model without listing everything else.
  deny:
    - harness: claude-cli
      models: [opus]
```

Rules:

- **One rule for every step source.** A step's effective harness and model are
  what it actually runs with after inheritance. They must pass `allow` (when
  present) and must not match `deny`. The check covers authored steps, the
  `finalStep`, MCP `append_step`/`edit_step`, CLI `ctrlyoke append` and
  `step edit`, dashboard edits, and sub-workflow children (D13 inline definitions
  and D14 lanes in `WORKFLOW_STEP_PLAN.md`).
- **Where it's enforced.**
  - At parse time and in `ctrlyoke validate`, as a diagnostic: the workflow's own
    defaults and authored steps must satisfy the policy, or the file is invalid.
  - In `validateStepHarnessAndModelCapabilities` (`src/mcp-server.ts`), which
    already checks harness ids and availability for MCP appends and edits. Give
    the error a clear code and list the allowed choices, so an orchestrator can
    correct itself.
  - The same check in the CLI append and edit paths and in the dashboard's
    step-edit route. Share one helper, `evaluateHarnessPolicy`, rather than three
    copies.
  - Once more at dispatch in `WorkflowExecutor`, as a backstop for steps that
    reach the queue by other paths, such as a run file edited outside ctrlyoke.
- **Sub-workflows.** A child runs under the intersection of its own policy and its
  parent's, so a child file can narrow the parent's policy but never widen it.
- **Model matching.** Harnesses name the same model differently: `opus`,
  `claude-opus-5-5` on Claude Code, and `claude-opus-5.5` on Copilot. Match through
  `ModelConstants` (the model's canonical id, plus a family alias such as
  `opus`), never by raw string, so `deny: [opus]` can't be bypassed by spelling the
  full id. Unknown names are rejected at parse time.
- **`list_harnesses` respects the policy.** It reports only allowed harnesses and
  models, plus a `policy` note, so the orchestrator never has to discover the
  limit by hitting an error.
- **Templates.** Large Spec Loop and the bug hunt loop expose an optional
  `harnessPolicy` choice in the template dialog, defaulting to "implementer
  harness only" for queued steps. Policy is per workflow, not per step, so the
  orchestrator's own final-step harness must be allowed too. The template has to
  account for that: either `allow` lists both harnesses, or the schema gets a
  `finalStep` exemption. Decide this during design.

## Part 3 (optional): a workspace or user default

A `defaults.harnessPolicy` setting in `schemas/settings-schema.json` applies when a
workflow declares none, and combines with a workflow's policy by intersection.
This needs workspace-trust handling, since a cloned repo shouldn't be able to widen
a user's policy (`WORKSPACE_FORBIDDEN_SETTING_ROOTS`). Narrowing is always safe.
Only build this if the per-workflow field proves too repetitive.

## Alternatives considered

- **An escalation budget** (`maxNonDefaultSteps: 10`) caps the ratchet, but it's
  harder to reason about than a list, and it still spends the most expensive
  model first. It can come later on top of a policy.
- **A quota-driven switch** (move to another harness when one runs low) belongs in
  `AGENT_USAGE_AWARENESS_PLAN.md`. Policy decides what's _allowed_; usage
  awareness decides what's _wise_ within it.

## Docs and tests

- Generated schema reference (`npm run schema:update`). Add a section to
  `docs/workflows/` on restricting harnesses, plus a CHANGELOG **Added** entry.
- Tests:
  - parser and validate diagnostics
  - `McpServer.test.ts` append/edit rejection with the allowed list in the error
  - CLI append/edit
  - dispatch backstop
  - sub-workflow intersection
  - model-alias matching (`deny: [opus]` blocks `claude-opus-5-5` and Copilot's
    `claude-opus-5.5`)
