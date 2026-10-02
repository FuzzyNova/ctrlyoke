# Session management

Session management controls how one step picks up from another.

## The simple rule

- use `resumeSession: true` when the next step should continue the previous compatible conversation
- add `sessionId` (together with `resumeSession: true`) when you need to pick a specific conversation

`resumeSession` defaults to the `defaults.resumeSession` setting, which is `false` out of the box, so every step starts a fresh session unless you opt in. It can be set per step or once at the workflow level.

::: warning `sessionId` needs `resumeSession: true`
`sessionId` only chooses _which_ session to resume. When the effective `resumeSession` is `false`, it is ignored and the step starts a fresh session.
:::

## When to resume vs. start fresh

`resumeSession: true` shares the previous step's live conversation, so **only use it when the combined work fits one context window** — small, tightly-coupled steps like implement-right-after-plan on a focused change.

For **large features**, don't chain sessions: the full body of work won't fit a single context window, and an overstuffed session degrades quality. Instead, have an early step write a durable plan/design doc and give each later step its **own** session (`resumeSession: false`, the default), sharing context by referencing that doc:

```yaml
steps:
  - name: plan
    prompt: Analyze @src/ and write the implementation plan to docs/feature-plan.md.

  - name: implement
    prompt: Implement the feature per @docs/feature-plan.md.
    # resumeSession omitted → fresh session; the plan doc carries the context

  - name: review
    prompt: Review the implementation against @docs/feature-plan.md and fix any issues.
```

The written artifact is the shared memory: it survives across fresh sessions and keeps each step focused on its slice.

## Automatic resume

With `resumeSession: true` and no `sessionId`, ctrlyoke walks backwards from the current step and resumes the most recent earlier step that ran on the **same harness** and recorded a session ID. If none exists (for example on the first step), a new session starts.

## Numeric step references

Use a number to resume the session captured by an earlier step:

```yaml
steps:
  - name: analyze
    prompt: Analyze @src/

  - name: implement
    resumeSession: true
    sessionId: 1
    prompt: Implement the best fix from the analysis.
```

`sessionId: 1` means "use the session from step 1" (1-based). The reference should point to an earlier, completed step. If it points to the current or a later step, the referenced step has no recorded session yet, or it ran on a different harness, ctrlyoke logs a warning and starts a new session instead of failing the step.

## Exact session IDs

You can also provide a literal harness session ID:

```yaml
steps:
  - prompt: Continue the earlier work.
    resumeSession: true
    sessionId: "550e8400-e29b-41d4-a716-446655440000"
```

A literal ID is not checked against which harness created it, but it must match the
target harness's session-ID format. If it does not, ctrlyoke starts a new session
and logs why.

## Final-step session reference

`sessionId: "finalStep"` resumes the session established by the most recent `finalStep` execution. It works on any step, not just the final step itself. On the first pass, before any final step has run, a new session starts.

## Retries

End-condition retries continue the step's session by default. Set `endCondition.resumeSessionOnRetry: false` to start a fresh session for each retry. See [End conditions](/workflows/end-conditions).

## Harness-aware behavior

ctrlyoke does not share sessions across harnesses. Automatic resume skips earlier
steps that ran on a different harness, and a numeric reference to a step on another
harness starts a new session. A literal session ID is not checked against which
harness created it, but it must match the target harness's session-ID format;
otherwise ctrlyoke starts a new session and logs why.

## Sessions at a parallel group boundary

Parallel members resolve their effective properties from one immutable snapshot
at the point where the group starts. `resumeSession: true`, inherited defaults,
and numeric `sessionId` references therefore use only sessions completed before
the group, not a sibling that is starting in the same group. Numeric references
to another member of the group are rejected during parsing/preflight.

Every concurrently running prompt member must have a distinct effective session
for its harness. This collision check happens after workflow defaults,
step-level overrides, and automatic session resolution are applied, so two
members that inherit the same session are rejected before any member launches.
Different harnesses may use sessions with the same provider-specific ID because
session identity includes the harness.

Group members still share the workflow's workspace and one managed or named
worktree per run. Terminal controller arbitration is workflow-scoped rather
than session-scoped, even though each member receives its own terminal session
when required.
