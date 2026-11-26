# `history prune` deletes the run history of a repository on an unmounted volume

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced with `node out/cli.js` and a macOS disk image)
- **Area:** `src/utils/ProjectStateLifecycle.ts` (`classifyStatePath` ~365-399)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke history prune` classifies a project whose repository lives on an ejected or
unmounted volume (external disk, disk image, network mount mounted under `/Volumes`,
`/mnt` or `/media`) as `ORPHAN`, and `--yes` deletes its whole
`<ctrlyokeStateHome>/projects/<slug>-<hash>/` directory. Remounting the volume brings
back the repository but not its history. Nothing goes to the trash.

## Steps to Reproduce

```bash
export CTRLYOKE_HOME=/tmp/cyhunt/home
hdiutil create -size 20m -fs APFS -volname CYHUNTVOL /tmp/cyhunt/t.dmg
hdiutil attach /tmp/cyhunt/t.dmg
mkdir -p /Volumes/CYHUNTVOL/repo && cd /Volumes/CYHUNTVOL/repo
printf 'name: v\nsteps:\n  - type: script\n    script: echo hi\n' > v.ctrlyoke.yaml
ctrlyoke run v.ctrlyoke.yaml -q        # history list shows 1 run
cd /tmp && hdiutil detach /Volumes/CYHUNTVOL
ctrlyoke history prune --yes
```

Output:

```
ORPHAN /tmp/cyhunt/home/projects/repo-ba13344ec8d0 (statePath: /Volumes/CYHUNTVOL/repo)
Deleted /tmp/cyhunt/home/projects/repo-ba13344ec8d0
```

After re-attaching the image, `ctrlyoke history list` in the repository is empty.

## Expected

`docs/cli/ctrlyoke.md` (~623): "Inaccessible repository paths are reported as unknown and
are never deleted." A repository on a volume that is not mounted is inaccessible, so it
should be `UNKNOWN` and kept.

## Root Cause

On `ENOENT`, `classifyStatePath` walks up to the nearest existing ancestor and returns
`MISSING` whenever that ancestor is a directory. For `/Volumes/<name>/repo` the nearest
existing ancestor is `/Volumes`, which always exists, so an absent volume is
indistinguishable from a deleted repository. Linux `/mnt/<x>`, `/media/<user>/<x>` and
`/run/media/<user>/<x>` behave the same. Only UNC paths are special-cased. The re-check
just before deletion (~92) calls the same function, so it does not catch it either.

(A missing Windows drive letter is already safe: the walk reaches the drive root without
statting it and returns `UNKNOWN`.)

## Suggested Fix

Return `UNKNOWN` when the nearest existing ancestor is a mount container, i.e. the path
lies under a mount point that is not currently mounted. On POSIX, treat these as mount
containers: `/Volumes`, `/mnt`, `/media`, `/media/<user>`, `/run/media/<user>` (keep
the list as one named constant). The list alone covers the reported case and errs on the
side of keeping history, which is what the documented guarantee asks for. Recording each
project's volume identity at registration would be more precise but needs an additive
registry field, so it is not required for this fix.

Tests (`src/test/unit/ProjectStateLifecycle*.test.ts` or the existing prune tests): a
project whose `statePath` is `/Volumes/<random-missing>/repo` (and `/mnt/<missing>/repo`
on non-Windows) is `UNKNOWN` and survives `prune` with `--yes`; a repository deleted from
an ordinary temp directory is still `MISSING`/`ORPHAN` and deleted.
