# Session management

Session management controls how one step picks up from another.

## The simple rule

- use `resumeSession: true` when the next step should continue the previous compatible conversation
- use `sessionId` when you need something more explicit

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

## Numeric step references

Use a number to resume the session captured by an earlier step:

```yaml
steps:
  - name: analyze
    prompt: Analyze @src/

  - name: implement
    sessionId: 1
    prompt: Implement the best fix from the analysis.
```

`sessionId: 1` means "use the session from step 1".

## Exact session IDs

You can also provide a literal harness session ID:

```yaml
steps:
  - prompt: Continue the earlier work.
    sessionId: "550e8400-e29b-41d4-a716-446655440000"
```

## Final-step session reference

The schema also supports `sessionId: "finalStep"` to resume the most recent final-step session.

## Provider-aware behavior

ctrlyoke does not blindly reuse sessions across harnesses. If a later step switches harness, the session resume logic only reuses compatible sessions.

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
