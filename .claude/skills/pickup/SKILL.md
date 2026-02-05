---
name: pickup
description: Resume from a handoff file created by /handoff. Reads the context, then deletes the file so it doesn't linger.
---

Resume a previous session from a handoff file.

## File location

- `/pickup` (no argument) → `.flightpath/.handoff.md`
- `/pickup <name>` (e.g. `/pickup auth-refactor`) → `.flightpath/.handoff-$ARGUMENTS.md`

## Steps

1. Read the handoff file at the path above.
2. Surface its contents clearly — this is the context for this session.
3. Delete the file. It has been consumed. Run: `rm ".flightpath/.handoff.md"` or `rm ".flightpath/.handoff-<name>.md"` as appropriate.
4. Confirm deletion and say you are ready to continue.

## If the file doesn't exist

List any files matching `.flightpath/.handoff*.md` and suggest the correct `/pickup <name>` command based on what's there.
