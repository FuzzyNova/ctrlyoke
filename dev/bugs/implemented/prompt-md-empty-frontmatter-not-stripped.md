# `.prompt.md` with an empty frontmatter block is not stripped and can swallow the first paragraph

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/core/PromptFileParser.ts` (`parseMarkdownPromptFile`)
- **Resolution:** fixed in this commit

## Symptom

- Content `---\n---\nHello world`: the prompt sent to the model is
  `---\n---\nHello world`, frontmatter markers included.
- Content `---\n---\nIntro text\n\n---\n\nMore text`: the prompt is
  `More text`. `---\nIntro text` was parsed as frontmatter YAML (it loads as a
  plain string, no error) and "Intro text" vanished silently.

`docs/workflows/prompt-md-format.md` says the optional leading block is
removed from the prompt.

## Steps to Reproduce

Parse a `.prompt.md` file with either content above via
`PromptFileParser.parseMarkdownPromptFile`.

## Root Cause

The regex `/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u` (~line 571) requires a
newline before the closing `---`, so an empty block never matches as written
and the lazy group extends to the next `\n---` in the body.

## Suggested Fix

Allow an empty body, e.g. `/^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u`,
and treat an undefined capture as empty frontmatter. Also reject frontmatter
that does not load to an object (or null) with a clear error instead of
silently accepting a string. Add parser tests for both inputs above.
