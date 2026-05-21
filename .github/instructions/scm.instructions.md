---
applyTo: "src/scm/**"
---

<purpose>
`src/scm/` contains VS Code Source Control integration code for FlightPath. This directory should stay focused on SCM-facing command orchestration: reading and writing the Git SCM input box, coordinating VS Code progress and cancellation state, and delegating actual diff/message generation to shared git services.

Today the directory contains a single file, `ScmCommitCommand.ts`, which is registered from `src/extension.ts` as the `flightpath.generateCommitMessage` command. Keep `src/scm/` thin and UI-oriented. Do not move git diff collection, prompt construction, harness execution, or commit message generation logic into this directory — those responsibilities belong in `src/git/`.

If `src/scm/` grows beyond one file, prefer small, focused command/helper classes over a broad SCM manager. Registration stays in `extension.ts`; `src/scm/` should provide command implementations, not extension activation wiring.
</purpose>

<scmCommitCommand>
`ScmCommitCommand` is a straightforward one-operation class with two pieces of state: a `CommitMessageGenerator` instance and a nullable `activeAbortController`. There is intentionally no base command class.

**Primary responsibilities**

- Resolve the working directory from the first open workspace folder.
- Manage a single in-flight generation operation through `AbortController`.
- Toggle `VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE` while generation is active so VS Code UI contributions can react.
- Show progress with `vscode.window.withProgress(..., { location: vscode.ProgressLocation.SourceControl })`.
- Read the existing SCM input-box text and pass it to `CommitMessageGenerator.generateMessage(...)` as optional user instructions.
- Call `CommitMessageGenerator.getDiff(cwd)` and `generateMessage(diff, cwd, signal, existingText)`.
- Write the generated message back into the Git SCM input box when available.
- Record the run with `commitMessageGenerationTracker.setLastRecord(...)` using the exact diff metadata returned by the generator.
- Show user-facing information/warning/error messages for empty diffs, truncated diffs, unstaged generation, and failures.

**Non-responsibilities**

- Do not reimplement diff discovery in `src/scm/`; use `CommitMessageGenerator.getDiff(cwd)`.
- Do not construct AI prompts or invoke harness integrations directly here; that belongs in `CommitMessageGenerator` and the git/workflow layers it already uses.
- Do not introduce duplicate tracking state when `commitMessageGenerationTracker` already captures the generation record.
- Do not hardcode shared context keys or command IDs; use constants from `src/types/DashboardConstants.ts`.

**Execution flow**

1. `execute(context)` returns an error message if no workspace folder is open.
2. If a generation is already active, `execute()` cancels the current run and returns immediately instead of starting a second one.
3. A new `AbortController` is stored in `activeAbortController` and `VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE` is set to `true`.
4. `withProgress()` runs in Source Control UI with `cancellable: true`.
5. Inside the progress callback, capture the current abort controller before any further awaits so later cancellation cannot race with `this.activeAbortController` being cleared.
6. `token.onCancellationRequested(() => abortController.abort())` must forward UI cancellation into the same shared abort signal used by the generator.
7. `getGitInputBox(cwd)` reads the SCM input box; any existing text is trimmed and passed to the generator as `existingText`/instructions.
8. `generator.getDiff(cwd)` determines whether there is anything to summarize. If it returns `null`, show an informational message and stop.
9. `generator.generateMessage(...)` produces the message and returns additional debug metadata (`prompt`, `cliCommand`).
10. Save a full generation record through `commitMessageGenerationTracker` so other UI surfaces can inspect the last run.
11. Warn when the diff was truncated, write the message into the SCM input box when one exists, and inform the user when the message was generated from unstaged changes.
12. In `finally`, always clear `activeAbortController` and restore `VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE` to `false`, even on cancellation or failure.

**Cancellation semantics**

- `cancel()` only aborts the current controller. Cleanup happens in `execute()`'s `finally` block.
- Calling `execute()` while a generation is active is treated as a cancel action, not as a queue request.
- Any new async work added to the command must honor the same abort signal and must not outlive the active operation.
- Cancellation is silent by design; aborted runs return without showing failure toasts.

**Git extension integration**

- `getGitInputBox(cwd)` is the only helper that talks to the VS Code Git extension API.
- It uses `vscode.extensions.getExtension("vscode.git")?.exports`, calls `getAPI(1)`, and selects the repository whose `rootUri.fsPath` matches `cwd`, falling back to the first repository when needed.
- Keep this helper defensive: the Git extension may be unavailable, uninitialized, or have no matching repository. Fail soft and return `undefined` instead of throwing.
- Writing to the SCM box is optional. Generation can still succeed even if no input box is available.

**Data flow contract with `src/git/`**

- `ScmCommitCommand` owns VS Code UX and SCM integration.
- `CommitMessageGenerator` owns diff retrieval, prompt assembly, harness/model/config resolution, one-shot workflow execution, and final message extraction.
- `commitMessageGenerationTracker` is the shared handoff point for anything else in the extension that wants to inspect the most recent generation.
- Preserve this separation. If new behavior needs git or AI logic, prefer extending `src/git/` rather than bloating the SCM command.

**Workspace assumptions**

- Current behavior uses the first workspace folder as the commit-generation target.
- If multi-root selection is ever introduced, update all of these together: cwd resolution, `getGitInputBox(...)`, progress/error text if it names the target, and the `workingDirectory` recorded in `commitMessageGenerationTracker`.
- Do not let the SCM input box and the generated diff come from different repositories.
  </scmCommitCommand>

<keyPatterns>
**Keep the command thin**
- `ScmCommitCommand` should orchestrate existing services, not become a second commit generator.
- Prefer private helpers for SCM/UI-specific concerns only.

**Preserve the single in-flight model**

- `activeAbortController: AbortController | null` is the source of truth for whether generation is active.
- Do not add parallel generation support unless the entire UX and state model are redesigned.

**Always clean up UI state**

- Any path that sets `VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE` to `true` must guarantee it is reset to `false` in `finally`.
- Never leave the context key or abort controller set after an exception.

**Graceful failure over hard failure**

- Missing workspace folder, missing diff, missing Git input box, or unavailable Git extension should be handled with friendly UX and safe early returns.
- Reserve error toasts for real failures, not normal "nothing to do" states.

**Reuse shared constants and logging**

- Use `VSCODE_CONTEXT_KEYS` and any command/context constants from `DashboardConstants` rather than duplicating literal strings.
- Use `Log.error(...)` for operational failures before showing a user-visible error message.

**Keep tracker records complete**

- When generation succeeds, store the exact diff metadata (`commands`, `staged`, `truncated`, `includesUntrackedFiles`, `prompt`, `generatedMessage`, `cliCommand`) returned by the generator.
- If new metadata is added to commit generation, thread it through the tracker instead of inventing a second side channel.

**SCM-specific UX belongs here; generation policy does not**

- Source Control progress location, SCM input box reads/writes, and context-key toggling belong in `src/scm/`.
- Harness choice, model choice, MCP/tool capture, and prompt wording belong in `src/git/CommitMessageGenerator.ts` and related infrastructure.

**Registration remains external**

- `ScmCommitCommand` is instantiated and registered in `src/extension.ts`.
- Do not add activation/registration logic inside `src/scm/` files.

**Testing guidance for future changes**

- If behavior changes, add or update tests under `src/test/` that mock the Git extension API, SCM input box state, progress cancellation, and tracker writes.
- Test cancellation, missing workspace, missing diff, and missing Git extension separately; these are the main control-flow branches in this directory.
  </keyPatterns>
