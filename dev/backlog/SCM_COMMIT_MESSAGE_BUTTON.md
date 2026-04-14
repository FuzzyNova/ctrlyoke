# SCM Commit Message Button — Implementation Plan

**Date:** 2026-04-03
**Purpose:** Add a "Generate Commit Message" button to VS Code's native Source Control panel, following the pattern established by extensions like Cline and other AI commit message tools.

---

## 1. VS Code SCM API Overview

VS Code extensions can add buttons to the Source Control panel through **`package.json` contribution points**:

### Contribution Points

| Point                       | Purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `scm/title`                 | Commands in the SCM title bar. Use `"group": "navigation"` to show inline (not in `…` dropdown) |
| `scm/resourceState/context` | Commands on individual file states (context menu or inline)                                     |
| `scm/change/title`          | Commands in the Quick Diff inline diff editor title bar                                         |

### Accessing the SCM Input Box

```typescript
// Get the SCM input box (commit message text area)
const scmInput = vscode.scm.inputBox;

// Read current value
const currentMessage = scmInput.value;

// Write generated value
scmInput.value = generatedMessage;
```

### Key Constraint

Just like `vscode.lm`, SCM API access is **also** extension-host-only. The webview cannot touch SCM directly. All logic runs in the extension host.

---

## 2. Feature Design

### User Flow

```
User stages changes in VS Code SCM panel
    → Clicks "✨ Generate Commit Message" button (inline in title bar)
        → Extension reads staged diff via `git diff --cached`
            → Sends diff + system prompt to configured harness/model
                → Streams generated commit message back
                    → Sets `vscode.scm.inputBox.value = generatedMessage`
                        → User reviews, edits if needed, commits
```

### Button Placement

- **Location:** SCM title bar, inline (navigation group)
- **Icon:** `$(sparkle)` or `$(wand)` — AI-generated indicator
- **Tooltip:** "Generate commit message with FlightPath"
- **Visibility:** When `scmProvider == git` (or always, with graceful degradation for other providers)

### Similar Pattern to "Improve Prompt" (VSCODE_LM_API_FEATURES.md)

Both features follow the same architecture:

1. User clicks a button in the VS Code UI
2. Extension reads current context (prompt text / staged diff)
3. Extension sends to AI (vscode.lm or configured harness)
4. AI response streams back and replaces the target text
5. User reviews and finalizes

---

## 3. Settings (package.json + ConfigurationUtils.ts)

```jsonc
"flightpath.commitEnabled": {
  "type": "boolean",
  "default": true,
  "description": "Show a 'Generate Commit Message' button in the Source Control panel."
},
"flightpath.commitSource": {
  "type": "string",
  "enum": ["vscode-lm", "harness"],
  "default": "vscode-lm",
  "description": "Whether to use VS Code's built-in language models or a configured harness for commit message generation."
},
"flightpath.commitHarness": {
  "type": "string",
  "description": "Harness to use for commit message generation when source is 'harness' (e.g., 'claude-cli', 'copilot-cli')."
},
"flightpath.commitModel": {
  "type": "string",
  "description": "Model override for commit message generation."
},
"flightpath.commitPrompt": {
  "type": "string",
  "default": "Generate a concise, conventional commit message based on the following git diff. Return ONLY the commit message, nothing else. Follow conventional commits format if possible.",
  "markdownDescription": "System prompt used when generating commit messages. Supports `{diff}` placeholder where the staged diff will be inserted. Users can customize the message format directly in the prompt."
}
```

### Settings Access (ConfigurationUtils.ts)

```typescript
// Add getters alongside existing model/harness getters
static getCommitEnabled(): boolean { ... }
static getCommitSource(): 'vscode-lm' | 'harness' { ... }
static getCommitHarness(): string { ... }
static getCommitModel(): string { ... }
static getCommitPrompt(): string { ... }
```

---

## 4. Implementation Tasks

### 4.1 package.json Contributions

**Command:**

```json
{
  "command": "flightpath.generateCommitMessage",
  "title": "Generate Commit Message",
  "category": "FlightPath",
  "icon": "$(sparkle)"
}
```

**Menu:**

```json
{
  "command": "flightpath.generateCommitMessage",
  "group": "navigation",
  "when": "config.flightpath.commitEnabled && scmProvider == git"
}
```

### 4.2 New Source File: `src/scm/CommitMessageGenerator.ts`

Core logic for generating commit messages:

```typescript
export class CommitMessageGenerator {
  // Read staged diff from git
  async getStagedDiff(): Promise<string | null>;

  // Route to vscode.lm or harness based on settings
  async generateCommitMessage(
    diff: string,
    cancellationToken: CancellationToken
  ): Promise<string>;

  // vscode.lm path (Option A)
  async generateWithLm(
    diff: string,
    cancellationToken: CancellationToken
  ): Promise<string>;

  // Harness path (Option B)
  async generateWithHarness(
    diff: string,
    cancellationToken: CancellationToken
  ): Promise<string>;

  // Write result to SCM input box
  async applyToScmInputBox(message: string): Promise<void>;
}
```

### 4.3 Command Registration (extension.ts)

```typescript
// In activate()
const commitGen = new CommitMessageGenerator();
context.subscriptions.push(
  vscode.commands.registerCommand(
    "flightpath.generateCommitMessage",
    async () => {
      await commitGen.generateAndApply();
    }
  )
);
```

### 4.4 CancellationToken Management

The button should show a loading state and support cancellation:

- While generating, button shows `$(sync~spin)` icon
- Clicking while running cancels the current generation
- Use `CancellationTokenSource` stored on the class instance

### 4.5 Error Handling

| Scenario                        | Behavior                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| No staged changes               | Show info notification: "No staged changes to generate a commit message for"         |
| No models available (vscode.lm) | Show error: "No language models available. Configure a harness or activate Copilot." |
| Harness not configured          | Show error + "Configure" button that opens settings                                  |
| Generation fails                | Show error notification, leave SCM input box unchanged                               |
| User cancels                    | Show "Commit message generation cancelled"                                           |

---

## 5. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Source Control Panel                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Changes (3)                    [💡] [✓] [✨]        │    │  ← [✨] = generateCommitMessage
│  │  ┌──────────────────────────────────────────────┐   │    │
│  │  │ feat: add prompt queue deduplication         │   │    │  ← scm.inputBox.value
│  │  └──────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────┬───────────────────────────────────┘
                          │ click
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Extension Host                            │
│                                                              │
│  CommitMessageGenerator                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 1. git diff --cached → stagedDiff                   │   │
│  │ 2. selectChatModels() OR getHarness()               │   │
│  │ 3. sendRequest([systemPrompt, diff], token)         │   │
│  │ 4. Stream response chunks                           │   │
│  │ 5. vscode.scm.inputBox.value = result               │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Implementation Order

| Priority | Task                                                 | Complexity  | Notes                                                         |
| -------- | ---------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| 1        | Add settings to package.json + ConfigurationUtils    | Low         | New `commit.*` settings                                       |
| 2        | Register command + menu contribution in package.json | Low         | `scm/title` with `navigation` group                           |
| 3        | Implement `CommitMessageGenerator` class             | Medium      | git diff parsing, error handling                              |
| 4        | Implement vscode.lm path (Option A)                  | Medium      | Same pattern as ImprovePrompt                                 |
| 5        | Implement harness path (Option B)                    | Medium-High | Run headless harness, parse output                            |
| 6        | Wire up command in extension.ts                      | Low         | Single registration + cancellation                            |
| 7        | Add icon to UI icons directory                       | Low         | SVG for sparkle/wand icon                                     |
| 8        | Manual testing                                       | Medium      | Test with various diff sizes, no staged changes, cancellation |

---

## 7. Files to Modify

| File                                | Change                                                      |
| ----------------------------------- | ----------------------------------------------------------- |
| `package.json`                      | Add command, menu, settings                                 |
| `src/utils/ConfigurationUtils.ts`   | Add commit-related getters                                  |
| `src/extension.ts`                  | Register `flightpath.generateCommitMessage` command         |
| `src/types/DashboardConstants.ts`   | Add any new message types if streaming to webview is needed |
| `src/scm/CommitMessageGenerator.ts` | **NEW** — Core generation logic                             |
| `src/ui/icons/`                     | Add sparkle/wand SVG if not present                         |

---

## 8. Relationship to VSCODE_LM_API_FEATURES.md

This feature **reuses the same vscode.lm pipeline** established by the "Improve Prompt" feature:

- Same `selectChatModels()` pattern
- Same streaming response handling
- Same CancellationToken management
- Same Option A (vscode.lm) / Option B (harness) duality

The `CommitMessageGenerator` can **share infrastructure** with the `LmFeatureHandler` planned for Improve Prompt — both need:

1. Model selection with fallback
2. Prompt building (system + user context)
3. Response streaming
4. Error/cancellation handling

Consider extracting a shared `LmRequestHandler` class that both features use.

---

## 9. Risks & Mitigations

| Risk                                      | Mitigation                                                     |
| ----------------------------------------- | -------------------------------------------------------------- |
| `vscode.lm` not available (no Copilot)    | Fallback to harness mode; clear error message                  |
| Large diffs exceed token limits           | Truncate diff to first N hunks; warn user                      |
| Git not in PATH                           | Use same git discovery as existing FlightPath git integration  |
| Multiple SCM providers                    | `when` clause limits to `git`; future: support other providers |
| User has unsaved changes in SCM input box | Warn before overwriting, or append instead of replace          |
