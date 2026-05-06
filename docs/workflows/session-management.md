# Session management

Session management controls how one step picks up from another.

## The simple rule

- use `resumeSession: true` when the next step should continue the previous compatible conversation
- use `sessionId` when you need something more explicit

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

FlightPath does not blindly reuse sessions across harnesses. If a later step switches harness, the session resume logic only reuses compatible sessions.
