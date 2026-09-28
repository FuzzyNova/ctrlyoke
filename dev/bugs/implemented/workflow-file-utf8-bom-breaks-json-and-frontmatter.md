# A UTF-8 BOM breaks `.ctrlyoke.json` loading and `.prompt.md` frontmatter

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/core/PromptFileParser.ts` (`parsePromptFile` JSON branch, `parseMarkdownPromptFile`)
- **Resolution:** fixed in this commit

## Symptom

A workflow file saved with a UTF-8 byte-order mark is handled differently depending on
its type. A BOM is common on Windows: VS Code's "UTF-8 with BOM" encoding, and
PowerShell 5.1 `Set-Content -Encoding UTF8`. Reproduced by calling `parsePromptFile` on
files starting with `﻿`:

| File | Result | Expected |
| --- | --- | --- |
| `x.ctrlyoke.yaml` | loads (js-yaml strips the BOM) | loads |
| `x.ctrlyoke.json` | returns `null`; logs `Unexpected token '﻿' … is not valid JSON` | loads |
| `x.prompt.md` with `---\r\nschemaVersion: 1\r\n---\r\nDo the thing` | frontmatter not recognised; the prompt is the whole file including the `---` block | prompt `Do the thing` |

The same files without a BOM parse correctly, including CRLF frontmatter.
`docs/workflows/prompt-md-format.md` says ctrlyoke removes the frontmatter block from the
prompt.

## Steps to Reproduce

1. Save a valid `.ctrlyoke.json` workflow as "UTF-8 with BOM" in VS Code.
2. Try to run or validate it (`ctrlyoke validate <file>`). It fails to parse.
3. Do the same with a `.prompt.md` that has frontmatter. The frontmatter is sent to the
   harness as part of the prompt.

## Root Cause

`PromptFileParser` reads files with `fs.readFile(filePath, "utf8")`, which keeps the
BOM. The JSON branch calls `JSON.parse(content)` directly (`~line 172`), and the
Markdown frontmatter regex is anchored with `^---` (`~line 546`), so a leading `﻿`
defeats both. Nothing in `src/` strips a BOM.

## Suggested Fix

Strip one leading `﻿` in a single place, where `PromptFileParser` reads workflow
file content, so the YAML, JSON and Markdown paths all see the same text. If other
readers of workflow files exist (e.g. working-file or template loading), have them share
that helper. Add tests for each extension with a BOM: JSON loads, Markdown frontmatter is
stripped and applied, and YAML still loads.
