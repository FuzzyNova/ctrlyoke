# Hosted viewer save writes through a pre-existing `<file>.cy-tmp` link outside the workspace

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`saveFile`)
- **Resolution:** fixed in this commit

## Symptom

Saving a file in the hosted workspace viewer can write the file's content to
an arbitrary location outside the workspace and replace the saved file with a
link to it.

## Steps to Reproduce

1. A repository contains `README.md` and a committed symlink
   `README.md.cy-tmp` -> `~/.bashrc` (or any path outside the workspace). A
   hard link has the same effect and was used to confirm it on Windows.
2. Open `README.md` in the hosted viewer, edit it, and save
   (`PUT /api/workspace-viewer/file`).
3. The new content is written to the link target outside the workspace, and
   the rename replaces `README.md` with the link.

Confirmed with an `npx tsx` probe: after
`saveFile({ path: "README.md", content: "ATTACKER-REACHED\n" })`, the
out-of-workspace target contained `ATTACKER-REACHED`.

## Root Cause

`saveFile` validates only the target (`safeResolve`), then writes to the
predictable sibling `${resolved}.cy-tmp` with `fs.promises.writeFile`, which
follows an existing symlink or hard link at that path, and renames it over the
target (`src/server/HostedWorkspaceViewerService.ts`, end of `saveFile`). The
temp path is never validated, and an existing entry there is not rejected.

## Suggested Fix

Create the temp file with exclusive create (`fs.promises.open(tmp, "wx")`)
and a random suffix (e.g. `crypto.randomBytes(6).toString("hex")`) in the
target's directory. Write through that handle, then rename. Unlink the temp
file when the write or rename fails, which also fixes the leftover `.cy-tmp` on
failure. Prefer reusing an existing atomic-write helper (`src/utils/AtomicFileUtils.ts`)
if it already provides these guarantees. Add a test where `<file>.cy-tmp`
already exists as a link to a file outside the workspace. The outside file
must stay unchanged and the save must still succeed or fail cleanly.
