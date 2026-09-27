# Commit-message prompt fence is broken by ``` inside the staged diff, re-activating references

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts` (diff fencing), `src/utils/FileReferenceParser.ts` (`maskFencedCodeBlocks`)
- **Severity:** medium

## Symptom

`CommitMessageGenerator` wraps the staged diff in a fixed ```` ```diff … ``` ```` fence.
Its own comment explains why: to stop diff content from being read as ctrlyoke reference
triggers. It gives the example of `+<!DOCTYPE html>`, which "parsed as an inline
`!DOCTYPE` secret grant and hard-failed the run at preflight".

That protection fails whenever the diff itself contains a triple-backtick line, which is
routine for any staged Markdown change with a code block (README, docs, `dev/bugs/*.md`).
The first `+```` in the diff closes the outer fence, so the added code block's contents
are **unmasked**.

Reproduced by building the prompt exactly as `CommitMessageGenerator` does, for a staged
`README.md` diff that adds an HTML code block, then running the real parsers (vitest):

```
+```html
+<!DOCTYPE html>
+<p>see @src/secret.ts and $previous</p>
+```
```

- `parseSecretReferences(prompt)` → `[{ name: "DOCTYPE", ... }]` (the preflight hard-fail
  the fence exists to prevent)
- `parseAtReferences(prompt)` → `[{ path: "src/secret.ts" }]` (a file gets attached to the
  commit prompt)
- `parseInlinePriorContextRefs(prompt)` → `[{ kind: "previous" }]`
- `maskFencedCodeBlocks(prompt)` masks the diff header and the `+```` tail, but leaves the
  three added lines in between untouched.

## Steps to Reproduce

1. Stage a Markdown file that adds a fenced block containing `<!DOCTYPE html>` (or
   `@some/path`, `$previous`, `/skill:x`).
2. Run the ctrlyoke commit-message command (SCM button or `ctrlyoke commit`).
3. Generation fails at secret preflight on `!DOCTYPE`, or the unmasked references are
   expanded into the prompt.

## Root Cause

- `CommitMessageGenerator.ts:~348` uses `"```diff\n" + diff + "\n```"`, with no regard
  for backtick runs inside `diff`.
- `maskFencedCodeBlocks` (`FileReferenceParser.ts:47`) matches `/```[\s\S]*?```/g`, i.e.
  the next three backticks anywhere. It does not support longer fences, whose closer must
  be at least as long as the opener.

## Suggested Fix

1. Make `maskFencedCodeBlocks` support CommonMark-style variable-length fences: an opening
   run of N ≥ 3 backticks closes only at a run of at least N backticks. Keep existing
   ```` ``` ```` behaviour for ordinary prompts, and keep the trigger-character set. This
   function is the single masking point for every reference parser, so the fix applies
   everywhere.
2. In `CommitMessageGenerator`, fence the diff with a run one longer than the longest
   backtick run inside the diff (minimum 3). Put that in a small shared helper, e.g.
   `fenceLiteral(text, info)` next to `maskFencedCodeBlocks`, so other places that fence
   untrusted text can reuse it.
3. Tests:
   - `maskFencedCodeBlocks` masks triggers inside a 4-backtick fence that contains a
     3-backtick block.
   - Existing 3-backtick behaviour is unchanged.
   - A commit-prompt test where a staged diff adds a Markdown code block with
     `<!DOCTYPE html>`, `@path` and `$previous`: `parseSecretReferences`,
     `parseAtReferences` and `parseInlinePriorContextRefs` return nothing for the built
     prompt.
