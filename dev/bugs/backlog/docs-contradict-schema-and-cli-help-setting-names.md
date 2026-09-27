# Docs and `run --help` contradict the schema (field names, enum values, MCP-in-groups, frontmatter)

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli)
- **Area:** `docs/` guide pages, `src/cli/CliRunCommandDefinitions.ts`
- **Severity:** low

## Symptom

Several hand-written docs, and the CLI's own `--help`, say things the schema and code
disprove. A user following them writes invalid workflows or looks for settings that
don't exist. Each item below was checked against the code.

1. **Built-in MCP server in parallel groups.** `docs/troubleshooting/common-errors.md:94-95`:
   "The built-in server is rejected on a parallel-group member." It is allowed.
   `schemas/workflow-schema.json` `parallelGroupItem.description` says "Members may use
   the built-in ctrlyoke MCP server", `ParallelGroupPreflight.test.ts` ("reports
   interactive multiplexing without banning workflow mutation") asserts it, and a group
   with `mcpServers: [ctrlyoke]` passes `ctrlyoke validate --strict`. The yaml-format,
   json-format, and dynamic-queue pages already say the opposite.
2. **errorBehavior values.** `docs/workflows/end-conditions.md:170` lists
   "`stop`, `retry`, or `continue`". The enum is `["stopWorkflow", "retry", "continue"]`
   (`workflow-schema.json:1132`), so `stop` fails validation.
3. **Condition timeout field name.** `docs/cli/ctrlyoke.md:81` ("a condition's own
   `timeout` still wins") and `docs/troubleshooting/common-errors.md:82` ("`timeout` on
   the condition") name a field that doesn't exist. It is `timeoutSec`.
4. **`.prompt.md` frontmatter.** `docs/workflows/prompt-md-format.md:3` says "ctrlyoke
   does not parse YAML frontmatter in these files, so any frontmatter is sent to the
   harness as part of the prompt text." Since `96ef502f`,
   `PromptFileParser.parseMarkdownPromptFile` parses a leading `---` block as YAML (for
   `schemaVersion`), strips it from the prompt, and fails to load the file if the block
   is not valid YAML.
5. **`run --help` setting names.** `src/cli/CliRunCommandDefinitions.ts:163,168` say
   `execution.maxPromptTimeout` and `execution.scriptTimeout`. The settings are
   `execution.maxPromptTimeoutSec` and `execution.scriptTimeoutSec`
   (`schemas/settings-schema.json`).

## Steps to Reproduce

Compare each quoted line with the cited schema, code, or test.

## Root Cause

Hand-written prose and help strings drifted from the schema. Nothing checks these
pages the way `npm run check:docs` checks the generated reference pages.

## Suggested Fix

Correct each page to match the schema. For (4), document the current behaviour: an
optional YAML frontmatter block is read only for `schemaVersion`, stripped from the
prompt, and must be valid YAML. For (5), avoid a hardcoded copy of the setting key in
the help text: build it from the settings key constants if they exist, or at minimum
fix the strings and add a unit test asserting that every `execution.*` key named in
`run --help` exists in `schemas/settings-schema.json`. Grep `docs/` and `landing/` for
any other `timeout` / `stop` / MCP-in-group phrasing before closing.
