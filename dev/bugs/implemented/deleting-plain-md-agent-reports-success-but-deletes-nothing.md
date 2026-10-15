# Deleting a plain-.md agent reports success but deletes nothing

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/HarnessFileManager.ts`
- **Resolution:** fixed in this commit

## Symptom

In Agents & Skills settings, deleting some agents reports success (`HARNESS_FILE_OP_RESULT` with `success: true`), but the file stays on disk and the agent reappears on refresh. Affected files:

- a plain `foo.md` in `.agents/agents`, `~/.agents/agents`, or the VS Code user prompts dir
- a `foo.agent.md` in `.claude/agents` or the Antigravity agent dir

"Delete all" for the same target leaves the same files behind. Agents found in the second or a later dir of a target that has several dirs (for example, more than one VS Code user prompts dir) cannot be deleted either.

## Steps to Reproduce

1. Create `<workspace>/.agents/agents/reviewer.md` containing a minimal frontmatter agent.
2. Open the dashboard settings and go to Agents & Skills. The agent "reviewer" is listed under the Agents target (workspace scope).
3. Click Delete for that location and confirm.
4. The operation reports success, but `reviewer.md` still exists and "reviewer" is listed again after refresh. The code ran a forced `rm` on `.agents/agents/reviewer.agent.md`.
5. Variant: create `<workspace>/.claude/agents/x.agent.md`. It is listed as "x" under Claude. Deleting it removes `.claude/agents/x.md`, which does not exist and is ignored, so `x.agent.md` remains.

## Root Cause

Discovery and deletion work out the filename in different ways.

- `collectAgentLocations` (`src/utils/HarnessFileManager.ts:195-223`) accepts `.agent.md` or plain `.md` for the AGENTS and VSCODE targets. For targets whose extension is `.md`, it accepts any `*.md`, including `*.agent.md`. It strips the suffix to get the name and records the real file in `ManagedFileLocation.path`.
- `deleteFromHarness` (`src/utils/HarnessFileManager.ts:589-615`) ignores that path. It rebuilds the path at lines 604-609 as `path.join(getTargetDir(...), name + ext)`, where `ext` is `.agent.md` for special targets or `HARNESS_AGENT_EXTENSION[harnessId]` (`src/utils/HarnessDirectoryUtils.ts:56-63`). It then calls `fs.promises.rm(filePath, { force: true })`, and `force` hides the mismatch.
- `getTargetDir` returns only `dirs[0]` (`HarnessFileManager.ts:687`, `:704`), but discovery scans every dir.
- `handleDeleteFromHarness` (`src/ui/HarnessFileMessageService.ts:131-143`) does not pass on the discovered path, because the message does not carry it.
- `deleteAllFromHarness` (`HarnessFileManager.ts:622-646`) passes only `file.name` to `deleteFromHarness`, so it has the same defect.

## Suggested Fix

Make discovery and deletion use the same path.

- Preferred: before deleting, resolve the agent's actual file. In `deleteFromHarness`, run the same scan (or a shared helper), find the `ManagedFileLocation` entries that match `name`, `harnessId` and `scope`, and `rm` each `location.path`. `deleteAllFromHarness` can call `rm` directly on the matching `l.path` values.
- Alternative: add the discovered `path` to `DeleteFromHarnessMessage`, and check that it is inside one of the target's resolved agent dirs before deleting.
- Smaller fix: try every accepted filename (`name.agent.md` and `name.md`) in every dir returned for the target and scope, not only `dirs[0]`.
- Drop `force: true`, or check that at least one file was removed, so a delete that removes nothing reports an error instead of success.
- Add a test that discovers a plain `.md` agent in `.agents/agents` and a `.agent.md` agent in `.claude/agents`, deletes each one, and asserts the file is gone.

## Decision

In this checkout, `getAgentsWorkspaceAgentDir` resolves to `.agents` directly,
and discovery scans that directory without descending into an `agents` child.
This fix preserves the existing discovery scope and deletes the paths discovery
returns; the regression test uses `.agents/reviewer.md`.
