# Commit message generation reads every untracked file in full and can OOM the extension host

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts` (`CommitMessageGenerator.getDiff`, untracked-file fallback)
- **Resolution:** fixed in this commit

## Symptom

When nothing is staged, commit-message generation (SCM button, hosted dashboard
commit panel, `ctrlyoke commit`) reads every untracked, non-ignored file into
memory as UTF-8, builds a `+line` copy of every line, and joins everything before
applying the `MAX_DIFF_BYTES` (750 KB) cap. A single large untracked file (a log,
dataset, build artifact someone forgot to ignore) therefore costs several times its
size in memory in the extension host. With a 200 MB untracked `big.log`, a copy of
the loop died with `FATAL ERROR: Reached heap limit … JavaScript heap out of memory`
after ~28 s at ~4 GB. In VS Code that shows up as an extension-host crash
(see the OOM notes in `.github/copilot-instructions.md`).

Binary untracked files are also decoded as UTF-8 and pushed into the prompt as
mojibake.

## Steps to Reproduce

1. In a repo with at least one commit and nothing staged, create an untracked
   200 MB text file (`yes x | head -c 200000000 > big.log`) that isn't ignored.
2. Click "Generate commit message" (or run `ctrlyoke commit`).
3. Memory climbs into the GBs; the extension host (or CLI) dies with a V8 heap OOM
   instead of generating a message from a truncated diff.

## Root Cause

`getDiff` (`CommitMessageGenerator.ts` ~243–258) loops over
`git ls-files --others --exclude-standard -z` and calls
`fs.readFile(path.join(cwd, filePath), "utf8")` for each file with no size check,
then `content.split("\n")` and `lines.map((l) => "+" + l).join("\n")`. The
truncation to `MAX_DIFF_BYTES` only happens at the end (~269–271), on the combined
string, so it does not bound memory.

## Resolution Details

`getDiff` now applies a running byte budget to tracked changes and untracked-file
content. It uses `lstat` to skip non-regular files, bounded reads for text files,
and a Git-style binary-file line when the sample contains NUL. Temporary-repo
tests cover an oversized untracked file and a binary file.
