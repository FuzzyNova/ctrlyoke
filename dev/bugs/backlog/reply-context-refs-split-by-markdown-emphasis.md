# Context references in replies break on `__name__` path segments and mis-anchor repeated tokens

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/components/output/MarkdownText.tsx`
- **Severity:** medium

## Symptom

Since 0ad28a538, agent replies link ctrlyoke references (`@path`,
`#selection:`, `#sym:`, `~commit`, …). A reference whose path contains a
double-underscore segment, which is very common (`__tests__`, `__init__`,
`__mocks__`), is broken apart by Markdown strong emphasis and links the wrong
target:

| Reply text                                   | Renders as                                                          |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `Changed @src/__tests__/foo.test.ts today`   | link `@src/` ("Reveal src/") + bold **tests** + `/foo.test.ts`      |
| `Changed @pkg/__init__.py today`             | link `@pkg/` + bold **init** + `.py`                                |
| `See #selection:src/__tests__/a.test.ts:3-5` | not linked at all                                                   |
| `See #sym:src/a.py:__init__:1-2`             | bare-path button for `src/a.py` + bold **init**; the `#sym` is lost |

Clicking the `@src/` link reveals the parent directory instead of the file.
`findAtomicReferences` on the raw string returns each of these as one correct
reference. The parser is correct; the way it is applied is not.

A second, smaller defect is in the same function. When a text node contains
an escape (e.g. `a\_b`) and the same token appears twice (`~abc1234 and
~abc1234`), the second reference is re-anchored onto the first one's source
range. Find-in-output then marks the wrong occurrence active, and
`countRangedReferenceMatchesBefore` double-counts the first range.

## Steps to Reproduce

Render `<MarkdownText contextReferences>` (the reply path in `OutputRow`) with
`Changed @src/__tests__/foo.test.ts today`.

## Root Cause

`remarkContextReferences` (`MarkdownText.tsx` ~234-284) runs
`findAtomicReferences` separately on each mdast `text` node. That happens after
inline parsing, which has already turned `__tests__` into a `strong` node, so
the token is spread across several nodes.

For the second defect, the escape fallback
`source.indexOf(raw, nodeStart)` (~259) always searches from the start of the
node, not from after the previous match.

## Suggested Fix

Detect references on the raw source before inline emphasis parsing can split
them. For example, find reference spans in the raw Markdown (outside code
spans, fences and links) and protect them before Streamdown parses inline
syntax. Either backslash-escape the emphasis characters inside each span, or
use a micromark syntax extension that claims reference tokens as a single
inline construct. Keep `data-ref-source`/`data-ref-start`/`data-ref-end`
correct against the original source, so find decorations still align.

For the re-anchor defect, search from the end of the previous anchored match
(`Math.max(nodeStart, previousEnd)`).

Bare (non-`@`) paths through `remarkFileLinks` have the same emphasis split. If
the fix lands in a shared pre-parse step, cover them too; otherwise leave them.
