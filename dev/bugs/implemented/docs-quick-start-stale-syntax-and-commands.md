# QUICK_START.md examples don't validate and use a reference syntax that doesn't exist

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude, helper agent)
- **Area:** `QUICK_START.md` (shipped in the VSIX via `.vscodeignore`), `docs/reference/commands.md:74`, `schemas/workflow-schema.json` (`skills` description)
- **Resolution:** fixed in this commit

## Symptom

`QUICK_START.md` is the first doc many users read, and it's shipped with the extension.

- **Line 152 and line 226:** both examples use `returns: "true"` in `endCondition`. That field
  was removed (the schema has `{"not":{}}` with a "renamed to `expected`" note), so both example
  workflows fail `ctrlyoke validate`. Line ~233 describes `returns` as compared against stdout.
- **Lines 103, 114, 149 and 175:** every prompt example uses `#file:path`. No such reference
  syntax exists in `src/` (the file reference is `@path`), so the examples silently attach
  nothing.
- **Line 13:** says `copilot-cli` needs "`gh` with GitHub Copilot extension". The provider's
  install hint is `npm install -g @github/copilot` (`CopilotCliProvider.ts`).
- **Lines 40, 41 and 299:** name the commands "ctrlyoke: Create End Condition Script" and
  "Import Workflow Templates". Neither exists in `package.json` `contributes.commands`.
- **Lines 296-298:** "Further Reading" links to `docs/ADDING_NEW_CLI_HARNESS.md`,
  `docs/SESSION_MANAGEMENT.md` and `docs/QUEUE_APPEND_FEATURE.md`, which don't exist.
- **Line 275:** gives the third precedence tier as "VS Code extension settings". It is the
  `defaults.*` settings in `.ctrlyoke/settings.json`; `package.json` configuration is not a
  settings surface.

Also:

- **`docs/reference/commands.md:74`:** says "Add Output Channel to ctrlyoke" is also on "the
  Output panel title bar". `package.json` registers it only under `editor/context` (`inOutput &&
  !editorHasSelection`), with no `view/title` entry.
- **`schemas/workflow-schema.json` `skills` description:** says ctrlyoke "attaches each selected
  skill's content to the prompt". `SkillExpander` attaches only name, path and description for
  skills inside trusted roots (the harness reads `SKILL.md` itself). The full body is embedded
  only for skills outside them.

## Steps to Reproduce

1. Copy the `QUICK_START.md` YAML example at lines ~143-160 into `q.ctrlyoke.yaml`.
2. `ctrlyoke validate q.ctrlyoke.yaml` → `Validation failed: … /steps/0/endCondition/returns: must NOT be valid`.
3. `grep -rn "#file:" src` → no matches.

## Suggested Fix

- Rewrite the `QUICK_START.md` examples to use `@path` references and drop `returns:` (exit code
  0 is the default pass). Describe `compareSource`/`operator`/`expected` where it now talks about
  `returns`.
- Fix the Copilot prerequisite, the command names, the dead links and the precedence tier.
- Drop "and the Output panel title bar" from `commands.md`.
- Reword the schema `skills` description, then run `npm run generate-schema-docs` and
  `npm run generate-schema`.
- Check every YAML block in `QUICK_START.md` with `ctrlyoke validate --strict`.
