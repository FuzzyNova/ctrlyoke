# Agent and skill frontmatter ends at the first `---` anywhere and breaks on a UTF-8 BOM

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude, helper agent)
- **Area:** `src/utils/AgentExpander.ts` (`stripFrontmatter` ~L89), `src/utils/AgentDiscovery.ts` (`parseAgentFrontmatter` ~L48), `src/utils/SkillDiscovery.ts` (~L651)
- **Resolution:** fixed in this commit

## Symptom

1. **`---` inside a value.** An agent file whose frontmatter contains `---` inside a value (e.g.
   `description: Reviews diffs --- strictly`) is split at that `---`:
   - `stripFrontmatter` leaks the rest of the frontmatter (`strictly\nmodel: gpt-5\n---\n...`)
     into `<agentInstructions>`, and the "model override ignored" warning never fires.
   - `parseAgentFrontmatter` returns description `"Reviews diffs"`.
   - A `SKILL.md` with `description: Split docs on --- markers` is discovered with description
     `"Split docs on"`.
2. **UTF-8 BOM.** An agent or skill file saved with a BOM (`﻿---\n...`):
   - `stripFrontmatter` returns the whole file, frontmatter included.
   - `parseAgentFrontmatter` returns `{}`, so a plain `.md` agent is not discovered.
   - Skill descriptions come out empty.

## Steps to Reproduce

Verified with tsx probes against the real modules:

1. `AgentExpander.stripFrontmatter("---\nname: reviewer\ndescription: Reviews diffs --- strictly\nmodel: gpt-5\n---\nBODY", "reviewer")`
   → `"strictly\nmodel: gpt-5\n---\nBODY"` (expected `"BODY"`).
2. `parseAgentFrontmatter("﻿---\nname: reviewer\n---\nBODY")` → `{}`.

## Root Cause

All three sites find the closing fence with `content.indexOf("---", 3)`, which matches `---`
anywhere rather than a line that is exactly `---`. None of them call `stripLeadingBom`
(`src/utils/TextUtils.ts`). The earlier BOM fix (`workflow-file-utf8-bom-breaks-json-and-frontmatter`)
only covered `PromptFileParser`.

## Suggested Fix

Add one shared, line-anchored frontmatter splitter (BOM-stripped, the same shape as
`PromptFileParser`'s `/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/`) and use it at all three sites.
Add tests for `---` inside a value and for a BOM-prefixed file, for both agents and skills.
