# SCM / Commit Message Generation — Implementation Plan

**Date:** 2026-04-03 (revised 2026-04-20)
**Purpose:** Generate conventional commit messages using the workspace's configured FlightPath harness. Three integration points share a single core implementation:

| Surface           | What it does                                                                 |
| ----------------- | ---------------------------------------------------------------------------- |
| **VS Code SCM**   | Button in the SCM title bar — generates message, populates the input box     |
| **CLI**           | `flightpath commit` subcommand — generates message then runs `git commit -m` |
| **Hosted server** | "Commit" button in the React dashboard — generates message then commits      |

---

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

Used by CLI and server paths only (VS Code populates the input box instead).

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

**Icon** — register `images/flightpath-icon-simple.svg` as a custom icon ID (same pattern as existing harness icons in `src/ui/icons/`). Reference it in the command as `"icon": "$(flightpath-commit)"` or similar.

**Command:**

```json
{
  "command": "flightpath.generateCommitMessage",
  "title": "Generate Commit Message",
  "category": "FlightPath",
  "icon": "$(flightpath-logo)"
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

## 6. Server Path

### WebSocket message (new types in `src/types/DashboardConstants.ts`)

```typescript
// From browser client → server
GENERATE_COMMIT_MESSAGE: "generateCommitMessage";

// From server → browser client
COMMIT_MESSAGE_GENERATED: "commitMessageGenerated";
COMMIT_COMPLETE: "commitComplete";
COMMIT_ERROR: "commitError";
```

### `src/server/FlightPathHostedServer.ts`

Handle the new message type in `setupWebSocket()` alongside the existing `READY` handler:

```typescript
if (msg?.type === MESSAGE_TYPES.GENERATE_COMMIT_MESSAGE) {
  const cwd = this.workspaceRoot;
  const generator = new CommitMessageGenerator();
  const committer = new GitCommitter();
  try {
    const result = await generator.generate(cwd);
    if (!result) {
      send({
        type: MESSAGE_TYPES.COMMIT_ERROR,
        error: "Nothing to commit — working tree is clean.",
      });
      return;
    }
    // addAll: true → GitCommitter runs `git add . && git commit -m`
    await committer.commit(result.message, cwd, { addAll: !result.staged });
    send({
      type: MESSAGE_TYPES.COMMIT_COMPLETE,
      message: result.message,
      staged: result.staged,
    });
  } catch (err) {
    send({ type: MESSAGE_TYPES.COMMIT_ERROR, error: String(err) });
  }
}
```

### React webview (`src/ui/webview-react/`)

Add a "Commit" button panel to the dashboard (exact placement TBD — likely near the workflow controls or in a new Git section). On click, sends `GENERATE_COMMIT_MESSAGE`. Shows spinner during generation. On `COMMIT_COMPLETE`, shows a success notification with the message. On `COMMIT_ERROR`, shows an error toast.

---

## 7. Error Handling (all paths)

| Scenario                              | Behavior                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Nothing staged AND clean working tree | Error: "Nothing to commit — working tree is clean."                                               |
| Nothing staged, but unstaged changes  | Proceed with working tree diff; CLI/server run `git add .` before commit; VS Code shows info note |
| Harness not configured/found          | Error: "No harness configured." (link to settings)                                                |
| Diff exceeds 8 KB                     | Warn user; truncate and continue                                                                  |
| Generation fails                      | Error notification; input box / terminal left unchanged                                           |
| `git commit` fails (CLI/server)       | Surface the git error message                                                                     |
| User cancels (VS Code)                | Silent cancel; input box left unchanged                                                           |

---

## 8. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  VS Code SCM Panel                                              │
│  [FlightPath icon button] → ScmCommitCommand                   │
│  → CommitMessageGenerator.generate()                           │
│  → vscode.scm.inputBox.value = message    (no auto-commit)     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
         ┌─────────────────────┼──────────────────────┐
         ▼                     ▼                       ▼
┌─────────────┐   ┌──────────────────────┐  ┌──────────────────┐
│  CLI binary │   │  src/git/ (shared)   │  │  Hosted server   │
│             │   │                      │  │                  │
│  flightpath │   │  CommitMessageGenerator  │  WebSocket msg   │
│  commit     │──▶│  getStagedDiff()     │◀─│  GENERATE_COMMIT │
│             │   │  generateMessage()   │  │  _MESSAGE        │
│  GitCommit  │   │                      │  │  GitCommitter    │
│  ter.commit │   │  (no vscode import)  │  │  .commit()       │
└─────────────┘   └──────────────────────┘  └──────────────────┘
                               │
                    configService.get("commit")
                    ← FlightPathSettings.commit
                    ← schemas/settings-schema.json
```

---

## 9. Isolation Boundary

| File/Layer                             | Touched | Notes                                        |
| -------------------------------------- | ------- | -------------------------------------------- |
| `src/types/FlightPathSettings.ts`      | Yes     | Add `commit` section (shared settings)       |
| `schemas/settings-schema.json`         | Yes     | Add `commit` object                          |
| `src/utils/ConfigurationUtils.ts`      | Yes     | Add `getCommitModel()` / `getCommitPrompt()` |
| `src/types/DashboardConstants.ts`      | Yes     | Add 3 new message types                      |
| `src/git/CommitMessageGenerator.ts`    | New     | No vscode imports                            |
| `src/git/GitCommitter.ts`              | New     | No vscode imports                            |
| `src/scm/ScmCommitCommand.ts`          | New     | VS Code only (vscode imports allowed)        |
| `src/extension.ts`                     | Yes     | Register command                             |
| `package.json`                         | Yes     | Command, menu, icon, (no settings — shared)  |
| `src/cli.ts`                           | Yes     | Add `commit` subcommand                      |
| `src/server/FlightPathHostedServer.ts` | Yes     | Handle `GENERATE_COMMIT_MESSAGE` WS message  |
| `src/ui/webview-react/`                | Yes     | Commit button + status display in dashboard  |

---

## 10. Implementation Order

| #   | Task                                                                       | Complexity |
| --- | -------------------------------------------------------------------------- | ---------- |
| 1   | Add `commit` section to `FlightPathSettings.ts` + defaults                 | Low        |
| 2   | Add `commit` to `schemas/settings-schema.json`                             | Low        |
| 3   | Add `getCommitModel()` / `getCommitPrompt()` to `ConfigurationUtils.ts`    | Low        |
| 4   | Add 3 message type constants to `DashboardConstants.ts`                    | Low        |
| 5   | Implement `src/git/CommitMessageGenerator.ts`                              | Medium     |
| 6   | Implement `src/git/GitCommitter.ts`                                        | Low        |
| 7   | Implement `src/scm/ScmCommitCommand.ts` + register in `extension.ts`       | Medium     |
| 8   | Register FlightPath SVG icon + add command/menu to `package.json`          | Low        |
| 9   | Add `flightpath commit` subcommand to `src/cli.ts`                         | Low        |
| 10  | Add WebSocket handler in `FlightPathHostedServer.ts`                       | Low        |
| 11  | Add Commit button + state to React webview                                 | Medium     |
| 12  | Manual testing: all three surfaces, empty staging area, large diff, cancel | Medium     |

---

## 11. Future Work

- **`vscode.lm` path** — VS Code's built-in Copilot button already covers this. Could add `commitSource: "vscode-lm" | "harness"` and share an `LmRequestHandler` with any future Improve Prompt feature.
- **Pre-commit hook awareness** — run user's pre-commit hook (if any) before committing in the CLI/server paths.
- **Push after commit** — optional `--push` flag for CLI, optional "Commit & Push" button for server.
- **Non-git VCS** — graceful fallback for Mercurial, SVN, etc.
- **Streaming** — stream the response into the input box character-by-character instead of waiting for the full result.
