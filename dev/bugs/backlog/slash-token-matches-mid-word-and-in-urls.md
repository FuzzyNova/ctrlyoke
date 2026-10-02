# `/skill:` and `/mcp:` match mid-word and inside URLs, force-attaching and rewriting the text

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced by bundling `CtrlYokeSlashTokens` with esbuild
- **Area:** `src/utils/CtrlYokeSlashTokens.ts` (`TOKEN_PATTERN`)
- **Severity:** medium

## Symptom

`scanCtrlYokeSlashTokens("open https://example.com/skill:commit now")` returns
`/skill:commit`. So do `x/skill:commit` and `foo/mcp:github`.

`CliPromptPreparer` (~202-205, ~321) then:

- force-attaches the skill, or enables the MCP server for the step
  (`McpServerNormalizer` ~72), and
- rewrites the outgoing prompt with `rewriteCtrlYokeSlashTokens`, so the user's
  URL becomes `https://example.comskill: commit`.

If the name isn't a discovered skill, the step gets a spurious unknown-skill
warning instead. The editor decorations (`atomicReferences.ts`,
`CodeMirrorEditor.tsx`) and `PromptLinkProvider` chip the same text.

## Steps to Reproduce

1. Write a prompt step containing `see https://example.com/skill:commit` (with
   a `commit` skill discovered), or a path such as `docs/mcp:github`.
2. Run it, or dry-run it, and look at the attached skills / MCP servers and at
   the prompt text sent to the harness.

## Root Cause

Every other trigger is built with `NOT_AFTER_BOUNDARY`
(`src/utils/ReferenceBoundary.ts`). `TOKEN_PATTERN` starts with a bare `\/`, so
a preceding filename character, or a URL's host or path segment, doesn't stop
the match. The ctrlyoke-syntax skill says a token directly after a letter,
digit, or filename character is not a reference.

## Suggested Fix

Prefix `TOKEN_PATTERN` with `NOT_AFTER_BOUNDARY`. Also refuse a preceding `/`,
`.` or `:`, so URL and path segments (`example.com/skill:x`, `a//skill:x`) never
match. A slash token is only a token at the start of the text or after
whitespace or opening punctuation such as `(` or `"`. Then check that
completions in `src/completions/` (`SlashTokenCompletionHelpers.ts`) still
trigger where tokens are valid.
