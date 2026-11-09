# Commit-message diff glues each untracked file's header onto the previous file's last line

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, node repro against `out/`)
- **Area:** `src/git/CommitMessageGenerator.ts` (`CommitMessageGenerator.getDiff`, untracked-file loop)
- **Severity:** medium

## Symptom

When nothing is staged (or with `ctrlyoke commit --all` / the dashboard's
commit-all path), `getDiff` builds a synthetic "new file" diff for each
untracked file. Every file after the first is malformed. Its `diff --git`
header is appended to the previous file's last `+` line, so the AI reads the
next file's header as an added line of the previous file. Each hunk header
also counts one line too many when the file ends with a newline (the usual
case).

With two untracked files, `a.txt` (`one\ntwo\n`) and `b.txt` (`three\n`):

```
diff --git a/a.txt b/a.txt
new file mode 100644
--- /dev/null
+++ b/a.txt
@@ -0,0 +1,3 @@        <- git says +1,2
+one
+two
+diff --git a/b.txt b/b.txt     <- b.txt's header is a "+" line of a.txt
new file mode 100644
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@        <- git says +1
+three
+
```

`git add -N . && git diff` gives the correct form for comparison. The
commit-message model gets a diff where every untracked file except the first
looks like part of its predecessor. That's the common "new feature with
several new files" case.

## Steps to Reproduce

```sh
mkdir -p /private/tmp/cydiff && cd /private/tmp/cydiff
git init -q && git commit -q --allow-empty -m init
printf 'one\ntwo\n' > a.txt && printf 'three\n' > b.txt
node -e 'new (require("<repo>/out/git/CommitMessageGenerator.js").CommitMessageGenerator)().getDiff(process.cwd()).then(r => process.stdout.write(r.diff))'
```

## Root Cause

In the untracked loop of `getDiff` (around `src/git/CommitMessageGenerator.ts:440-452`),
the body is appended as `lines.map((line) => "+" + line).join("\n")` with no
trailing newline, and the next iteration appends `diff --git ...` right
after it. `content.split("\n")` also yields a trailing empty element for
newline-terminated content, which inflates `lines.length` in the
`@@ -0,0 +1,N @@` header and emits a stray `+` line.

## Suggested Fix

Build each untracked file's body the way git does. Drop the trailing empty
element when the content ends with `\n`, use the real line count in the hunk
header (and `+1` rather than `+1,1` is optional), and end every emitted body
with `\n`. When the content doesn't end with a newline, add
`\ No newline at end of file\n`. Keep truncation accounting through `append`.
Add a `CommitMessageGenerator.test.ts` case with two untracked files that
checks that each `diff --git` header starts its own line and that the hunk
counts match.
