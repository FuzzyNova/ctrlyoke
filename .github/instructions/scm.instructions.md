---
applyTo: "src/scm/**"
---

<purpose>
`src/scm/` is the VS Code Source Control surface for commit-message generation. Keep it thin and SCM-facing: Git input-box access, Source Control progress/cancellation UX, and command orchestration belong here; diff collection, prompt construction, harness execution, MCP capture, and message extraction belong in `src/git/`.

The directory currently still contains one file, `ScmCommitCommand.ts`, instantiated from `src/extension.ts`. If more SCM code is added, keep it as small command/helper classes rather than a broad SCM manager.
</purpose>

<scmCommitCommand>
`ScmCommitCommand` intentionally has very little state: one `CommitMessageGenerator` and one nullable `AbortController`.

**Current flow**

1. Use the first workspace folder as `cwd`; fail early if none is open.
2. Treat a second `execute()` call as cancel, not queueing.
3. Set `VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE`, then run `withProgress(...SourceControl...)`.
4. Read the Git SCM input box through `vscode.git`; pass its trimmed contents to `generateMessage(...)` as optional user instructions.
5. Call `generator.getDiff(cwd)` first; only call `generateMessage(...)` when a diff exists.
6. Persist the result through `commitMessageGenerationTracker` with the exact diff metadata from `getDiff()` plus `prompt` and `cliCommand` from `generateMessage()`.
7. Write the generated message back to the SCM input box when available.
8. Always clear `activeAbortController` and reset the context key in `finally`.

**Important boundaries**

- `src/scm/` owns VS Code SCM UX only.
- `src/git/CommitMessageGenerator.ts` owns staged-first diff discovery, fallback to unstaged/untracked content, one-shot workflow execution, MCP-based capture, and response cleanup.
- `src/git/CommitMessageGenerationTracker.ts` is shared beyond SCM: the hosted workspace viewer and webview/settings sync also consume the same record. Keep that tracker payload as the single source of truth instead of inventing SCM-only side channels.

**Gotchas**

- Capture the current abort controller inside the progress callback before awaiting; cleanup later nulls the field.
- Cancellation is silent by design; aborted runs should not surface error toasts.
- `getGitInputBox()` must stay defensive and optional; message generation still succeeds without a Git input box.
- The Source Control toolbar buttons are driven by `package.json` `when` clauses keyed off `VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE`, so any new active state must keep that context key accurate.
- Do not let SCM input-box targeting and diff generation drift to different repositories if multi-root support is ever added.
</scmCommitCommand>

<keyPatterns>
**Keep it orchestration-only**
- No prompt building, diff parsing, harness selection, or response extraction in `src/scm/`.

**Single in-flight operation**
- `activeAbortController` is the only active-state source; do not add overlapping generations.

**UI state must unwind in `finally`**
- Never leave `VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE` or the abort controller set after failures.

**Reuse shared constants and shared records**
- Use `DashboardConstants` command/context keys and keep tracker writes in sync with `CommitMessageGenerationRecord`.

**Test control-flow branches**
- If SCM behavior changes, cover cancellation, no workspace, no diff, missing Git extension/input box, and tracker writes. `HostedWorkspaceViewerService` tests already cover the shared generator contract from the non-SCM path; SCM tests should focus on VS Code integration and context-key behavior.
</keyPatterns>
