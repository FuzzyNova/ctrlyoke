# SCM / Commit Message Generation — Implementation Plan

**Date:** 2026-04-03 (revised 2026-05-09)
**Purpose:** Generate conventional commit messages using the workspace's configured FlightPath harness. Three integration points share a single core implementation:

| Surface           | What it does                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **VS Code SCM**   | Button in the SCM title bar — generates message, populates the SCM input box                       |
| **CLI**           | `flightpath commit` subcommand — generates message then runs `git commit -m`                       |
| **Hosted server** | Button beside the existing hosted commit textarea — generates a message, populates the textarea    |

---

## 0. Current-Codebase Audit Notes

This plan was re-audited against the current codebase before implementation. A few details in the original draft needed correction:

- The hosted workspace viewer already has a concrete SCM surface: `src/ui/webview-react/components/workspace-viewer/WorkspaceCommitArea.tsx`, rendered from `WorkspaceSourceControlPane.tsx` in both desktop and mobile layouts.
- Hosted SCM actions currently use **REST endpoints** (`/api/workspace-viewer/...`) backed by `HostedWorkspaceViewerService`, not WebSocket message types in `DashboardConstants.ts`.
- The hosted dashboard already has a manual **Commit** button. The new work is a **Generate Commit Message** button beside the textarea, not a replacement for the existing commit flow.
- `WorkspaceCommitArea` already has a Vitest file, and the server already has a unit test file for `HostedWorkspaceViewerService`; both should be extended as part of implementation.
- `package.json` currently uses built-in codicon strings for commands. The VS Code SCM command should use the mini FlightPath SVG asset directly rather than an invented `$(flightpath-logo)` product icon ID.

## 1. Shared Settings

Because all three surfaces share the same generation logic, commit settings belong in the **shared** settings layer (`src/types/FlightPathSettings.ts` + `schemas/settings-schema.json`), not in VS Code's `package.json` contributes only.

### `src/types/FlightPathSettings.ts` — add `commit` section

```typescript
// In FlightPathGlobalSettings interface
commit: {
  harness: HarnessId | ""; // empty = use workspace default harness
  model: string; // empty = use the commit harness default
  prompt: string; // system prompt; diff appended after
}
```

### `FLIGHTPATH_SETTINGS_DEFAULTS`

```typescript
commit: {
  harness: "",
  model: "",
  prompt:
    "Generate a concise, conventional commit message based on the following git diff. " +
    "Return ONLY the commit message — no explanation, no code fences. " +
    "Follow the Conventional Commits format (type(scope): description).",
},
```

### `schemas/settings-schema.json` — add `commit` object

```json
"commit": {
  "type": "object",
  "description": "Commit message generation settings.",
  "additionalProperties": false,
  "properties": {
    "harness": {
      "type": "string",
      "enum": ["", "copilot-cli", "copilot-chat", "claude-cli", "codex-cli", "opencode-cli", "qwen-cli", "gemini-cli"],
      "description": "Harness to use for commit message generation. Empty = use the workspace default harness."
    },
    "model": {
      "type": "string",
      "description": "Model override for commit message generation. Empty = use the commit harness default."
    },
    "prompt": {
      "type": "string",
      "description": "System prompt sent before the git diff. The diff is appended automatically."
    }
  }
}
```

### `src/utils/ConfigurationUtils.ts` — add getters (shared, uses `configService`)

```typescript
getCommitHarness(): HarnessId | "" { return configService.get("commit").harness; }
getCommitModel(): string { return configService.get("commit").model; }
getCommitPrompt(): string { return configService.get("commit").prompt; }
```

### Settings UI follow-through

For the first implementation pass, keep this **out of scope** unless explicitly requested. The shared settings model should still be added now so the feature is implementable and configurable through the underlying settings file/service path, but a dashboard settings editor is optional follow-up work rather than a blocker.

---

## 2. Shared Core: `src/git/CommitMessageGenerator.ts`

New directory `src/git/`. **No `vscode` imports here** — this file is used by VS Code, CLI, and server paths.

```typescript
export interface DiffResult {
  diff: string;
  staged: boolean; // true = from `git diff --cached`; false = from `git diff` (fallback)
}

export interface CommitResult {
  message: string;
  staged: boolean; // propagated from DiffResult
}

export class CommitMessageGenerator {
  /**
   * Gets the diff to use for message generation.
   * Primary: `git diff --cached` (staged changes).
   * Fallback: `git diff` (working tree) if nothing is staged.
   * Returns null if both are empty (nothing to commit).
   */
  async getDiff(cwd: string): Promise<DiffResult | null>;

  /**
   * Runs the configured commit harness headlessly with the diff as context.
   * Harness resolved from commit.harness → workspace default harness.
   * Model resolved from commit.model → harness default.
   */
  async generateMessage(
    diff: string,
    cwd: string,
    token?: AbortSignal
  ): Promise<string>;

  /**
   * Convenience: getDiff + generateMessage.
   * Returns null if there is nothing to commit (clean working tree + index).
   */
  async generate(
    cwd: string,
    token?: AbortSignal
  ): Promise<CommitResult | null>;
}
```

### Internal implementation notes

#### `getDiff` — staged path

`git diff --cached` already handles new staged files correctly (they appear as `new file mode` entries). No special handling needed.

#### `getDiff` — unstaged fallback path

`git diff` only shows changes to **tracked** files. New untracked files are invisible to it. The fallback must combine two sources:

1. `git diff` — tracked file modifications
2. `git ls-files --others --exclude-standard` — list untracked files; for each, generate a synthetic diff entry:

```
diff --git a/<path> b/<path>
new file mode 100644
--- /dev/null
+++ b/<path>
@@ -0,0 +1,N @@
+<line1>
+<line2>
...
```

The 8 KB cap applies to the **combined** output of both sources.

If the combined fallback diff is also empty (tracked diff empty, no untracked files), `getDiff` returns `null` — working tree is clean, nothing to commit.

#### `generateMessage`

Resolves harness from `getCommitHarness()` with fallback to `getIntegrationMode()`. Builds `commitPrompt + "\n\n" + diff` and runs the selected harness in headless single-prompt mode — same path as `flightpath run --headless -p "..."`. Model override applied if `getCommitModel()` is non-empty.

#### Isolation

No VS Code API surface. Depends only on `configService`, `child_process`, and the existing harness execution layer.

---

## 3. Shared Git Commit Utility: `src/git/GitCommitter.ts`

Used by the CLI path. The hosted server keeps its existing two-step flow: generate into the textarea first, then let the existing commit button perform the actual commit.

```typescript
export interface CommitOptions {
  /** When true, runs `git add .` before committing (used when diff was from unstaged working tree). */
  addAll?: boolean;
}

export class GitCommitter {
  /**
   * Commits with the given message.
   * If addAll is true, runs `git add .` first (fallback path when nothing was staged).
   */
  async commit(
    message: string,
    cwd: string,
    options?: CommitOptions
  ): Promise<void>;
}
```

The caller passes `addAll: !result.staged` so `GitCommitter` never needs to inspect git state itself.

---

## 4. VS Code Path (`src/scm/`)

**Scope:** Generate only — write to `vscode.scm.inputBox.value`. No auto-commit.

### `src/scm/ScmCommitCommand.ts`

```typescript
export class ScmCommitCommand {
  constructor(private generator: CommitMessageGenerator) {}

  async execute(): Promise<void> {
    // 1. Find workspace root (vscode.workspace.workspaceFolders)
    // 2. generator.generate(cwd)
    // 3. vscode.scm.inputBox.value = result.message
    // 4. If !result.staged, show info: "No staged changes found — message generated from working tree diff.
    //    Stage your changes before committing."
    // Show vscode.window.withProgress during generation
    // CancellationTokenSource for AbortSignal bridging
  }
}
```

VS Code **never** runs `git add .` automatically — the user controls staging through the SCM panel. The info message ensures they know the context used for generation.

### `package.json` additions (VS Code only)

**Icon** — use `images/flightpath-icon-simple.svg` as the command icon asset for the SCM command. The current package already contributes commands directly in `package.json`; this should be added there using the normal command icon path shape instead of a new product icon ID.

**Command:**

```json
{
  "command": "flightpath.generateCommitMessage",
  "title": "Generate Commit Message",
  "category": "FlightPath",
  "icon": {
    "light": "images/flightpath-icon-simple.svg",
    "dark": "images/flightpath-icon-simple.svg"
  }
}
```

**Menu (`scm/title`):**

```json
{
  "command": "flightpath.generateCommitMessage",
  "group": "navigation",
  "when": "scmProvider == git"
}
```

### `src/extension.ts`

```typescript
const commitCmd = new ScmCommitCommand(new CommitMessageGenerator());
context.subscriptions.push(
  vscode.commands.registerCommand("flightpath.generateCommitMessage", () =>
    commitCmd.execute()
  )
);
```

---

## 5. CLI Path (`src/cli.ts`)

New `flightpath commit` subcommand — generate + commit.

```typescript
program
  .command("commit")
  .description("Generate a commit message from staged changes and commit")
  .option("-m, --model <model>", "Model override for generation")
  .option("--dry-run", "Print generated message without committing")
  .option("-d, --cwd <path>", "Working directory (default: process.cwd())")
  .action(async (options: CommitOptions) => {
    await commitCommand(options);
  });
```

```typescript
async function commitCommand(options: CommitOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const generator = new CommitMessageGenerator();
  const result = await generator.generate(cwd);
  if (!result) {
    console.error("Nothing to commit — working tree is clean.");
    process.exit(1);
  }
  if (!result.staged) {
    console.log(
      "No staged changes found; using working tree diff (will run git add .)."
    );
  }
  if (options.dryRun) {
    console.log(result.message);
    return;
  }
  // addAll: true → GitCommitter runs `git add . && git commit -m`
  await new GitCommitter().commit(result.message, cwd, {
    addAll: !result.staged,
  });
  console.log(`Committed: ${result.message}`);
}
```

---

## 6. Hosted Server + Workspace Viewer Path

The hosted flow should follow the **existing workspace viewer REST architecture**, not add a new WebSocket message family.

### `src/types/HostedWorkspaceViewerTypes.ts`

Add a generation response type for the hosted viewer:

```typescript
export interface WorkspaceGenerateCommitMessageResponse {
  message: string;
  staged: boolean;
}
```

### `src/server/HostedWorkspaceViewerService.ts`

Add a generation-only method that delegates to the shared generator:

```typescript
async generateCommitMessage(): Promise<WorkspaceGenerateCommitMessageResponse> {
  const result = await this.commitMessageGenerator.generate(this.workspaceRoot);
  if (!result) {
    throw new Error("Nothing to commit — working tree is clean");
  }
  return result;
}
```

`HostedWorkspaceViewerService.commit()` stays as-is for the existing manual commit button.

### `src/server/FlightPathHostedServer.ts`

Add a new REST endpoint alongside the other workspace viewer endpoints:

```typescript
this.app.post(
  "/api/workspace-viewer/generate-commit-message",
  requireToken,
  async (_req, res) => {
    try {
      res.json(await this.viewerService.generateCommitMessage());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Nothing to commit — working tree is clean") {
        res.status(400).json({ error: message });
        return;
      }
      Log.error(`workspace-viewer /generate-commit-message error: ${message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
```

### React webview (`src/ui/webview-react/`)

Use the **existing** workspace viewer SCM UI:

1. Add `workspaceGenerateCommitMessage()` to `src/ui/webview-react/utils/hostedApi.ts`.
2. Add `generatingCommitMessage` (and, if needed, a non-error SCM notice field) to `workspaceViewerStore.ts`.
3. Update `WorkspaceCommitArea.tsx` so the textarea row becomes a two-column layout:
   - commit message textarea: flexes to consume remaining width
   - generate button: fixed width (`32px` target), same visual height as the textarea
4. Keep the existing full-width **Commit** button below that row.
5. Use the mini FlightPath SVG (`images/flightpath-icon-simple.svg`) for the new hosted generate button.

Because `WorkspaceCommitArea` is reused in both desktop and mobile layouts via `WorkspaceSourceControlPane.tsx`, this change automatically affects both surfaces and should be tested in both layouts.

---

## 7. Error Handling (all paths)

| Scenario                              | Behavior                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Nothing staged AND clean working tree | Error: "Nothing to commit — working tree is clean."                                                                        |
| Nothing staged, but unstaged changes  | Proceed with working tree diff; CLI still runs `git add .` before commit; VS Code and hosted viewer should surface context |
| Harness not configured/found          | Error: "No harness configured." (link to settings)                                                                         |
| Diff exceeds 8 KB                     | Warn user; truncate and continue                                                                                           |
| Generation fails                      | Error notification; SCM input / hosted textarea / terminal left unchanged                                                  |
| `git commit` fails (CLI/server)       | Surface the git error message                                                                                              |
| User cancels (VS Code)                | Silent cancel; input box left unchanged                                                                                    |

---

## 8. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│ VS Code SCM Panel                                                │
│ [FlightPath icon button] → ScmCommitCommand                      │
│ → CommitMessageGenerator.generate()                              │
│ → vscode.scm.inputBox.value = message    (no auto-commit)        │
└───────────────────────────────┬──────────────────────────────────┘
                                │
        ┌───────────────────────┼──────────────────────────────┐
        ▼                       ▼                              ▼
┌──────────────┐   ┌──────────────────────────┐   ┌─────────────────────────────┐
│ CLI binary   │   │ src/git/ (shared)        │   │ Hosted workspace viewer     │
│              │   │                          │   │                             │
│ flightpath   │──▶│ CommitMessageGenerator   │◀──│ POST /api/workspace-viewer/ │
│ commit       │   │ getDiff()                │   │ generate-commit-message     │
│              │   │ generateMessage()        │   │                             │
│ GitCommitter │   │ (no vscode import)       │   │ WorkspaceCommitArea         │
│ .commit()    │   │                          │   │ → populate textarea         │
└──────────────┘   └──────────────────────────┘   └─────────────────────────────┘
                                │
                     configService.get("commit")
                     ← FlightPathSettings.commit
                     ← schemas/settings-schema.json
```

---

## 9. Isolation Boundary

| File/Layer                                                            | Touched | Notes                                                                  |
| --------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `src/types/FlightPathSettings.ts`                                     | Yes     | Add `commit` section (shared settings)                                 |
| `schemas/settings-schema.json`                                        | Yes     | Add `commit` object                                                    |
| `src/utils/ConfigurationUtils.ts`                                     | Yes     | Add `getCommitHarness()` / `getCommitModel()` / `getCommitPrompt()`    |
| `src/git/CommitMessageGenerator.ts`                                   | New     | No vscode imports                                                      |
| `src/git/GitCommitter.ts`                                             | New     | CLI helper                                                             |
| `src/scm/ScmCommitCommand.ts`                                         | New     | VS Code only (vscode imports allowed)                                  |
| `src/extension.ts`                                                    | Yes     | Register command                                                       |
| `package.json`                                                        | Yes     | Command, menu, command icon                                            |
| `src/cli.ts`                                                          | Yes     | Add `flightpath commit` subcommand                                     |
| `src/types/HostedWorkspaceViewerTypes.ts`                             | Yes     | Add hosted generate response type                                      |
| `src/server/HostedWorkspaceViewerService.ts`                          | Yes     | Add generation method; keep existing commit/push/pull methods          |
| `src/server/FlightPathHostedServer.ts`                                | Yes     | Add `/api/workspace-viewer/generate-commit-message` endpoint           |
| `src/ui/webview-react/utils/hostedApi.ts`                             | Yes     | Add REST helper                                                        |
| `src/ui/webview-react/store/workspaceViewerStore.ts`                  | Yes     | Add generation state / optional info state                             |
| `src/ui/webview-react/components/workspace-viewer/WorkspaceCommitArea.tsx` | Yes     | Add generate button, icon, loading state, 90/10 layout                 |
| `src/ui/webview-react/test/components/workspace-viewer/WorkspaceCommitArea.test.tsx` | Yes     | Update layout assertions and add generation interaction coverage        |
| `src/test/unit/HostedWorkspaceViewerService.test.ts`                  | Yes     | Add generator-backed server tests                                      |

---

## 10. Implementation Order

| #   | Task                                                                                                 | Complexity |
| --- | ---------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Add `commit` section to `FlightPathSettings.ts` + defaults                                           | Low        |
| 2   | Add `commit` to `schemas/settings-schema.json`                                                       | Low        |
| 3   | Add `getCommitHarness()` / `getCommitModel()` / `getCommitPrompt()` to `ConfigurationUtils.ts`      | Low        |
| 4   | Implement `src/git/CommitMessageGenerator.ts`                                                        | Medium     |
| 5   | Implement `src/git/GitCommitter.ts`                                                                  | Low        |
| 6   | Implement `src/scm/ScmCommitCommand.ts` + register in `extension.ts`                                 | Medium     |
| 7   | Add the SCM command + `images/flightpath-icon-simple.svg` icon wiring in `package.json`             | Low        |
| 8   | Add `flightpath commit` subcommand to `src/cli.ts`                                                   | Low        |
| 9   | Extend hosted workspace viewer types/service/server route for generation-only REST support           | Medium     |
| 10  | Update `hostedApi.ts`, `workspaceViewerStore.ts`, and `WorkspaceCommitArea.tsx` for the 90/10 UI    | Medium     |
| 11  | Use the mini FlightPath icon in both the VS Code SCM command and hosted generate button              | Low        |
| 12  | Add/refresh tests for `WorkspaceCommitArea` and `HostedWorkspaceViewerService`                       | Medium     |
| 13  | Manual testing: VS Code SCM, CLI, hosted desktop/mobile, empty staging area, large diff, cancel     | Medium     |

---

## 11. Future Work

- **`vscode.lm` path** — VS Code's built-in Copilot button already covers this. Could add `commitSource: "vscode-lm" | "harness"` and share an `LmRequestHandler` with any future Improve Prompt feature.
- **Pre-commit hook awareness** — run user's pre-commit hook (if any) before committing in the CLI path.
- **Push after commit** — optional `--push` flag for CLI, optional "Generate & Commit" / "Commit & Push" follow-up actions for the hosted viewer.
- **Non-git VCS** — graceful fallback for Mercurial, SVN, etc.
- **Streaming** — stream the response into the SCM input box / hosted textarea character-by-character instead of waiting for the full result.
