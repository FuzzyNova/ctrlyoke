# MCP Run Path Fields: Absolute `workingFile`, plus `runDirectory`

> **Status:** Implemented — absolute `workingFile` and `runDirectory` are now
> emitted by all four MCP response sites, with coverage for promoted and
> draft-only workflows.
>
> **Priority:** P2 — small, self-contained correctness fix. No new tool, no new
> reach.
>
> **Related:** `dev/implemented/USER_SCOPED_RUN_HISTORY_PLAN.md` (the change that
> broke this), `dev/implemented/WORKFLOW_CONTEXT_MENU_PLAN.md` (the
> dashboard-side answer to the same "where is this run?" question)

---

## Problem

`src/mcp-server.ts` reports a run's working file in four places, all the same
way — `path.relative(this.workspaceRoot, filePath)`:

| Site                 | Field                      | Line | Tools served                                |
| -------------------- | -------------------------- | ---- | ------------------------------------------- |
| `handleQueueStatus`  | `metadata.workingFile`     | 367  | `workflow_status`                           |
| `handleQueueAppend`  | `response.workingFile`     | 534  | `append_step`                               |
| `mutationResponse`   | `workingFile`              | 680  | `edit_step`, `remove_step`, `reorder_steps` |
| `handleGlobalStatus` | per-workflow `workingFile` | 994  | `global_status`                             |

`mutationResponse` is a shared response builder, so six agent-facing tools emit
the field across four code sites.

That was correct when run storage lived at `<workspaceRoot>/.ctrlyoke/.runs/`.
It is not correct now. `USER_SCOPED_RUN_HISTORY_PLAN.md` redirected
`WorkflowPaths.runsRoot()` through `projectStateRoot()`, so in the default
`user` storage mode a run file resolves to
`<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/<workflowKey>/run-<ts>/workflow.ctrlyoke.json`
— outside the workspace entirely. The emitted field is therefore now shaped
like:

```
../../../Users/<user>/.ctrlyoke/projects/ctrlyoke-3f9a2c71b947/.runs/fix-tests-2026-08-01T.../run-.../workflow.ctrlyoke.json
```

Three concrete harms:

1. **Silent misdirection.** The obvious reading of a bare relative path in a
   workspace-scoped tool response is "relative to the workspace" — which is
   exactly what it _was_ before the move. An agent that resolves it that way
   still lands somewhere valid-looking and wrong.
2. **Mode-dependent shape.** With `storage.runHistoryLocation: "workspace"` the
   same field stays short and tidy. One field name, two wildly different
   shapes, decided by a setting the caller cannot see.
3. **Nothing catches it.** `WorkflowPaths.assertContained` validates candidates
   against `runsRoot`, not against the workspace, so the path is legitimate —
   only its _presentation_ is broken.

### `handleGlobalStatus` is already internally inconsistent

That same response object emits an absolute `workspaceRoot` (line 1021) and an
absolute `worktree.worktreePath` alongside the relative `workingFile`, so a
caller cannot even infer a convention from one payload.

> **Historical note.** Until the LM tools were removed, `QueueOperations`
> (the shared module behind the four `vscode.lm` twins) returned `workingFile`
> as an **absolute** path while the MCP server returned it relative — an
> outright contract split between two tools of the same name. Those twins and
> `QueueOperations` are now deleted, so `mcp-server.ts` is the sole owner of
> these fields and this change has no second implementation to coordinate with.
> That is why the plan below touches only one file. Confirmed still true: no
> other module emits a `workingFile` **path** string — every other
> `workingFile:` in `src/core/**` is the `WorkingFile` object, not a path.

---

## Product Decision

Two changes, both to output fields only:

1. **`workingFile` becomes absolute** everywhere it is emitted — the value the
   caller can actually use, and the same convention `workspaceRoot` and
   `worktree.worktreePath` already follow in these responses.
2. **Add `runDirectory` beside it** — the containing run (or draft) directory.

No new tool. No new input field. No change to addressing, reach, or lifecycle.

### Why `runDirectory` earns its place

`extension.instructions.md` warns that ctrlyoke's storage layout is something
"the caller can neither violate nor exploit, so [it] only spend[s] context."
That test is written for tool _descriptions_ and _input_ fields, and it is worth
answering directly rather than skirting.

The run directory passes it: it is the one piece of storage layout a caller can
actually use, and its use is to hand a **human** a location. A step that hits a
problem, or the `ctrlyoke-tech-support` agent template, needs to say "here is
the run" — and after the user-scope move nothing else in the system can produce
that string. The directory is the useful unit rather than the file because
`workflow.ctrlyoke.json`, `manifest.json`, and `events.jsonl` all live in it, so
one path answers every follow-up question.

It is also strictly cheaper than the alternative that would otherwise appear:
without it, an agent that wants the run directory does `path.dirname` on the
working file, which is a layout assumption living in a model's head instead of
in `WorkflowPaths`.

### Privacy note

An absolute path under the user's home exposes the OS username to the harness's
context. This is not new — `worktree.worktreePath`, `workspaceRoot`, and every
file the agent touches already do — and it is a deliberate consequence of run
history living in the home directory. Worth stating once in the change, not
worth mitigating.

---

## Implementation

### One sanctioned derivation

`WorkflowPaths.ts` declares itself "the _only_ module allowed to construct a
`.runs` path from raw parts." Keep that true: add the derivation there rather
than calling `path.dirname` at four call sites.

Place it beside `parseWorkingFileAddressFromPath` (`src/utils/WorkflowPaths.ts`,
~line 455), which already establishes the precedent of deriving identity from a
working-file path by directory shape alone, with no `workspaceRoot` and no
containment check, on the grounds that the path is one ctrlyoke itself
persisted:

```ts
/**
 * The run (or draft) directory containing a working file. Every working-file
 * path is built as `path.join(runDir|draftDir, WORKING_FILE_NAME)`, so the
 * parent is the directory by construction — this exists so callers do not
 * encode that layout fact themselves.
 */
export function runDirectoryForWorkingFile(workingFilePath: string): string {
  return path.dirname(path.resolve(workingFilePath));
}
```

`mcp-server.ts` may import it — it already imports `WorkflowPaths` (for
`manifestPath`, `runFilePath`, `draftFilePath`), and the module is vscode-free
as `extension.instructions.md` requires.

### Call sites

**`src/mcp-server.ts`** — four sites:

- `handleQueueStatus` (367): `workingFile: workingFile` (the local already holds
  `selected.filePath`), add
  `runDirectory: WorkflowPaths.runDirectoryForWorkingFile(workingFile)`.
- `handleQueueAppend` (534): same substitution on `selected.filePath`. Add
  `runDirectory: string` to the local `response` type literal declared just
  above (~line 484), which lists `workingFile: string` explicitly.
- `mutationResponse` (680): same on `selected.filePath`. This is the shared
  builder for `edit_step`/`remove_step`/`reorder_steps`, so one edit covers all
  three — do **not** push the change out to the three callers.
- `handleGlobalStatus` (994): same on the per-workflow `filePath`, which is
  already resolved through `runFilePath`/`draftFilePath` in both branches — so
  drafts get their draft directory and no branch is special-cased.

Drop the now-unused `path.relative` calls; `path` stays imported (still used by
`readCapabilities`, `manifestPath` call sites, and others).

That is the whole code change. `src/mcp-server.ts` plus one helper in
`WorkflowPaths` — there is no second consumer to update now that the LM tools
and `QueueOperations` are gone.

### Documentation

`docs/reference/mcp-tools.md` was rewritten since this plan was first drafted:
it now documents `append_step`'s real `steps`/`position`/`source` schema and the
three step-mutation tools. It still documents no response shapes at all, so
nothing there is invalidated by this change. It still omits `global_status` and
`submit_commit_message` from its tool table; fixing that is adjacent, optional,
and explicitly not required here.

Tool _descriptions_ in `McpToolDefinitions.ts` stay untouched: response fields
are not described there, and per the instruction file they should not be.

---

## Tests

`src/test/unit/McpServer.test.ts` builds a real run under a temp workspace via
its `createRun` helper — which returns a `RunFixture` carrying the absolute
`runFilePath` — and reads responses with `responseJson`. These are additions to
an existing harness rather than new scaffolding. No existing assertion covers
the emitted path value, so nothing needs updating.

Assert against `run.runFilePath` and `path.dirname(run.runFilePath)`:

- `workflow_status` emits an absolute `workingFile` equal to the run file on
  disk, and a `runDirectory` that is its parent.
- `append_step` emits the same two fields with the same values.
- One step-mutation tool (`edit_step` suffices — the other two share
  `mutationResponse`) emits both fields.
- `global_status` emits both fields for every listed workflow, including one
  that has never been promoted (draft branch → draft directory).
- Neither field ever begins with `..` — the direct regression guard, and the
  one assertion that would have caught this at the time.

---

## Acceptance Criteria

- `workingFile` is absolute in all four MCP sites (six tools) and resolves,
  unmodified, to the run file on disk.
- `runDirectory` is present beside it in all four, and is the directory that
  actually contains `workflow.ctrlyoke.json`, `manifest.json`, and
  `events.jsonl`.
- Draft-only lineages in `global_status` report their draft directory
  rather than being skipped or emitting a run path.
- Both fields are identical in shape under `storage.runHistoryLocation` of
  `user` and `workspace`; only the location differs.
- No tool description, input schema, addressing rule, or cross-workflow reach
  changes.

## Non-goals

- A new MCP tool for paths, or any expansion of `global_status`'s
  selector.
- Exposing `manifest.json` / `events.jsonl` paths individually — `runDirectory`
  covers them.
- Adding `global_status` / `submit_commit_message` to
  `docs/reference/mcp-tools.md` (missing for unrelated reasons).
- Any change to `CTRLYOKE_WORKING_FILE` addressing or to the "one attached run"
  model.
