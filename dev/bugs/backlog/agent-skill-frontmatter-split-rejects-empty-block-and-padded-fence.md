# Agent/skill frontmatter split rejects an empty block and a closing fence with trailing spaces

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/utils/DiscoveryUtils.ts` (`splitMarkdownFrontmatter`), consumers `src/utils/AgentDiscovery.ts`, `src/utils/AgentExpander.ts`, `src/utils/SkillDiscovery.ts`; duplicate regex in `src/core/PromptFileParser.ts`
- **Severity:** medium

## Symptom

`splitMarkdownFrontmatter` returns `null` for two common, valid frontmatter shapes:

```text
"---\n---\n# Body\n"                         => null   (empty block)
"---\nname: a\nmodel: x\n--- \n# Body\n"     => null   (closing fence has a trailing space)
```

(verified with `npx tsx` against the current source.) Every consumer treats
`null` as "no frontmatter":

- `AgentDiscovery.parseAgentFrontmatter` returns `{}`, so an agent whose closing
  fence has trailing whitespace loses its `name`/`description`/`skills`, and
  the docs (`docs/workflows/agents-and-skills.md`) say discovery only lists
  agents whose frontmatter has a `name` or `description`.
- `AgentExpander.stripFrontmatter` returns the whole file, so the raw YAML
  block (including any `model:`/`tools:` keys ctrlyoke deliberately ignores) is
  injected verbatim into the `<agentInstructions>` sent to the harness, and the
  "ignored model/tools override" warnings are never logged.
- `SkillDiscovery.extractDescriptionFromFrontmatter` returns `""`, so the skill
  is listed without a description.

Commit f2af7f870 fixed exactly these two shapes for `.prompt.md` files by
rewriting the regex in `PromptFileParser.parseMarkdownPromptFile`, but did so
with a second, private copy of the regex instead of fixing the shared helper,
so agent and skill files still have the old behaviour.

## Steps to Reproduce

1. Create `.github/agents/demo.agent.md` with `---\nname: Demo\ndescription: d\n--- \nBody` (note the space after the closing `---`).
2. Open the agent picker / reference the agent in a step.
3. The agent is not discovered by name, or, when referenced, its instructions
   contain the literal YAML block.

## Root Cause

`DiscoveryUtils.ts:19` uses `/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u`, which
requires at least one newline-terminated body line before the closing fence
and does not allow `[ \t]*` after it. `PromptFileParser.ts:571` carries the
corrected pattern privately.

## Suggested Fix

Move the corrected pattern into `splitMarkdownFrontmatter` (empty block yields
`frontmatter: ""`; closing fence allows trailing `[ \t]*`), and make
`PromptFileParser.parseMarkdownPromptFile` call `splitMarkdownFrontmatter`
instead of its own regex so there is one source of truth. Keep the existing
`.prompt.md` behaviour (empty/whitespace frontmatter → `{}`, non-mapping →
error). Add unit tests for both shapes in the DiscoveryUtils/AgentExpander
tests.
