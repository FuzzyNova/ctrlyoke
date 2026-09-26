# Coordination attribution labels every unattested participant an "external session"

- **Found:** 2026-09-26 by step 0 (claude-cli) of the coordination test workflow, seen live
- **Area:** `src/mcp-server.ts` (`participantAttribution`), `src/ui/webview-react/utils/coordinationPresentation.ts`
- **Severity:** low: misleading text; no behaviour change

## Symptom

A ctrlyoke parallel-group member using the `ctrlyoke-coordination-tools` skill is registered
as `kind: "ctrlyoke-step"`, `attested: false`, `via: "cli"`, with a full run address. Every
tool response still attributes it as:

```
from "<workflowKey>:0" (unattested external session), untrusted
```

The dashboard renders the same wording (`CoordinationActivityPanel`, `OutputRow`
coordination rows). So each ctrlyoke-launched step in skill mode, which is every step for
enterprise users with MCP disabled, is described as an external agent. Decision 9 requires
the attestation state to be shown accurately. This text reports the wrong participant
**kind** instead.

## Root cause

Both attribution helpers branch on `attested` only, and map `false` to "external session":

- `participantAttribution()`, `src/mcp-server.ts:168-173`
- `coordinationParticipantAttribution()` and `COORDINATION_UNATTESTED_LABEL`,
  `src/ui/webview-react/utils/coordinationPresentation.ts:6-12`

`CoordinationEntry.from` doesn't carry `kind`, so the webview helper can't tell these cases
apart even if it wanted to. Only the participant record has `kind`.

## Suggested fix

Derive the wording from `kind` and `attested` together: `attested ctrlyoke step`,
`unattested ctrlyoke step (skill/CLI)`, and `unattested external session`. Add `kind` to
`CoordinationEntry.from`, which is already denormalised for exactly this purpose. Then have
the server and the webview share one helper, so the two strings can't drift. Today the same
wording is hand-copied into both files.

## Planning Note (2026-09-26)

`participantFromEntry()` in `src/core/orchestration/ExecutionRootCoordination.ts` already infers
`kind` from whether `entry.from.address` is present when a join entry lacks a full participant
record. Once `kind` is carried on `from`, derive it the same way for entries written before the
field existed, so older boards still get the right label. The shared attribution helper must be
importable by both `src/mcp-server.ts` and the webview. The webview already imports from
`@root/utils/*` and `@root/types/*`, so put it in `src/utils/` or `src/types/`, not in
`src/ui/webview-react/`.
