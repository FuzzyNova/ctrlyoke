# Harness File Manager Plan

## Overview

FlightPath is uniquely positioned as a single platform for all AI harnesses, but its current
approach to agents, skills, and MCP configs creates a friction point for multi-harness users:
each harness has its own native discovery path, and native _subagent spawning_ only works for
files that live in that harness's own directory. FlightPath already discovers from all these
locations and injects agents/skills universally via prompt prepending — but it cannot make a
Codex subagent spawn know about agents stored in `.claude/agents/`, and vice versa.

This feature adds a **Harness File Manager** UI to the settings panel that lets users:

- **Import** — pull agent/skill/MCP files from any discovered location into FlightPath's own
  `.flightpath/` directory (or into another harness's directory)
- **Export** — copy files to a target harness's native directory so that harness can use them
  natively (subagent discovery, model router, etc.)
- **Delete** — remove files from a specific harness's native directory without touching the source
- **Sync** — keep agent/skill files mirrored across multiple harness directories simultaneously

---

## Problem Statement

### The Multi-Harness Gap

| Location              | Discovered by FlightPath | Native subagent spawn |
| --------------------- | ------------------------ | --------------------- |
| `.claude/agents/`     | ✅                       | Claude only           |
| `.github/agents/`     | ✅                       | Copilot only          |
| `.agents/`            | ✅                       | Codex only            |
| `.gemini/agents/`     | ✅                       | Gemini only           |
| `.opencode/agents/`   | ✅                       | OpenCode only         |
| `.qwen/agents/`       | ✅                       | Qwen only             |
| `.flightpath/agents/` | ✅                       | None (cy-exclusive)   |

When a user switches harnesses (e.g., Claude → Codex), their agent files stay in `.claude/agents/`.
FlightPath still injects them into every prompt via `<agentInstructions>`, but:

1. Codex subagent spawning cannot discover them natively.
2. Duplicating files manually into multiple harness directories is error-prone and diverges.
3. There is no UI to understand _where_ an agent actually lives or _which harnesses_ have it.

### The Ideal State

A user should be able to define agents/skills/MCP servers once and then explicitly choose
which harnesses should have native access to them — without leaving the FlightPath settings UI.

---

## Use Cases

- **Single-source agent library** — Author agents in `.flightpath/agents/` (no harness scrapes
  this), then export to whichever harnesses need them natively.
- **Migrate from Claude-first to multi-harness** — User previously put all agents in `.claude/`;
  now wants Codex to see them too. Import all from `.claude/agents/`, re-export to `.agents/`.
- **Clean up harness directories** — Remove stale `.agent.md` files that a harness was
  double-loading (because they were also in `.flightpath/agents/`).
- **Sync on add** — When a new agent is authored, export it to all pinned harnesses in one click.
- **Workspace portability** — Export agents to `.github/agents/` for a team that uses Copilot.

---

## Scope

Three resource types are managed:

| Type   | Unit                  | Harness native dirs (workspace)                                                                                  | FP dir                          |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Agents | `*.agent.md` file¹    | `.claude/agents/`, `.github/agents/`, `.agents/`, `.gemini/agents/`, `.opencode/agents/`, `.qwen/agents/`        | `.flightpath/agents/`           |
| Skills | `<name>/SKILL.md` dir | `.claude/skills/`, `.github/skills/`, `.agents/skills/`, `.gemini/skills/`, `.opencode/skills/`, `.qwen/skills/` | `.flightpath/skills/`           |
| MCP    | config entry          | `~/.claude.json`, `.vscode/mcp.json`, harness-specific config                                                    | `flightpath.mcpServers` setting |

¹ Gemini uses `*.md` (not `*.agent.md`) in its native agents directory. Export to Gemini must
rename `name.agent.md` → `name.md`; import from Gemini must treat all `*.md` files as agents.

MCP management is more complex (config format varies per harness) and should be a separate
sub-feature once agents and skills are shipping. This plan focuses on **agents and skills** first.

---

## Data Model

### `HarnessDirectory`

```ts
interface HarnessDirectory {
  harnessId: HarnessId;
  label: string; // "Claude (.claude/agents/)"
  agentsPath: string | null; // absolute path, null if harness has no native agents dir
  skillsPath: string | null;
  exists: boolean; // whether the directory exists on disk
}
```

### `ManagedFile`

```ts
interface ManagedFile {
  name: string; // agent/skill name (without extension / dir)
  displayName: string;
  type: "agent" | "skill";
  locations: ManagedFileLocation[];
}

interface ManagedFileLocation {
  harnessId: HarnessId | "flightpath" | "user";
  path: string; // full path on disk
  isSource: boolean; // user designated this as the canonical source
}
```

The UI shows each unique name once, with badges for each harness that has it.

---

## Harness Directory Map

Each harness has separate workspace-level and user-level path lists.
`~` paths are expanded to `os.homedir()` at runtime; `~/.config/opencode/` uses
`XDG_CONFIG_HOME` if set.

```ts
// In HarnessDirectoryUtils.ts

// Workspace-relative agent directories per harness
// Note: "gemini-cli" native files use *.md, not *.agent.md — see AgentFileExtension below
const HARNESS_WORKSPACE_AGENT_DIRS: Record<HarnessId, string[]> = {
  "claude-cli": [".claude/agents"],
  "copilot-cli": [".github/agents"],
  "codex-cli": [".agents"],
  "gemini-cli": [".gemini/agents"],
  "opencode-cli": [".opencode/agents"],
  "qwen-cli": [".qwen/agents"],
  "copilot-chat": [".github/agents"],
};

// User-home agent directories per harness (absolute, ~-expanded)
const HARNESS_USER_AGENT_DIRS: Record<HarnessId, string[]> = {
  "claude-cli": ["~/.claude/agents"],
  "copilot-cli": ["~/.copilot/agents"],
  "codex-cli": ["~/.codex/agents", "~/.agents"], // ~/.agents is the AgentSkills.io standard; ~/.codex is harness-native
  "gemini-cli": ["~/.gemini/agents"],
  "opencode-cli": ["~/.config/opencode/agents"],
  "qwen-cli": ["~/.qwen/agents"],
  "copilot-chat": ["~/.copilot/agents"],
};

// Workspace-relative skill directories per harness
// Gemini supports both its own .gemini/skills/ AND the Codex-style .agents/skills/
const HARNESS_WORKSPACE_SKILL_DIRS: Record<HarnessId, string[]> = {
  "claude-cli": [".claude/skills"],
  "copilot-cli": [".github/skills"],
  "codex-cli": [".agents/skills"],
  "gemini-cli": [".gemini/skills", ".agents/skills"],
  "opencode-cli": [".opencode/skills"],
  "qwen-cli": [".qwen/skills"],
  "copilot-chat": [".github/skills"],
};

// User-home skill directories per harness (absolute, ~-expanded)
const HARNESS_USER_SKILL_DIRS: Record<HarnessId, string[]> = {
  "claude-cli": ["~/.claude/skills"],
  "copilot-cli": ["~/.copilot/skills"],
  "codex-cli": ["~/.codex/skills", "~/.agents/skills"], // ~/.agents/skills is AgentSkills.io standard; ~/.codex/skills is harness-native
  "gemini-cli": ["~/.gemini/skills", "~/.agents/skills"],
  "opencode-cli": ["~/.config/opencode/skills"],
  "qwen-cli": ["~/.qwen/skills"],
  "copilot-chat": ["~/.copilot/skills"],
};

// File extension used when reading/writing agents for each harness.
// Gemini uses plain *.md; all others use *.agent.md.
const HARNESS_AGENT_EXTENSION: Record<HarnessId, string> = {
  "claude-cli": ".agent.md",
  "copilot-cli": ".agent.md",
  "codex-cli": ".agent.md",
  "gemini-cli": ".md",
  "opencode-cli": ".agent.md",
  "qwen-cli": ".agent.md",
  "copilot-chat": ".agent.md",
};
```

`HarnessFileManager.exportToHarness` must use `HARNESS_AGENT_EXTENSION[targetHarnessId]`
when writing the destination filename, so exporting a `.agent.md` to Gemini correctly
produces a `.md` file, and importing a `.md` from Gemini strips the Gemini extension before
assigning an internal name.

These become single sources of truth, replacing the ad-hoc path logic currently spread across
`AgentDiscovery.ts` and `SkillDiscovery.ts`.

---

## New Files

### `src/utils/HarnessFileManager.ts`

Core business logic for file operations. No VS Code UI dependencies (testable).

```ts
export class HarnessFileManager {
  /** Enumerate all locations where a given agent/skill is present */
  static async resolveAllLocations(
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<ManagedFile[]>;

  /** Copy agent/skill to a target harness directory, creating dir if needed */
  static async exportToHarness(
    sourcePath: string,
    targetHarnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<void>;

  /** Copy agent/skill into .flightpath/agents or .flightpath/skills */
  static async importToFlightPath(
    sourcePath: string,
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<void>;

  /** Delete a file/directory from a specific harness directory */
  static async deleteFromHarness(
    name: string,
    harnessId: HarnessId | "flightpath",
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<void>;

  /** Export to all listed harness directories at once */
  static async syncToHarnesses(
    sourcePath: string,
    targetHarnessIds: HarnessId[],
    workspaceRoot: string,
    type: "agent" | "skill"
  ): Promise<SyncResult[]>;
}
```

For skills (directory-based), export copies the entire `<name>/` directory. For agents
(single-file), export copies the `.agent.md` file.

Conflicts (file already exists at destination): default is overwrite with a confirmation
flag. Add an `overwrite: boolean` parameter; the UI prompts before calling with `true`.

### `src/utils/HarnessDirectoryUtils.ts`

New single source of truth for harness→directory mappings. Replaces the scattered path
strings in `AgentDiscovery.ts` and `SkillDiscovery.ts`.

```ts
export function getHarnessAgentDirs(
  harnessId: HarnessId,
  workspaceRoot: string
): string[];

export function getHarnessSkillDirs(
  harnessId: HarnessId,
  workspaceRoot: string
): string[];

export function getFlightPathAgentDir(workspaceRoot: string): string;
export function getFlightPathSkillDir(workspaceRoot: string): string;
```

`AgentDiscovery.ts` and `SkillDiscovery.ts` are refactored to call these instead of
constructing paths inline.

---

## Refactoring: `AgentDiscovery` and `SkillDiscovery`

Both files currently hardcode their search paths. After this change:

- `AgentDiscovery.discoverWorkspaceAgents()` calls `HarnessDirectoryUtils.getHarnessAgentDirs()`
- `SkillDiscovery.discoverSkills()` calls `HarnessDirectoryUtils.getHarnessSkillDirs()`
- `PATH_CONSTANTS.FLIGHTPATH_DIR / AGENTS_DIR` references route through `HarnessDirectoryUtils`

This makes `HarnessDirectoryUtils` the single source of truth for all path logic — a prerequisite
for the file manager to correctly resolve where things live.

---

## UI: New Settings Section

### Placement

Add a new tab or accordion section in the settings panel: **"Harness File Manager"**
(or "CLI File Manager"). The existing `HarnessesSection.tsx` remains unchanged — it
owns model/args defaults, not file management.

Route: a new entry in the settings tab list alongside the existing sections.

### Layout

```
┌─────────────────────────────────────────────────┐
│ Harness File Manager                             │
│                                                  │
│ Agents  Skills  [tab switcher]                   │
│                                                  │
│ ┌──────────────────────────────────────────────┐ │
│ │ senior-developer          [badges]           │ │
│ │   FP  Claude  Copilot                        │ │
│ │   [Export ▾]  [Delete ▾]                     │ │
│ ├──────────────────────────────────────────────┤ │
│ │ code-reviewer             [badges]           │ │
│ │   Claude                                     │ │
│ │   [Export ▾]  [Import to FP]  [Delete ▾]     │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ [Sync All to: Claude ▾]  [Open Folder]           │
└─────────────────────────────────────────────────┘
```

**Badges**: colored chip per harness/location where the file exists. "FP" = FlightPath dir.

**Export ▾**: dropdown of all harness directories. Disabled for harnesses with no native dir.
Grayed-out for harnesses that already have this file (with tooltip "already present").

**Delete ▾**: dropdown showing only locations where the file exists. Requires confirmation.

**Import to FP**: only shown when the file is NOT already in `.flightpath/agents|skills/`.

**Sync All to: [harness selector]**: copies every discovered file to the selected harness.

**Open Folder**: opens the native harness directory in Explorer/Finder.

### Webview Message Types

Add to `DashboardConstants.ts`:

```ts
// Request
REQUEST_HARNESS_FILES: "REQUEST_HARNESS_FILES";
EXPORT_TO_HARNESS: "EXPORT_TO_HARNESS";
IMPORT_TO_FLIGHTPATH: "IMPORT_TO_FLIGHTPATH";
DELETE_FROM_HARNESS: "DELETE_FROM_HARNESS";
SYNC_ALL_TO_HARNESS: "SYNC_ALL_TO_HARNESS";

// Response
HARNESS_FILES_RESULT: "HARNESS_FILES_RESULT";
HARNESS_FILE_OP_RESULT: "HARNESS_FILE_OP_RESULT";
```

### Zustand Store

New `useHarnessFileStore.ts` (or extend existing `settingsStore`):

```ts
interface HarnessFileStore {
  managedFiles: ManagedFile[];
  activeType: "agent" | "skill";
  loading: boolean;
  setActiveType: (type: "agent" | "skill") => void;
  requestFiles: () => void;
  exportFile: (name: string, source: string, targetHarnessId: string) => void;
  importFile: (name: string, source: string) => void;
  deleteFile: (name: string, harnessId: string) => void;
  syncAll: (targetHarnessId: string) => void;
}
```

---

## Webview Provider Wiring

In `FlightPathWebviewProvider.ts` (or the message-routing layer), handle the new message types:

```ts
case MESSAGE_TYPES.REQUEST_HARNESS_FILES:
  const files = await HarnessFileManager.resolveAllLocations(
    workspaceRoot, payload.type
  );
  panel.webview.postMessage({ type: MESSAGE_TYPES.HARNESS_FILES_RESULT, files });
  break;

case MESSAGE_TYPES.EXPORT_TO_HARNESS:
  await HarnessFileManager.exportToHarness(
    payload.sourcePath, payload.harnessId, workspaceRoot, payload.fileType
  );
  // Re-broadcast updated file list
  break;
```

---

## Settings for Auto-Sync (Future / Phase 2)

After the manual UI ships, add an optional VS Code setting:

```json
"flightpath.harnessSync.autoExportTargets": {
  "type": "array",
  "items": { "type": "string", "enum": ["claude-cli", "codex-cli", ...] },
  "description": "Harnesses to auto-export new agents/skills to when they are added to .flightpath/agents or .flightpath/skills.",
  "default": []
}
```

When a `.flightpath/agents/*.agent.md` file is created (watched by `PromptFileWatcher` or
a new `FileSystemWatcher`), auto-export to all listed harnesses without a manual trigger.

---

## Implementation Phases

### Phase 1 — Foundation (no UI, no regressions)

1. Create `HarnessDirectoryUtils.ts` with the harness→path mapping.
2. Refactor `AgentDiscovery.ts` and `SkillDiscovery.ts` to use it.
3. Create `HarnessFileManager.ts` with `resolveAllLocations`, `exportToHarness`,
   `importToFlightPath`, `deleteFromHarness`.
4. Unit tests for all `HarnessFileManager` operations (copy, delete, overwrite guard).

### Phase 2 — Message Contract + Provider Wiring

5. Add new message type constants to `DashboardConstants.ts`.
6. Add message handler cases in the webview provider.
7. Add request/response types to `WebviewMessageTypes.ts`.

### Phase 3 — UI

8. Create `HarnessFileManagerSection.tsx` component.
9. Create `useHarnessFileStore.ts` store.
10. Add section to settings panel nav.
11. Manual testing across harnesses with real agent files.

### Phase 4 — Auto-Sync (optional follow-up)

12. Add `flightpath.harnessSync.autoExportTargets` setting.
13. Wire file watcher on `.flightpath/agents/` and `.flightpath/skills/`.

---

## Files to Create

| File                                                                     | Purpose                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| `src/utils/HarnessDirectoryUtils.ts`                                     | Single source of truth for harness→path mappings |
| `src/utils/HarnessFileManager.ts`                                        | Core import/export/delete/sync logic             |
| `src/ui/webview-react/components/settings/HarnessFileManagerSection.tsx` | UI section                                       |
| `src/ui/webview-react/store/useHarnessFileStore.ts`                      | Zustand store                                    |
| `src/test/utils/HarnessFileManager.test.ts`                              | Unit tests                                       |

## Files to Modify

| File                                  | Change                                            |
| ------------------------------------- | ------------------------------------------------- |
| `src/utils/AgentDiscovery.ts`         | Use `HarnessDirectoryUtils` for path construction |
| `src/utils/SkillDiscovery.ts`         | Use `HarnessDirectoryUtils` for path construction |
| `src/types/DashboardConstants.ts`     | Add new message type constants                    |
| `src/types/WebviewMessageTypes.ts`    | Add request/response payload types                |
| `src/ui/FlightPathWebviewProvider.ts` | Handle new message types                          |
| Settings panel nav component          | Add "Harness File Manager" entry                  |

---

## Open Questions

1. **Conflict resolution** — When exporting and the target already has a different version of
   the file, should we diff them first? Or just offer "overwrite / skip / view diff"?

2. **User-level agents** — `AgentDiscovery` also checks `~/.config/Code/User/prompts/` (user
   scope). Should user-scope agents be exportable to harness workspace dirs? Probably yes
   with a warning, since the result lives in the workspace.

3. **Skill directory copy** — Skills are directories (`<name>/SKILL.md`). For harnesses that
   don't support subdirectories under their skills path, should FlightPath flatten them to
   a single file? Not in v1 — keep it simple, only copy where the same structure is expected.

4. **MCP phase** — MCP config formats differ significantly per harness (`~/.claude.json` vs
   `.vscode/mcp.json` vs harness CLI flags). Scope that as a follow-up plan with its own
   deep-dive into `McpDiscoveryUtils.ts` and `CliMcpConfigGenerator.ts`.
