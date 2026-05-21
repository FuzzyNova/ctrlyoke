---
applyTo: "src/git/**"
---

<purpose>
AI-assisted git utilities for commit-message generation and commit execution.

`src/git/` is intentionally small and split into three clear responsibilities:
- `CommitMessageGenerator.ts` gathers a repository diff and runs a one-shot AI harness execution to produce a commit message.
- `CommitMessageGenerationTracker.ts` stores the last generation record for UI consumers.
- `GitCommitter.ts` performs the actual `git commit` invocation.

Keep these boundaries sharp. Do not let tracker/UI concerns leak into commit execution, and do not turn `GitCommitter` into another orchestration layer. When this area changes, preserve the existing separation between diff collection, AI generation, provenance tracking, and final git commands.
</purpose>

<commitMessageGenerator>
**Primary role:** Convert local git changes into a clean commit message using the same harness stack FlightPath uses for workflows, but as a focused one-shot execution.

**Diff acquisition (`getDiff`)**
- First try `git diff --cached`. If staged content exists, prefer it and mark `staged: true`.
- If staged diff is empty, fall back to unstaged tracked changes via `git diff` plus untracked files via `git ls-files --others --exclude-standard`.
- Untracked files are converted into synthetic "new file" diff hunks by reading file contents directly.
- Return `null` when no usable changes are present.
- `DiffResult` includes `diff`, `staged`, `truncated`, `commands`, and `includesUntrackedFiles`.
- The diff is capped at **750 KB** (`MAX_DIFF_BYTES`). Preserve this safeguard unless the surrounding prompt budget and harness behavior are re-evaluated deliberately.
- Skip unreadable untracked files rather than failing the whole operation.

**Generation flow (`generateMessage`)**
- Resolve harness/model/prompt through `ConfigurationUtils.getCommitHarness()`, `getCommitModel()`, and `getCommitPrompt()`.
- Fall back from commit-specific harness setting to the normal integration mode when needed.
- Build a dedicated `ResolvedCliConfig` for headless execution:
  - `permissionMode: allowAll`
  - `cliExecutionMode: headless`
  - `resumeSession: false`
  - quiet/non-interactive behavior
- Use `CliAdapter + IntegrationFactory + WorkflowInstance` rather than inventing a separate execution path. This keeps commit-message generation aligned with the rest of FlightPath's harness behavior.
- Create the detector/execution integration with `IntegrationFactory.createForExecution(harness)` and pass that same instance back through the `WorkflowInstance` detector callback.
- Load the prompt via `WorkflowInstance.loadPromptString(...)`, not via prompt files on disk.

**MCP-first capture strategy**
- Preferred path is structured capture through the `flightpath_submit_commit_message` MCP tool.
- Probe for `out/mcp-server.js`; if present, register a one-off MCP server config with:
  - `FLIGHTPATH_WORKSPACE`
  - `FLIGHTPATH_COMMIT_OUTPUT`
- Store the temporary output file under `.flightpath/temp/` inside the workspace, then delete it best-effort after reading.
- When MCP capture is enabled, append the explicit instruction telling the harness to submit the message through the tool and not print it as plain text.
- Deny queue-management MCP tools for this path; commit generation should only need commit submission.

**Fallback extraction path**
- If MCP is unavailable or the tool is not called, fall back to `WorkflowInstance` response text extraction.
- Read the executed prompt step from `instance.promptQueue.getState()`.
- Reject empty results and reject runs where no prompt step actually executed.
- Sanitize the response aggressively:
  - strip `[Thinking]...[/Thinking]` blocks
  - strip file-operation annotations like `[Created: ...]`
  - strip wrapper code fences
  - strip whole-message backticks or surrounding quotes
- Keep the fallback narrowly focused on converting assistant output into a commit message, not on reformatting or editorial post-processing.

**Prompt construction**
- The full prompt is: configured commit prompt + diff + optional user instructions + optional MCP instruction line.
- `instructions` is treated as a user draft/guidance section, not a replacement for the configured system prompt.
- Preserve the distinction between repository diff content and user-provided drafting guidance.

**Cancellation and cleanup**
- If an `AbortSignal` is provided, hook it to `instance.stop()` and always remove the event listener in `finally`.
- After execution, surface cancellation as `Commit message generation cancelled`.
- Preserve best-effort cleanup of the MCP capture file.

**Global-setting suppression is intentional**
- `loadPromptString()` passes explicit null/suppressed values for `mcpServers`, `agent`, `skills`, `additionalArgs`, and `hooks`.
- This prevents unrelated VS Code/global settings from bleeding into commit generation.
- Do not remove this unless you intentionally want commit generation to inherit full workflow-level extension behavior.

**Return values and provenance**
- `generateMessage()` returns `{ message, prompt, cliCommand? }`.
- `cliCommand` comes from `CliIntegration.getLastSpawnedCommand()` when available and is used for provenance/debugging.
- `generate()` is only a convenience wrapper over `getDiff()` + `generateMessage()` and should stay thin.

**Modification guidance**
- Keep `CommitMessageGenerator` focused on generation, not committing.
- Prefer `execFile`-based git calls over shell-string execution.
- Preserve the current staged-first behavior; many SCM flows rely on commit generation reflecting the index, not every local file.
- If you add new metadata to generation results, thread it through `CommitMessageGenerationTracker` and UI consumers explicitly rather than hiding it in ad hoc response parsing.
</commitMessageGenerator>

<commitMessageGenerationTracker>
**Primary role:** Maintain the last commit-message generation record in memory for consumers such as the workspace viewer.

**Design constraints**
- This is a lightweight singleton exported as `commitMessageGenerationTracker`.
- `CommitMessageGenerationRecord` is the single source of truth for generation provenance:
  - `source`
  - `workingDirectory`
  - `commands`
  - `output`
  - `staged`
  - `truncated`
  - `includesUntrackedFiles`
  - `generatedAt`
  - optional `prompt`, `generatedMessage`, `cliCommand`
- `source` currently distinguishes `"scm"` vs `"workspace-viewer"` entry points.

**Behavior**
- `getLastRecord()` returns the current in-memory snapshot or `null`.
- `setLastRecord()` replaces the snapshot and synchronously notifies subscribers.
- `subscribe(listener)` registers a listener and returns an unsubscribe function.

**Modification guidance**
- Keep this class passive and memory-only. It is not a persistence layer, event bus, or history service.
- Preserve the unsubscribe-returning subscription pattern.
- If you extend the record shape, update all producers and consumers together.
- Avoid adding workflow execution logic, git commands, or formatting logic here.
- If notification semantics change, keep delivery deterministic and easy for UI code to reason about.
</commitMessageGenerationTracker>

<gitCommitter>
**Primary role:** Run the final git commands needed to create a commit.

**Current behavior**
- `commit(message, cwd, options?)` is intentionally minimal.
- If `options.addAll` is truthy, run `git add .` first.
- Then run `git commit -m <message>`.
- Uses promisified `execFile`, not shell interpolation.

**Design guidance**
- Keep this utility simple and side-effect-specific.
- Do not fold diff generation, AI prompting, tracker updates, or UI messaging into this class.
- Preserve `cwd`-scoped execution so callers control which repository is affected.
- If future git flags/options are added, model them explicitly in `CommitOptions` instead of building ad hoc command strings.
- Prefer argument arrays passed to `execFile` for safety and quoting correctness.
</gitCommitter>

<keyPatterns>
**Separation of concerns**
- `CommitMessageGenerator` = inspect changes + run harness + extract/sanitize message.
- `CommitMessageGenerationTracker` = store last generation provenance.
- `GitCommitter` = run git commands.

**Reuse existing FlightPath infrastructure**
- Commit generation should reuse `CliAdapter`, `IntegrationFactory`, `WorkflowInstance`, and normal harness resolution.
- Treat this as a focused workflow-style execution, not a special one-off subsystem with duplicated harness logic.

**Structured capture beats prose parsing**
- Prefer MCP tool submission over free-form response parsing whenever possible.
- Keep the text-extraction fallback robust, but secondary.

**Headless, one-shot execution**
- Commit-message generation is intentionally non-interactive:
  - headless mode
  - no session reuse
  - no inherited agent/skills/hooks bleedthrough
- Preserve that predictability unless product requirements explicitly change.

**Provenance matters**
- The generator records which git commands were used, whether staged content was used, whether the diff was truncated, whether untracked files were included, and optionally the spawned CLI command/prompt.
- When extending behavior, make provenance observable rather than implicit.

**Be careful with diff scope and prompt budget**
- Staged-first semantics and the diff size cap are product decisions, not incidental implementation details.
- Changing them affects UX, token usage, and trust in generated commit messages.

**Prefer explicit contracts**
- Keep exported result/record interfaces accurate and small.
- If multiple files need the same metadata, define it in a shared interface rather than duplicating shape assumptions.
</keyPatterns>
