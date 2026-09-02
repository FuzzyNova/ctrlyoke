import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { Log } from "../utils/Log";

/** Completion item shape used by the single-line script field. */
export interface ScriptCommandCompletionItem {
  label: string;
  insertText: string;
  detail?: string;
  documentation?: string;
  sortText?: string;
  kind?: number;
  filterText?: string;
}

/** Backward-compatible short name used by the shared message contract. */
export type ScriptCompletionItem = ScriptCommandCompletionItem;

export interface ScriptCompletionContext {
  /** Start of the segment, including whitespace following its delimiter. */
  segmentStart: number;
  /** End of the segment, excluding its next delimiter. */
  segmentEnd: number;
  /** First non-whitespace character in the current segment. */
  commandStart: number;
  /** Start of the text that a completion replaces. */
  replacementStart: number;
  /** The segment containing the cursor, without leading/trailing whitespace. */
  segment: string;
  /** Segment text from its command start through the cursor. */
  beforeCursor: string;
}

const PACKAGE_MANAGERS = {
  NPM: "npm",
  PNPM: "pnpm",
  YARN: "yarn",
} as const;
const PACKAGE_MANAGER_LIST = [
  PACKAGE_MANAGERS.NPM,
  PACKAGE_MANAGERS.PNPM,
  PACKAGE_MANAGERS.YARN,
] as const;
const SCRIPT_COMPLETION_MODES = {
  FULL: "full",
  SCRIPT_NAME: "script-name",
} as const;
type PackageManager = (typeof PACKAGE_MANAGER_LIST)[number];

interface ScriptRecord {
  name: string;
  command?: string;
}

interface CompletionCandidate extends ScriptCommandCompletionItem {
  mode: (typeof SCRIPT_COMPLETION_MODES)[keyof typeof SCRIPT_COMPLETION_MODES];
  manager?: PackageManager;
  scriptName?: string;
}

const STATIC_CANDIDATES: CompletionCandidate[] = [
  {
    label: "cd",
    insertText: "cd ",
    detail: "POSIX: change directory",
    mode: "full",
    sortText: "30",
  },
  {
    label: "pwd",
    insertText: "pwd",
    detail: "POSIX: print working directory",
    mode: "full",
    sortText: "30",
  },
  {
    label: "ls",
    insertText: "ls",
    detail: "POSIX: list directory contents",
    mode: "full",
    sortText: "30",
  },
  {
    label: "cat",
    insertText: "cat ",
    detail: "POSIX: print a file",
    mode: "full",
    sortText: "30",
  },
  {
    label: "echo",
    insertText: "echo ",
    detail: "Shell: print text",
    mode: "full",
    sortText: "30",
  },
  {
    label: "grep",
    insertText: "grep ",
    detail: "POSIX: search text",
    mode: "full",
    sortText: "30",
  },
  {
    label: "find",
    insertText: "find ",
    detail: "POSIX: find files",
    mode: "full",
    sortText: "30",
  },
  {
    label: "test",
    insertText: "test ",
    detail: "POSIX: evaluate a condition",
    mode: "full",
    sortText: "30",
  },
  {
    label: "true",
    insertText: "true",
    detail: "Shell: return success",
    mode: "full",
    sortText: "30",
  },
  {
    label: "false",
    insertText: "false",
    detail: "Shell: return failure",
    mode: "full",
    sortText: "30",
  },
  {
    label: "mkdir",
    insertText: "mkdir ",
    detail: "POSIX: create a directory",
    mode: "full",
    sortText: "30",
  },
  {
    label: "rm",
    insertText: "rm ",
    detail: "POSIX: remove files",
    mode: "full",
    sortText: "90",
  },
  {
    label: "cp",
    insertText: "cp ",
    detail: "POSIX: copy files",
    mode: "full",
    sortText: "30",
  },
  {
    label: "mv",
    insertText: "mv ",
    detail: "POSIX: move files",
    mode: "full",
    sortText: "30",
  },
  {
    label: "source",
    insertText: "source ",
    detail: "Bash/zsh: load a shell file",
    mode: "full",
    sortText: "30",
  },
  {
    label: "export",
    insertText: "export ",
    detail: "Bash/zsh: set an environment variable",
    mode: "full",
    sortText: "30",
  },
  {
    label: "set -e",
    insertText: "set -e",
    detail: "Bash/zsh: stop on command failure",
    mode: "full",
    sortText: "30",
  },
  {
    label: "[[ ... ]]",
    insertText: "[[  ]]",
    detail: "Bash/zsh: conditional expression",
    mode: "full",
    sortText: "30",
  },
  {
    label: "pwsh",
    insertText: "pwsh ",
    detail: "PowerShell: run a command",
    mode: "full",
    sortText: "30",
  },
  {
    label: "pwsh -File",
    insertText: "pwsh -File ",
    detail: "PowerShell: run a script file",
    mode: "full",
    sortText: "30",
  },
  {
    label: "powershell",
    insertText: "powershell ",
    detail: "PowerShell: run a command",
    mode: "full",
    sortText: "30",
  },
  {
    label: "powershell -ExecutionPolicy Bypass",
    insertText: "powershell -ExecutionPolicy Bypass ",
    detail: "PowerShell: run with execution policy bypassed",
    mode: "full",
    sortText: "30",
  },
  {
    label: "Get-ChildItem",
    insertText: "Get-ChildItem ",
    detail: "PowerShell: list directory contents",
    mode: "full",
    sortText: "30",
  },
  {
    label: "Get-Content",
    insertText: "Get-Content ",
    detail: "PowerShell: read a file",
    mode: "full",
    sortText: "30",
  },
  {
    label: "Test-Path",
    insertText: "Test-Path ",
    detail: "PowerShell: check whether a path exists",
    mode: "full",
    sortText: "30",
  },
  {
    label: "Select-String",
    insertText: "Select-String ",
    detail: "PowerShell: search text",
    mode: "full",
    sortText: "30",
  },
  {
    label: "New-Item",
    insertText: "New-Item ",
    detail: "PowerShell: create an item",
    mode: "full",
    sortText: "30",
  },
  {
    label: "Remove-Item",
    insertText: "Remove-Item ",
    detail: "PowerShell: remove an item",
    mode: "full",
    sortText: "90",
  },
  {
    label: "cmd /c",
    insertText: "cmd /c ",
    detail: "Windows shell: run a command",
    mode: "full",
    sortText: "30",
  },
  {
    label: "where",
    insertText: "where ",
    detail: "Windows: locate a command",
    mode: "full",
    sortText: "30",
  },
  {
    label: "dir",
    insertText: "dir",
    detail: "Windows shell: list directory contents",
    mode: "full",
    sortText: "30",
  },
  {
    label: "node",
    insertText: "node ",
    detail: "Node.js: run JavaScript",
    mode: "full",
    sortText: "30",
  },
  {
    label: "npx",
    insertText: "npx ",
    detail: "npm: run a package binary",
    mode: "full",
    sortText: "30",
  },
  {
    label: "npm",
    insertText: "npm ",
    detail: "npm: run a package command",
    mode: "full",
    sortText: "20",
  },
  {
    label: "npm run <script>",
    insertText: "npm run ",
    detail: "npm: run a package.json script",
    mode: "full",
    manager: "npm",
    sortText: "15",
  },
  {
    label: "npm test",
    insertText: "npm test",
    detail: "npm: run the test script",
    mode: "full",
    manager: "npm",
    sortText: "15",
  },
  {
    label: "npm install",
    insertText: "npm install",
    detail: "npm: install dependencies",
    mode: "full",
    manager: "npm",
    sortText: "15",
  },
  {
    label: "npm ci",
    insertText: "npm ci",
    detail: "npm: install from the lockfile",
    mode: "full",
    manager: "npm",
    sortText: "15",
  },
  {
    label: "pnpm",
    insertText: "pnpm ",
    detail: "pnpm: run a package command",
    mode: "full",
    sortText: "20",
  },
  {
    label: "pnpm run <script>",
    insertText: "pnpm run ",
    detail: "pnpm: run a package.json script",
    mode: "full",
    manager: "pnpm",
    sortText: "15",
  },
  {
    label: "pnpm test",
    insertText: "pnpm test",
    detail: "pnpm: run the test script",
    mode: "full",
    manager: "pnpm",
    sortText: "15",
  },
  {
    label: "yarn",
    insertText: "yarn ",
    detail: "yarn: run a package command",
    mode: "full",
    sortText: "20",
  },
  {
    label: "yarn <script>",
    insertText: "yarn ",
    detail: "yarn: run a package.json script",
    mode: "full",
    manager: "yarn",
    sortText: "15",
  },
  {
    label: "yarn test",
    insertText: "yarn test",
    detail: "yarn: run the test script",
    mode: "full",
    manager: "yarn",
    sortText: "15",
  },
  {
    label: "git status",
    insertText: "git status",
    detail: "Show the working tree status",
    mode: "full",
    sortText: "20",
  },
  {
    label: "git diff",
    insertText: "git diff",
    detail: "Show unstaged changes",
    mode: "full",
    sortText: "20",
  },
  {
    label: "git log",
    insertText: "git log",
    detail: "Show commit history",
    mode: "full",
    sortText: "20",
  },
  {
    label: "git rev-parse",
    insertText: "git rev-parse ",
    detail: "Git: inspect a repository value",
    mode: "full",
    sortText: "20",
  },
  {
    label: "git clean",
    insertText: "git clean ",
    detail: "Git: remove untracked files",
    mode: "full",
    sortText: "90",
  },
];

const packageScriptsCache = new Map<string, ScriptRecord[]>();
let packageJsonWatcher: vscode.FileSystemWatcher | undefined;

function ensurePackageJsonWatcher(): void {
  if (packageJsonWatcher) {
    return;
  }
  packageJsonWatcher =
    vscode.workspace.createFileSystemWatcher("**/package.json");
  const invalidate = (uri: vscode.Uri): void => {
    packageScriptsCache.delete(path.resolve(uri.fsPath));
  };
  packageJsonWatcher.onDidChange(invalidate);
  packageJsonWatcher.onDidCreate(invalidate);
  packageJsonWatcher.onDidDelete(invalidate);
}

/** Clear package-script cache state; intended for tests and workspace resets. */
export function clearScriptCommandCompletionCache(): void {
  packageScriptsCache.clear();
}

/**
 * Locate the command segment containing the cursor and the range to replace.
 * This parser intentionally knows only shell control boundaries; it does not
 * attempt to interpret quoting or shell expansion.
 */
export function parseScriptCompletionContext(
  text: string,
  position: number
): ScriptCompletionContext {
  const cursor = Math.max(0, Math.min(position, text.length));
  let segmentStart = 0;
  let segmentEnd = text.length;
  let boundary: RegExpExecArray | null;
  const controlBoundary = /\|\||&&|\||;/g;
  while ((boundary = controlBoundary.exec(text)) !== null) {
    if (boundary.index >= cursor) {
      segmentEnd = boundary.index;
      break;
    }
    segmentStart = boundary.index + boundary[0].length;
  }

  const segment = text.slice(segmentStart, segmentEnd).trim();
  const beforeCursor = text
    .slice(segmentStart, cursor)
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
  const leadingWhitespace =
    text.slice(segmentStart, cursor).match(/^\s*/)?.[0].length ?? 0;
  const commandStart = segmentStart + leadingWhitespace;
  const runPrefix = /^(?:npm|pnpm|yarn)\s+run\s+/i.exec(beforeCursor);
  const replacementStart = runPrefix
    ? commandStart + runPrefix[0].length
    : commandStart;

  return {
    segmentStart,
    segmentEnd,
    commandStart,
    replacementStart,
    segment,
    beforeCursor,
  };
}

async function readPackageScripts(
  packagePath: string
): Promise<ScriptRecord[]> {
  const cacheKey = path.resolve(packagePath);
  const cached = packageScriptsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let scripts: ScriptRecord[] = [];
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(cacheKey, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "scripts" in parsed) {
      const rawScripts = (parsed as { scripts?: unknown }).scripts;
      if (typeof rawScripts === "object" && rawScripts !== null) {
        scripts = Object.entries(rawScripts as Record<string, unknown>)
          .filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
          .map(([name, command]) => ({ name, command }));
      }
    }
  } catch (error) {
    Log.warn(
      `[Completions] Failed to read or parse ${cacheKey}; using built-ins:`,
      error
    );
  }
  packageScriptsCache.set(cacheKey, scripts);
  return scripts;
}

function resolveWorkspaceRoot(workspaceRoot?: string): string | undefined {
  return workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function packageCandidates(scripts: ScriptRecord[]): CompletionCandidate[] {
  const candidates: CompletionCandidate[] = [];
  for (const script of scripts) {
    const detail = script.command
      ? `package.json script: ${script.command}`
      : "package.json script";
    for (const manager of PACKAGE_MANAGER_LIST) {
      const shorthand =
        manager === PACKAGE_MANAGERS.NPM
          ? `${manager} run ${script.name}`
          : `${manager} ${script.name}`;
      candidates.push({
        label: shorthand,
        insertText: shorthand,
        detail,
        documentation: script.command,
        mode: "full",
        manager,
        scriptName: script.name,
        sortText: manager === PACKAGE_MANAGERS.NPM ? "10" : "12",
      });
      const runCommand = `${manager} run ${script.name}`;
      candidates.push({
        label: runCommand,
        insertText: runCommand,
        detail,
        documentation: script.command,
        mode: "full",
        manager,
        scriptName: script.name,
        sortText: manager === PACKAGE_MANAGERS.NPM ? "11" : "13",
      });
      candidates.push({
        label: runCommand,
        insertText: script.name,
        filterText: script.name,
        detail,
        documentation: script.command,
        mode: "script-name",
        manager,
        scriptName: script.name,
        sortText: manager === PACKAGE_MANAGERS.NPM ? "10" : "12",
      });
    }
  }
  return candidates;
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase());
}

function deduplicateCandidates(
  candidates: CompletionCandidate[]
): CompletionCandidate[] {
  const byLabel = new Map<string, CompletionCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.mode}:${candidate.label}:${candidate.insertText}`;
    if (!byLabel.has(key)) {
      byLabel.set(key, candidate);
    }
  }
  return [...byLabel.values()];
}

/**
 * Get script and shell command completions for the current cursor segment.
 * Package scripts are read from the first workspace folder (or the supplied
 * root) and are never executed.
 */
export async function getScriptCommandCompletions(
  workspaceRoot: string | undefined,
  text: string,
  position: number
): Promise<ScriptCommandCompletionItem[]> {
  ensurePackageJsonWatcher();
  const context = parseScriptCompletionContext(text, position);
  const root = resolveWorkspaceRoot(workspaceRoot);
  const scripts = root
    ? await readPackageScripts(path.join(root, "package.json"))
    : [];
  const candidates = deduplicateCandidates([
    ...STATIC_CANDIDATES,
    ...packageCandidates(scripts),
  ]);
  const beforeCursor = context.beforeCursor;
  const runMatch = /^(npm|pnpm|yarn)\s+run\s*(.*)$/i.exec(beforeCursor);
  let filtered: CompletionCandidate[];
  if (runMatch) {
    const manager = runMatch[1].toLowerCase() as PackageManager;
    const scriptPrefix = runMatch[2].trim();
    filtered = candidates.filter(
      (candidate) =>
        candidate.mode === SCRIPT_COMPLETION_MODES.SCRIPT_NAME &&
        candidate.manager === manager &&
        Boolean(candidate.scriptName) &&
        matchesPrefix(candidate.scriptName ?? "", scriptPrefix)
    );
  } else if (/^(npm|pnpm|yarn)(?:\s+.*)?$/i.test(beforeCursor)) {
    const manager = beforeCursor.split(/\s+/, 1)[0].toLowerCase();
    filtered = candidates.filter(
      (candidate) =>
        candidate.mode === SCRIPT_COMPLETION_MODES.FULL &&
        matchesPrefix(candidate.insertText, beforeCursor) &&
        (candidate.manager === undefined || candidate.manager === manager)
    );
  } else if (/^git(?:\s+.*)?$/i.test(beforeCursor)) {
    filtered = candidates.filter((candidate) =>
      matchesPrefix(candidate.insertText, beforeCursor)
    );
  } else if (!beforeCursor) {
    filtered = candidates;
  } else {
    filtered = candidates.filter((candidate) =>
      matchesPrefix(candidate.insertText, beforeCursor)
    );
  }

  return filtered.sort((a, b) => {
    const sortA = `${a.sortText ?? "50"}:${a.label}`;
    const sortB = `${b.sortText ?? "50"}:${b.label}`;
    return sortA.localeCompare(sortB);
  });
}

/** Alias with a shorter name for callers that do not need the implementation name. */
export const getScriptCompletions = getScriptCommandCompletions;
