---
applyTo: "src/git/**"
---

<purpose>
`src/git/` stays intentionally narrow:

- `CommitMessageGenerator` turns local changes into a one-shot AI commit-message run.
- `CommitMessageGenerationTracker` holds the latest generation record for UI consumers.
- `GitCommitter` performs the final `git commit`.

Do not turn this folder into a second workspace-viewer git service. The hosted workspace viewer owns its own stage/unstage/commit/push/pull commands in `HostedWorkspaceViewerService`; `src/git/` exists for shared commit-message generation plus the minimal CLI commit helper.
</purpose>

<commitMessageGenerator>
**Diff semantics**

- Keep the staged-first contract: try `git diff --cached` first, then fall back to unstaged tracked changes plus synthetic hunks for untracked files.
- `DiffResult` metadata (`commands`, `staged`, `truncated`, `includesUntrackedFiles`) is part of the product surface; SCM, hosted workspace viewer, and UI provenance all depend on it.
- Preserve the 750 KB diff cap unless prompt-budget behavior is deliberately reworked.

**Execution model**

- Commit generation must reuse normal ctrlyoke harness plumbing: `CliAdapter` + `IntegrationFactory` + `WorkflowInstance`.
- This run is intentionally headless and one-shot: `resumeSession: false`, quiet mode, and explicit suppression of inherited `mcpServers`, `agent`, `skills`, `additionalArgs`, and `hooks`.
- Resolve harness/model/prompt through the commit-specific `ConfigurationUtils` getters, with fallback to the normal harness when no commit harness override is set.

**Capture flow**

- Preferred capture path is the `submit_commit_message` MCP tool exposed by `src/mcp-server.ts`.
- The temporary capture file lives under `.ctrlyoke/temp/` in the workspace and should remain best-effort cleanup only.
- Commit-generation runs are persisted as system-generated lineages and their timeline is available through normal run storage. If MCP capture is unavailable or unused, the fallback message text still comes from the integration's in-memory `onResponseComplete` listener (`capturedResponseText`), not by re-reading that run's `events.jsonl`; keep sanitization narrowly focused on removing wrapper noise, not rewriting the message.

**Cross-file contracts**

- `generateMessage()` returns `{ message, prompt, cliCommand? }`; `prompt` and `cliCommand` are consumed for provenance, not just debugging.
- Current writers are `ScmCommitCommand` and `HostedWorkspaceViewerService`; CLI `commitCommand` also calls the generator directly.
- Preserve `AbortSignal -> instance.stop()` wiring and listener cleanup.
  </commitMessageGenerator>

<commitMessageGenerationTracker>
- This is a passive in-memory singleton, not persistence and not history.
- Writers currently live outside `src/git/`: `ScmCommitCommand` and `HostedWorkspaceViewerService`.
- Readers/subscribers include `CtrlYokeWebviewProvider` and `WebviewSettingsSync`, and the record shape is mirrored in webview message types. Change the interface, producers, and consumers together.
</commitMessageGenerationTracker>

<gitCommitter>
- Keep `GitCommitter` tiny and side-effect specific: it is currently the CLI commit helper, not a general git facade.
- Use `execFile` argument arrays and explicit `CommitOptions`; do not build shell command strings.
- Do not mix diff generation, tracker writes, UI messaging, or workspace-viewer orchestration into this class.
</gitCommitter>

<keyPatterns>
- Staged-first diff selection and the large diff cap are deliberate UX/product choices.
- Structured MCP submission is the primary path; prose parsing is only a fallback.
- `src/git/` should stay reusable across CLI, SCM, and hosted viewer entry points without owning their surrounding UI/server workflows.
</keyPatterns>
