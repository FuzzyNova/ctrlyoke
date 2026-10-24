# Workspace-mode run files let an agent rewrite pending steps' execution properties

- **Found:** 2026-10-23 by the "end condition okay to add" step (claude-cli)
  while working out the MCP step-control security boundary
- **Area:** `src/core/PromptQueue.ts`, `src/utils/WorkflowPaths.ts`,
  `src/core/RunContinuationService.ts`
- **Resolution:** fixed in this commit

## Symptom

With `storage.runHistoryLocation: "workspace"`, a run's live definition
(`<workspace>/.ctrlyoke/.runs/<workflowKey>/run-*/workflow.ctrlyoke.json`)
is inside the workspace. A harness sandbox gives the agent write access
there, for example codex-cli `workspace-write`, or claude-cli edits
auto-approved for the working directory.

The runner treats that file as the source of truth for pending steps. An agent
can therefore give a later step any execution property by editing JSON, with
no MCP call and no approval prompt:

- a raw `endCondition`/`preCondition` `script` (the rule that MCP accepts only
  author-written condition presets is bypassed);
- `toolPermissions: { "mode": "dangerouslyAllowAll" }`;
- `additionalArgs`, `hooks`, stdio `mcpServers`, `secrets`;
- a new script step.

Each of these runs a program or widens what a later harness may do without
asking. That is exactly what the MCP surface is designed not to allow (see
`dev/bugs/implemented/mcp-edit-step-additional-args-can-widen-harness-permissions.md`
and the "Rejected: agent-authored condition scripts" section of
`dev/backlog/MCP_STEP_EXECUTION_CONTROLS_PLAN.md`). The trigger to worry about
is prompt injection steering the agent, not a malicious user.

User mode (the default) isn't affected the same way. There the run file is
under `~/.ctrlyoke/projects/...`, which ctrlyoke never passes to a harness as a
writable directory (`CliProviderUtils.getWorkspaceDirs`). That keeps the MCP
tools the only unprompted way to change a pending step. `storage` is a
workspace-forbidden setting (`WORKSPACE_FORBIDDEN_SETTING_ROOTS`), so a
repository can't switch a user into workspace mode. Only users who chose it are
exposed, hence medium rather than high.

Confirmed by reading the code; not yet reproduced end to end.

## Steps to Reproduce

1. Set `storage.runHistoryLocation: "workspace"` in user settings and reload.
2. Run a two-step workflow on codex-cli with the default sandbox. Step 1's
   prompt tells the agent to add
   `"endCondition": { "script": "node -e \"require('fs').writeFileSync('pwned.txt','x')\"" }`
   to step 2 in the run's `workflow.ctrlyoke.json` (the path is in
   `CTRLYOKE_WORKING_FILE` and in `global_status`).
3. When step 1 completes, the runner merges the disk definition. After step 2,
   ctrlyoke runs the script outside codex's sandbox and `pwned.txt` appears.

## Root Cause

- `WorkflowPaths.runsRoot(stateRoot)` (`src/utils/WorkflowPaths.ts:163`) puts
  run storage under `<stateRoot>/.ctrlyoke/.runs/` in workspace mode, which
  sits inside every harness's workspace root.
- `PromptQueue.commitStepOutcomeAndAdvance` calls `mergeDiskStepsWhileLocked()`
  at every step settlement (`src/core/PromptQueue.ts:1019`), and
  `mergeDiskSteps` (`:1730`) takes each step's definition from disk and only
  `_runtime` from memory (`{ ...diskStep, _runtime: runtime }`). The comment
  says it directly: "Disk owns order and topology".
- That is by design: the dashboard, `ctrlyoke step edit`, and the MCP tools are
  separate processes, and the run file is how they talk to the runner. Nothing
  tells a write made by ctrlyoke apart from a write made by anything else.

## Suggested Fix

You can't stop a process running as the same OS user from writing a file.
"Only ctrlyoke may edit run files" therefore can't be enforced on the file
itself. It can be enforced by **refusing to honor** a definition that no
ctrlyoke writer produced, as long as the proof lives somewhere the agent can't
write.

That place already exists: the user-local state home (`~/.ctrlyoke`), which
harness sandboxes don't get as a writable root. The proof needs integrity, not
secrecy, so a hash is enough; a signing key the sandbox can read (codex reads
the whole disk) would add nothing.

1. **Definition anchor.** Every ctrlyoke write of a run definition goes through
   `WorkingFileManager`/`RunContinuationService` (dashboard, CLI and MCP all
   do). After each write it records
   `sha256(stableStringify(stripStepRuntime(definition)))` and the
   `definitionRevision` in a small anchor file under the user state home, keyed
   by project, workflow key and run ref. Write it in **both** storage modes, so
   user mode gets the same check for free.
2. **Verify on merge.** `mergeDiskStepsWhileLocked` hashes the disk definition
   and compares it with the anchor. If they match, merge as today. If they
   don't, keep the in-memory definition, write it back over the tampered file,
   log it, and emit a timeline event plus a dashboard warning that names the
   step and what changed. Don't fail the run: a rejected edit is safe to ignore.
3. **Verify on load.** A run resumed from disk whose definition doesn't match
   its anchor opens as read-only until the user accepts it in the dashboard or
   with an explicit `ctrlyoke` command. That follows the shape of the
   `PersistedSchemaGuard` read-only path.
4. **Older runs.** A run with no anchor (written before this change, or copied
   from another machine) gets one on first load and is trusted from then on.
   That matches today's behavior, and history synced through OneDrive/Dropbox
   keeps working.
5. Keep `events.jsonl`, `manifest.json`, and `_runtime` out of the anchor. They
   aren't definitions, and the executor appends to them constantly.

**Interim mitigation, cheap enough to ship first:** extend the
`storage.runHistoryLocation` description in `schemas/settings-schema.json` to
say that workspace mode keeps live run definitions where an agent with
workspace write access can change a pending step's scripts and permissions, so
it's only for trusted agents and repositories. Then run `npm run schema:update`.

Rejected alternatives:

- **Narrowing the disk merge to "safe" fields.** The dashboard legitimately
  adds steps with conditions, permissions and script steps through the same
  file, so an allow-list of fields would break it or need the anchor anyway.
- **A warning only.** It records the risk but leaves a real bypass of the
  boundary the MCP tools now enforce. The anchor also protects user mode
  against an unsandboxed agent that writes there by mistake.
- **Moving workspace-mode definitions to the user home.** That defeats the
  point of workspace mode, which is to keep history beside the project.

Tests: PromptQueue merge with a matching and a tampered anchor (the tampered
`endCondition` must not reach the executor), the resume-load read-only path,
the legacy no-anchor path, and a CLI `step edit` plus MCP `edit_step`
round-trip that updates the anchor.
