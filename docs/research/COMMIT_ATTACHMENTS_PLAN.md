# Git Change Context Attachments Plan

> **Status: Implemented** — See implementation in `src/utils/GitUtils.ts`, `src/utils/FileReferenceParser.ts`, `src/utils/ContextExpander.ts`, `src/completions/CompletionHelpers.ts`, `src/completions/PromptCompletionProvider.ts`, `src/completions/PromptLinkProvider.ts`, `src/types/DashboardConstants.ts`, `src/extension.ts`, `src/ui/WebviewMessageRouter.ts`, `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`.

## Overview

Add `~` as a dedicated trigger for **git change context** in prompt files. Unlike `@` (files/dirs) and `#` (selections/symbols), `~` gives a pure list of change-oriented completions sorted by recency — commits, working tree diff, staged changes, and stashes — with no file paths or symbols interleaved.

The mental model: `~` means "something that changed", which maps naturally to `~` being a git symbol (ancestor/relative ref). The dropdown is a focused "show me what changed" picker.

**Completion categories (sorted by recency/priority):**

| Token | Description |
|---|---|
| `~diff` | Working tree diff (all uncommitted changes) |
| `~staged` | Staged changes only (git index) |
| `~stash:0`, `~stash:1`, … | Named stash entries, most recent first |
| `~<fullHash>` | A specific commit's diff |

**Example use:**
> "I'm seeing a bug since this commit ~c056e2485328963e45b184a3d25bb93fcba32e7d, take a look."
> "Here's what I have staged so far ~staged — does this look right?"
> "I changed these files ~diff, can you help me write the commit message?"

---

## Files to Create

### `src/utils/GitUtils.ts` (new)

Single-responsibility utility for all git operations needed by change context attachments. Uses `child_process.execFile` (not `exec`) to prevent shell injection. Always scoped to a provided `workspaceRoot`.

**Exports:**

```typescript
interface CommitInfo {
  hash: string;         // full 40-char SHA
  shortHash: string;    // 7-char abbreviated SHA
  subject: string;      // first line of commit message
  author: string;       // author name
  relativeDate: string; // e.g. "2 days ago"
}

interface StashInfo {
  index: number;        // stash@{0}, stash@{1}, …
  subject: string;      // stash description
  relativeDate: string;
}

/** Returns recent commits, most recent first */
async function getRecentCommits(
  workspaceRoot: string,
  limit?: number        // default: 30
): Promise<CommitInfo[]>

/** Returns git show output for a commit (stat + full diff) */
async function getCommitDiff(
  workspaceRoot: string,
  hash: string
): Promise<string>

/** Returns working tree diff (unstaged + untracked summary) */
async function getWorkingTreeDiff(workspaceRoot: string): Promise<string>

/** Returns staged diff only */
async function getStagedDiff(workspaceRoot: string): Promise<string>

/** Returns list of stash entries */
async function getStashList(workspaceRoot: string): Promise<StashInfo[]>

/** Returns the diff for a specific stash entry */
async function getStashDiff(workspaceRoot: string, index: number): Promise<string>

/** Returns true if hash looks like a valid git SHA (7-40 hex chars) */
function isValidCommitHash(hash: string): boolean
```

**Implementation notes:**

- `getRecentCommits`: `git -C <root> log --format="%H|%h|%s|%an|%ar" -n <limit>`
- `getCommitDiff`: `git -C <root> show --stat -p <hash>`
- `getWorkingTreeDiff`: `git -C <root> diff --stat -p` (unstaged) combined with a summary from `git status --short` for untracked files
- `getStagedDiff`: `git -C <root> diff --cached --stat -p`
- `getStashList`: `git -C <root> stash list --format="%n|%s|%ar"` (parses index from position)
- `getStashDiff`: `git -C <root> stash show -p stash@{<index>}`
- All use `execFile('git', [...])` — never `exec(string)`
- All throw on non-zero exit; callers catch and log

---

## Files to Modify

### `src/utils/FileReferenceParser.ts`

Extend to parse `~` change context references from prompt text.

**New types:**

```typescript
type GitChangeKind = "commit" | "diff" | "staged" | "stash";

interface GitChangeReference {
  kind: GitChangeKind;
  raw: string;          // the full matched token, e.g. "~c056e24...", "~diff", "~stash:2"
  hash?: string;        // for kind === "commit"
  stashIndex?: number;  // for kind === "stash"
  startOffset: number;
  endOffset: number;
}
```

**Patterns to parse:**

| Pattern | Kind |
|---|---|
| `~diff` | `"diff"` |
| `~staged` | `"staged"` |
| `~stash:<N>` | `"stash"`, `stashIndex: N` |
| `~[0-9a-f]{7,40}` | `"commit"`, `hash: <matched>` |

Add a new exported function `parseGitChangeReferences(text: string): GitChangeReference[]` rather than extending the existing `FileReference` interface — these are a distinct concept from file/symbol references and shouldn't be mixed into the same type.

---

### `src/utils/ContextExpander.ts`

Extend to expand `~` references into `<attachment>` XML.

**Changes:**

1. After existing context expansion, call `parseGitChangeReferences(promptText)` to collect `GitChangeReference[]`
2. For each reference, call the appropriate `GitUtils` function and wrap output in attachment XML:

**Attachment format:**

```xml
<attachment id="git:diff">
Working tree changes (git diff)

```diff
<git diff output>
```
</attachment>
```

```xml
<attachment id="git:staged">
Staged changes (git diff --cached)

```diff
<git diff --cached output>
```
</attachment>
```

```xml
<attachment id="git:stash:0">
Stash entry 0: WIP on main: refactor session handling

```diff
<git stash show -p output>
```
</attachment>
```

```xml
<attachment id="git:commit:c056e2485328963e45b184a3d25bb93fcba32e7d">
Commit c056e24: feat: Enhance CopilotChatIntegration for native attachments

```diff
<git show output>
```
</attachment>
```

3. Deduplication: use the `id` attribute value as the dedup key (same mechanism as existing `attachmentIds`)
4. On git errors: log a warning and skip — never throw
5. `~diff` on a clean working tree: attach a note "No uncommitted changes" rather than empty content

**Attachment ID format:** `git:<kind>[:<detail>]` — keeps all git refs under a `git:` namespace, separate from existing `file:`, `symbol:`, `directory:`, `selection:` prefixes.

---

### `src/completions/CompletionHelpers.ts`

Add `getGitChangeCompletions()`.

**Changes:**

1. Add imports for `GitUtils` (`CommitInfo`, `StashInfo`)
2. Add 10-second cache for commits and stash list (same TTL pattern as `filesCache`):
   ```typescript
   let gitCache: { commits: CommitInfo[]; stashes: StashInfo[]; timestamp: number } | null = null;
   const GIT_CACHE_DURATION_MS = 10_000;
   ```
3. Add `getGitChangeCompletions(workspaceRoot: string, filterText: string): Promise<PlainCompletionItem[]>`:

   **Always-present items (sorted first, before commits):**
   - `~diff` — label: `diff — Working tree changes`, detail: "All uncommitted changes", sortText: `!000_git_0`
   - `~staged` — label: `staged — Staged changes`, detail: "Changes in the index (git add)", sortText: `!000_git_1`

   **Stash items (sorted after fixed items, before commits):**
   - `~stash:0`, `~stash:1`, … — label: `stash:<N> — <subject>`, detail: `<relativeDate>`, sortText: `!000_git_stash_<N>`

   **Commit items (most recent first):**
   - `~<fullHash>` — label: `<shortHash> — <subject>`, detail: `<author>, <relativeDate>`, sortText: `!001_git_commit_<NNN>`
   - `filterText` per item: `<hash> <shortHash> <subject> <author>` so typing part of a message narrows the list

   **insertText:** full token WITHOUT the `~` prefix (the trigger char provides it).

4. Filter all items by `filterText` against their label + detail + filterText fields

---

### `src/completions/PromptCompletionProvider.ts`

Add `~` trigger and route to `getGitChangeCompletions`.

**Changes:**

1. Add `~` detection in `provideCompletionItems()` alongside existing `@` and `#` detection using `lastIndexOf('~')`
2. Extract filter text: everything after `~` up to the cursor, stopping at whitespace
3. Call `getGitChangeCompletions(workspaceRoot, filterText)`
4. `workspaceRoot` from `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`

**Registration update in `extension.ts`:** Add `'~'` to the existing trigger characters array.

---

### `src/completions/PromptLinkProvider.ts`

Add `~` reference links for Ctrl+Click.

**Patterns:**

```typescript
gitDiff:    /~(diff|staged)/g
gitStash:   /~(stash:\d+)/g
gitCommit:  /~([0-9a-f]{7,40})/gi
```

**Link targets:**

- `~diff` / `~staged`: open a new untitled editor with the live diff output (via `flightpath.openGitChange` command)
- `~stash:<N>`: same command, opens stash diff
- `~<hash>`: same command, opens commit diff

Register `flightpath.openGitChange` in `extension.ts`:
- Accepts `{ workspaceRoot: string, ref: string }` where `ref` is `"diff"`, `"staged"`, `"stash:<N>"`, or a commit hash
- Calls appropriate `GitUtils` function based on `ref`, opens result in new untitled document with `diff` language
- Both `PromptLinkProvider` (VS Code text editor) and `FlightPathWebviewProvider` (CodeMirror) delegate here — single source of truth for open logic

---

### `src/types/DashboardConstants.ts`

Add git change attachment ID prefix and new message type:

```typescript
export const ATTACHMENT_PREFIXES = {
  FILE: "file",
  SYMBOL: "symbol",
  DIRECTORY: "directory",
  SELECTION: "selection",
  GIT: "git",           // ← new: covers git:diff, git:staged, git:stash:N, git:commit:<hash>
} as const;

// In MESSAGE_TYPES (CodeMirror editor section):
OPEN_GIT_CHANGE: "openGitChange",  // ← new: Webview -> Extension: open a git diff in a new editor
```

---

### `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`

Wire `~` into the CodeMirror webview editor (the in-panel prompt input). The webview editor communicates with the extension host via `REQUEST_COMPLETIONS` / `COMPLETIONS_RESPONSE` messages — the same path used for `@` and `#`. No new message protocol is needed for completions; only the regex and boost logic need updating.

**Changes:**

1. **`customCompletions` — extend `matchBefore` regex** to include `~`:
   ```typescript
   // Old:
   /@"[^"]*|@[a-zA-Z0-9_/.-]*|#"[^"]*|#[a-zA-Z0-9_/:.-]*/
   // New:
   /@"[^"]*|@[a-zA-Z0-9_/.-]*|#"[^"]*|#[a-zA-Z0-9_/:.-]*|~[a-zA-Z0-9:_]*/
   ```
   The `trigger` extracted as `before.text[0]` will be `"~"`, which `PromptCompletionProvider` routes to `getGitChangeCompletions`.

2. **`handleCompletionResponse` — fix boost for `!NNN_` sortText**:
   Git items use sortText like `!000_git_0`, `!001_git_commit_000`. The `!` prefix causes the existing `/^(\d+)_/` regex to miss them (they fall into `boost = -index`). Fix:
   ```typescript
   // Old:
   const prefixMatch = item.sortText.match(/^(\d+)_/);
   // New:
   const prefixMatch = item.sortText.match(/^!?(\d+)_/);
   ```
   This preserves the intent: `!000_` items (diff, staged, stashes) get boost ~1000; `!001_` items (commits) get boost ~900.

3. **`getCompletionRanges` — exclude `~` references from spell checking**:
   ```typescript
   // Old patterns array:
   const patterns = [/@"[^"]*"|@[^\s@#]+/g, /#"[^"]*"|#[^\s@#]+/g];
   // New (add ~ git refs):
   const patterns = [
     /@"[^"]*"|@[^\s@#~]+/g,
     /#"[^"]*"|#[^\s@#~]+/g,
     /~(?:diff|staged|stash:\d+|[0-9a-f]{7,40})/gi,
   ];
   ```

4. **`createLinkDecorationExtension` — decorate `~` references as links**:
   Add a `gitMatches` category alongside `fileMatches`, `directoryMatches`, etc.:
   ```typescript
   // After existing symbol pattern matching, before the combine/sort step:
   const gitPatterns = {
     gitFixed:  /~(diff|staged)/g,
     gitStash:  /~(stash:\d+)/g,
     gitCommit: /~([0-9a-f]{7,40})/gi,
   };
   ```
   Push to a `gitMatches` array with:
   ```typescript
   { from, to, type: "git", gitRef: match[1] }
   ```
   Include `gitMatches` in the final `matches` combine step. Apply `data-type="git"` and `data-git-ref="<ref>"` attributes on the decoration.

5. **`createClickHandlerExtension` — handle `data-type === "git"` Ctrl+Click**:
   ```typescript
   } else if (type === "git") {
     const gitRef = target.getAttribute("data-git-ref");
     vscode.postMessage({
       type: MESSAGE_TYPES.OPEN_GIT_CHANGE,
       ref: gitRef, // "diff", "staged", "stash:0", or a commit hash
     });
   }
   ```

6. **Placeholder text**: Update the default to mention `~`:
   ```typescript
   "Use @ for files and folders, # for selections and symbols, ~ for git changes"
   ```

---

### `src/ui/FlightPathWebviewProvider.ts`

Handle the `OPEN_GIT_CHANGE` message from the webview by delegating to the `flightpath.openGitChange` command registered in `extension.ts`. All GitUtils logic lives in one place (the command handler) — the webview handler is a thin dispatcher.

**Changes:**

In the webview message handler (`switch(message.type)`), add a `MESSAGE_TYPES.OPEN_GIT_CHANGE` case:

```typescript
case MESSAGE_TYPES.OPEN_GIT_CHANGE: {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { break; }
  await vscode.commands.executeCommand("flightpath.openGitChange", {
    workspaceRoot,
    ref: message.ref, // "diff", "staged", "stash:0", or commit hash
  });
  break;
}
```

The `flightpath.openGitChange` command (registered in `extension.ts`) owns the GitUtils call and the untitled editor open. Both the VS Code text editor link click (via `command:` URI from `PromptLinkProvider`) and the CodeMirror webview click converge on this single command handler.

---

## Implementation Order

1. **`GitUtils.ts`** — Foundation; no dependencies on other changes
2. **`DashboardConstants.ts`** — Add `ATTACHMENT_PREFIXES.GIT` and `MESSAGE_TYPES.OPEN_GIT_CHANGE`
3. **`FileReferenceParser.ts`** — Add `parseGitChangeReferences()` and `GitChangeReference` type
4. **`ContextExpander.ts`** — Wire in git expansion (depends on 1 + 3)
5. **`CompletionHelpers.ts`** — Add `getGitChangeCompletions()` (depends on 1)
6. **`PromptCompletionProvider.ts`** — Add `~` trigger (depends on 5)
7. **`PromptLinkProvider.ts`** + **`extension.ts`** — Add VS Code text editor links and `flightpath.openGitChange` command (depends on 1)
8. **`CodeMirrorEditor.tsx`** — Add `~` regex, boost fix, spell-check exclusion, link decoration, click handler, placeholder update (depends on 2)
9. **`FlightPathWebviewProvider.ts`** — Handle `OPEN_GIT_CHANGE` message (depends on 1 + 2)

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Not a git repo | All `GitUtils` calls return empty/throw; completions show empty list; ContextExpander skips with warning |
| Invalid/unknown commit hash | `git show` fails; attachment skipped; warning logged |
| `~diff` on a clean working tree | Attach message "No uncommitted changes in working tree" |
| `~staged` with nothing staged | Attach message "No staged changes" |
| No stashes | `~stash:*` items omitted from completions |
| Very large diff (bulk rename/generated file) | No truncation in v1; consider 200 KB cap in follow-up |
| Short hash ambiguity | Git resolves; if ambiguous, `git show` exits non-zero → skip with warning |
| Multiple workspace folders | Use `workspaceFolders[0]` consistently with rest of codebase |
| No commits (fresh repo) | `getRecentCommits` returns []; commit items omitted from completions |

---

## Example: Completion Dropdown

When the user types `~` in a prompt file, the dropdown shows:

```
$(git-commit) diff — Working tree changes          All uncommitted changes
$(git-commit) staged — Staged changes              Changes in the index (git add)
$(git-commit) stash:0 — WIP on main: refactor      2 days ago
$(git-commit) 7c02b10 — feat: Enhance prompt...    Nathan, 1 hour ago
$(git-commit) c2e4702 — feat: Add getResume...     Nathan, 3 hours ago
$(git-commit) ed58b04 — feat: Update skill...      Nathan, 5 hours ago
…
```

Typing `~ref` narrows to items whose commit message or author contains "ref".

---

## Example: Expanded Output

**Prompt:**
```
Here's what I have staged so far ~staged — does this look right before I commit?
```

**After `ContextExpander.expandContext()`:**
```xml
<attachment id="git:staged">
Staged changes (git diff --cached)

```diff
diff --git a/src/utils/GitUtils.ts b/src/utils/GitUtils.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/utils/GitUtils.ts
@@ -0,0 +1,60 @@
+import { execFile } from "child_process";
…
```
</attachment>

Here's what I have staged so far ~staged — does this look right before I commit?
```
