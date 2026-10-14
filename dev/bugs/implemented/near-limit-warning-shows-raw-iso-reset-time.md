# Near-limit quota warning shows the reset time as a raw UTC ISO string

- **Found:** 2026-10-14 by Claude Code (capturing the D19 near-limit warning for `docs/guide/usage-and-stats.md`)
- **Area:** `src/core/harness/shared/usage/UsageSelectionAssist.ts`
- **Resolution:** fixed in this commit

## Symptom

The pre-run warning toast reads:

> Quota warning: 1 remaining AI attempt queued. Claude Code's week window is 15% used and
> resets at 2026-10-18T20:00:00.000Z.

The reset time is a machine timestamp in UTC. Everywhere else the dashboard shows the same
moment in local time ("resets 3:00 PM Sun" in the harness picker tooltip), so a user in
UTC-5 sees two different-looking times for one reset.

## Steps to Reproduce

1. Set **Settings → Stats & Usage → Usage warning threshold** below a harness's current quota
   (e.g. 5 with Claude Code's week window at 15%), with fresh quota data (run any interactive
   Claude Code step first; Claude's quota is fresh for 5 minutes).
2. Start a workflow with a queued Claude Code step.
3. The warning toast's "resets at" value is an ISO string.

## Root Cause

`formatResetTime` (`UsageSelectionAssist.ts:50-54`) returns `new Date(resetAt).toISOString()`.
The message is built in the extension host and sent as plain text to VS Code and to hosted
browsers, so no client-side formatting applies.

## Suggested Fix

Format the reset with the same helper the harness picker tooltip uses (local time, short
weekday for resets more than a day away), or send `resetAt` as structured data and let each
client format it. Update the `UsageSelectionAssist` tests that pin the message text. Then
capture D19 (`docs/guide/usage-and-stats.md#near-limit-warning`); the demo project's
`docs-quota-warmup` and `docs-quota` workflows reproduce it without spending AI tokens beyond one
"OK" reply.
