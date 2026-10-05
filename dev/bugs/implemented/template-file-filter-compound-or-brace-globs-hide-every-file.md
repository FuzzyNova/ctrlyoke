# Template `fileFilter` globs with a compound extension or braces make every file unselectable

- **Found:** 2026-10-03 by bug-hunt final step (claude-cli); reproduced by running `extractExtensionsFromGlobs` and reading the modal's matcher
- **Area:** `src/utils/fileFilterUtils.ts` (`extractExtensionsFromGlobs`), `src/ui/webview-react/components/workflow/FileBrowserModal.tsx` (`filterExts` / `matchesFilter`, ~84-102), `src/ui/WorkflowSerializer.ts` (native dialog filters, ~1099-1104)
- **Resolution:** fixed in this commit

## Symptom

A template variable with `type: file` and a `fileFilter` such as
`["**/*.prompt.md"]`, `["**/*.ctrlyoke.yaml"]` or `["**/*.{md,txt}"]` opens a
file browser in which every file is dimmed and cannot be selected — including
the files the filter was written for. This happens in both the VS Code webview
and the hosted dashboard.

| `fileFilter`             | Extracted           | `x.prompt.md` | `a.ctrlyoke.yaml` | `a.md` |
| ------------------------ | ------------------- | ------------- | ----------------- | ------ |
| `["**/*.prompt.md"]`     | `["prompt.md"]`     | no match      | no match          | no     |
| `["**/*.ctrlyoke.yaml"]` | `["ctrlyoke.yaml"]` | no match      | no match          | no     |
| `["**/*.{md,txt}"]`      | `["{md,txt}"]`      | no match      | no match          | no     |

`*.prompt.md` and `*.ctrlyoke.yaml` are ctrlyoke's own workflow file shapes, so
a user-written template that asks for a workflow file hits this directly. The
bundled templates only use single-extension globs (`**/*.md`), which is why it
went unnoticed.

## Steps to Reproduce

1. Create a template whose `_templateMeta.variables.spec` has `type: file` and
   `fileFilter: ["**/*.prompt.md"]`.
2. Open it from the template dialog and click Browse.
3. Every file, including `foo.prompt.md`, is dimmed and the Select button stays
   disabled.

## Root Cause

`extractExtensionsFromGlobs` strips the `**/*.` prefix and keeps the rest
verbatim as the "extension" (`prompt.md`, `{md,txt}`). `FileBrowserModal`'s
`matchesFilter` then compares that to `entry.name.slice(lastIndexOf(".") + 1)`,
i.e. only the final extension segment (`md`), so a multi-segment extension can
never match, and a brace group is compared as a literal string.

The native `showOpenDialog` path in `WorkflowSerializer` gets the same
malformed list (`{md,txt}` is not an extension VS Code understands).

## Suggested Fix

- In `extractExtensionsFromGlobs`, expand a single brace group
  (`**/*.{md,txt}` → `md`, `txt`; also `**/*.{prompt.md,yaml}`), and drop
  anything still containing glob metacharacters (`*`, `?`, `[`, `{`) as today.
- In `FileBrowserModal.matchesFilter`, match with a case-insensitive
  `name.endsWith("." + ext)` instead of comparing only the last dot segment, so
  `prompt.md` and `ctrlyoke.yaml` work.
- Add unit tests for `extractExtensionsFromGlobs` and a `FileBrowserModal.test.tsx`
  case for a compound-extension filter and a brace filter.
