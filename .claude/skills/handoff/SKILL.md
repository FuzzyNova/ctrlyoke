---
name: handoff
description: Save current session state to a handoff file for pickup in a fresh Claude Code session. Use at end of session or when context is getting large.
---

Write a handoff file so a fresh session can pick up exactly where we left off.

## File location

- `/handoff` (no argument) → `.flightpath/.handoff.md`
- `/handoff <name>` (e.g. `/handoff auth-refactor`) → `.flightpath/.handoff-$ARGUMENTS.md`

This lets multiple concurrent sessions each have their own handoff without colliding.

## What to write

Be surgical. The next session has CLAUDE.md for project-wide context. This file is only for what is true _right now_ in this session.

1. **Active task** — the single thing we are working on. One sentence.
2. **Current state** — what is done, what is in progress, what is blocked. Bullet list.
3. **Next step** — the exact first thing the next session should do. Be specific (file, command, decision).
4. **Relevant files** — only files that matter for the current task. Full paths.
5. **Gotchas** — things we discovered that would waste time to re-discover. Only if they exist.

## What NOT to write

- General project architecture or conventions (that's in CLAUDE.md)
- Work completed earlier in the session that is no longer relevant to the current task
- Background info that isn't needed to continue

## After writing

Confirm the exact file path and tell the user to run `/pickup` or `/pickup <name>` in the new session.
