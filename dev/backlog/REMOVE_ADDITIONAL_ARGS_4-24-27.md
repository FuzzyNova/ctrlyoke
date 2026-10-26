# Remove the deprecated `edit_step` `additionalArgs` input

**Status:** Waiting. Earliest removal: 2027-04-24 (see "When" below).

Last reviewed against code: 2026-10-26

## Background

`edit_step` used to let an MCP agent set or clear a pending step's `additionalArgs`, which go
straight onto the harness command line. That let an agent add permission-bypass flags with no
approval prompt
(`dev/bugs/implemented/mcp-edit-step-additional-args-can-widen-harness-permissions.md`). The fix
kept `additionalArgs` in `MCP_STEP_UPDATE_SCHEMA` (`src/utils/McpToolDefinitions.ts`), marked it
deprecated, and made `handleStepEdit` (`src/mcp-server.ts`) reject any call that sets or clears
it before touching the run. This plan removes the deprecated schema entry under the policy in
"Deprecations" in `CONTRIBUTING.md`.

## When

Not before **both**:

1. The deprecation has shipped in a tagged release. Done: it shipped in `0.3.0` (tag `v0.3.0`,
   2026-10-24), under **Changed** in `CHANGELOG.md`.
2. Six months have passed since that release, so the earliest removal date is 2027-04-24, matching
   the filename.

Ship the removal in the next minor release after that date, not a patch.

## Changes

- **Schema:** delete the `additionalArgs` property from `MCP_STEP_UPDATE_SCHEMA`. That also drops
  it from `MCP_STEP_UPDATE_FIELDS` and `MCP_STEP_CLEARABLE_FIELDS`, which are derived from the
  schema's keys.
- **Types:** drop the `Omit<…, "additionalArgs">` and `additionalArgs?: string[]` override from
  `McpStepUpdateArguments`, and drop the `formatArgString` branch from `toWorkflowStepUpdates`
  (`src/mcp-server.ts`).
- **Keep the rejection.** Don't delete the `additionalArgs` check in `handleStepEdit`. The MCP
  server doesn't validate `updates` against the schema, and `toWorkflowStepUpdates` filters
  unknown keys silently. Without the check, a call carrying `additionalArgs` alongside other
  edits would apply those edits and quietly drop the argument, so the agent would assume its
  flags were set. Either keep the explicit check (its message can drop "deprecated") or replace
  it with strict rejection of every unknown `updates` key and `clearProperties` entry, so the
  error names the field.
- **Tests:** keep "rejects setting or clearing additionalArgs without applying other edits" in
  `src/test/unit/McpServer.test.ts` passing, and add a check that `tools/list` no longer
  advertises `additionalArgs` for `edit_step`.
- **Docs:** remove the deprecated-input sentence from the `edit_step` bullet in
  `docs/reference/mcp-tools.md`.
- **Changelog:** add an entry under `## [Unreleased]` saying that `edit_step` no longer lists
  `additionalArgs` and that calls using it still fail without applying any edits.

## Out of scope

Workflow and settings `additionalArgs` (authored by the user) are unaffected and stay.
