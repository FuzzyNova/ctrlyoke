import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Log } from "../utils/Log";
import { CommitMessageGenerator, type CommitResult } from "../git/CommitMessageGenerator";
import type {
  WorkspaceTreeResponse,
  WorkspaceFileResponse,
  WorkspaceFileSaveRequest,
  WorkspaceScmStatusResponse,
  WorkspaceScmDiffResponse,
  WorkspacePushResponse,
  WorkspacePullResponse,
  DiffKind,
} from "../types/HostedWorkspaceViewerTypes";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const BINARY_CHECK_BYTES = 8192;
const MAX_ENTRIES = 1000;

/** Extension → Monaco language ID mapping. */
const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  go: "go",
  rs: "rust",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  toml: "toml",
  ini: "ini",
  env: "properties",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  dockerfile: "dockerfile",
  txt: "plaintext",
};

function languageFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath).toLowerCase();
  // Special full-filename matches
  if (base === "dockerfile") return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "properties";
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return LANGUAGE_MAP[ext];
}

/** Convert OS path separators to forward slashes for git commands. */
function toGitPath(p: string): string {
  return p.split(path.sep).join("/");
}

function normalizeScmPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export class HostedWorkspaceViewerService {
  private readonly commitGenerator = new CommitMessageGenerator();

  constructor(private readonly workspaceRoot: string) {}

  // ── Path safety ──────────────────────────────────────────────────────────

  private safeResolve(requestedPath: string): string | null {
    const normalizedRoot = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(normalizedRoot, requestedPath);

    // Reject if the normalised path escapes the workspace
    if (
      !resolved.startsWith(normalizedRoot + path.sep) &&
      resolved !== normalizedRoot
    ) {
      return null;
    }

    // Try to resolve symlinks on the full path
    try {
      const realResolved = fs.realpathSync(resolved);
      const realRoot = fs.realpathSync(normalizedRoot);
      if (
        !realResolved.startsWith(realRoot + path.sep) &&
        realResolved !== realRoot
      ) {
        return null;
      }
      return realResolved;
    } catch {
      // Path doesn't exist yet (e.g. new file write) — fall back to parent check
      const parent = path.dirname(resolved);
      try {
        const realParent = fs.realpathSync(parent);
        const realRoot = fs.realpathSync(normalizedRoot);
        if (
          !realParent.startsWith(realRoot + path.sep) &&
          realParent !== realRoot
        ) {
          return null;
        }
      } catch {
        // Parent also doesn't exist; rely on the normalised check above
      }
      return resolved;
    }
  }

  /** Returns workspace-relative path using the OS separator. */
  private relativePath(absolutePath: string): string {
    const normalizedRoot = path.resolve(this.workspaceRoot);
    return path.relative(normalizedRoot, absolutePath);
  }

  // ── Directory listing ────────────────────────────────────────────────────

  async listDirectory(requestedPath: string): Promise<WorkspaceTreeResponse> {
    const rootLabel = path.basename(this.workspaceRoot);

    const resolved = this.safeResolve(requestedPath);
    if (!resolved) {
      Log.warn(
        `WorkspaceViewer: path escape attempt rejected: ${requestedPath}`
      );
      return {
        rootLabel,
        path: "",
        parentPath: null,
        entries: [],
      };
    }

    const relDir = this.relativePath(resolved);
    const parentPath =
      relDir === "" ? null : this.relativePath(path.dirname(resolved));

    try {
      const dirents = await fs.promises.readdir(resolved, {
        withFileTypes: true,
      });

      const dirs = dirents
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = dirents
        .filter((d) => d.isFile())
        .sort((a, b) => a.name.localeCompare(b.name));

      const allEntries = [...dirs, ...files].slice(0, MAX_ENTRIES);

      const entries = await Promise.all(
        allEntries.map(async (dirent) => {
          const entryAbsolute = path.join(resolved, dirent.name);
          const entryRelative = this.relativePath(entryAbsolute);
          if (dirent.isDirectory()) {
            return {
              name: dirent.name,
              path: entryRelative,
              kind: "directory" as const,
            };
          }
          let size: number | undefined;
          try {
            const stat = await fs.promises.stat(entryAbsolute);
            size = stat.size;
          } catch {
            // ignore stat failures
          }
          return {
            name: dirent.name,
            path: entryRelative,
            kind: "file" as const,
            size,
          };
        })
      );

      return { rootLabel, path: relDir, parentPath, entries };
    } catch (err) {
      Log.error(
        `WorkspaceViewer: listDirectory failed for ${resolved}: ${String(err)}`
      );
      return { rootLabel, path: relDir, parentPath, entries: [] };
    }
  }

  // ── File read ────────────────────────────────────────────────────────────

  async readFile(requestedPath: string): Promise<WorkspaceFileResponse> {
    const resolved = this.safeResolve(requestedPath);
    if (!resolved) {
      return this.rejectedFileResponse(requestedPath, "Path not allowed");
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      return this.rejectedFileResponse(requestedPath, "File not found");
    }

    if (stat.size > MAX_FILE_SIZE) {
      return this.rejectedFileResponse(requestedPath, "File too large");
    }

    if (await this.isBinaryFile(resolved)) {
      return this.rejectedFileResponse(requestedPath, "Binary file");
    }

    const raw = await fs.promises.readFile(resolved, "utf8");
    const eol: "lf" | "crlf" = raw.includes("\r\n") ? "crlf" : "lf";
    const relPath = this.relativePath(resolved);

    return {
      path: relPath,
      name: path.basename(resolved),
      language: languageFromPath(resolved),
      size: stat.size,
      eol,
      content: raw,
    };
  }

  private rejectedFileResponse(
    requestedPath: string,
    reason: string
  ): WorkspaceFileResponse {
    return {
      path: requestedPath,
      name: path.basename(requestedPath),
      size: 0,
      eol: "lf",
      content: "",
      readOnly: true,
      reason,
    };
  }

  private async isBinaryFile(filePath: string): Promise<boolean> {
    let fd: fs.promises.FileHandle | undefined;
    try {
      fd = await fs.promises.open(filePath, "r");
      const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
      const { bytesRead } = await fd.read(buffer, 0, BINARY_CHECK_BYTES, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      await fd?.close();
    }
  }

  // ── File save ────────────────────────────────────────────────────────────

  async saveFile(req: WorkspaceFileSaveRequest): Promise<void> {
    const resolved = this.safeResolve(req.path);
    if (!resolved) {
      throw new Error("Path not allowed");
    }

    // Check if existing file is binary — refuse to overwrite
    let originalEol: "lf" | "crlf" = "lf";
    try {
      if (await this.isBinaryFile(resolved)) {
        throw new Error("Cannot overwrite binary file");
      }
      const existing = await fs.promises.readFile(resolved, "utf8");
      originalEol = existing.includes("\r\n") ? "crlf" : "lf";
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === "Cannot overwrite binary file"
      ) {
        throw err;
      }
      // File doesn't exist yet — new file, keep LF
    }

    // Normalize incoming content to the original EOL
    let content = req.content.replace(/\r\n/g, "\n");
    if (originalEol === "crlf") {
      content = content.replace(/\n/g, "\r\n");
    }

    const tmpPath = `${resolved}.fp-tmp`;
    await fs.promises.writeFile(tmpPath, content, "utf8");
    await fs.promises.rename(tmpPath, resolved);
  }

  // ── Git status ───────────────────────────────────────────────────────────

  async getStatus(): Promise<WorkspaceScmStatusResponse> {
    try {
      const [{ stdout }, syncCounts] = await Promise.all([
        execFileAsync(
          "git",
          ["-C", this.workspaceRoot, "status", "--porcelain=v1"],
          {
            timeout: GIT_TIMEOUT_MS,
          }
        ),
        this.getSyncCounts(),
      ]);
      return {
        files: this.parsePorcelainV1(stdout),
        ...syncCounts,
      };
    } catch {
      return {
        files: [],
        incomingCommitCount: 0,
        outgoingCommitCount: 0,
      };
    }
  }

  private async getSyncCounts(): Promise<
    Pick<
      WorkspaceScmStatusResponse,
      "incomingCommitCount" | "outgoingCommitCount"
    >
  > {
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "-C",
          this.workspaceRoot,
          "rev-list",
          "--left-right",
          "--count",
          "@{upstream}...HEAD",
        ],
        { timeout: GIT_TIMEOUT_MS }
      );
      const [incomingRaw, outgoingRaw] = stdout.trim().split(/\s+/);
      return {
        incomingCommitCount: this.parseCommitCount(incomingRaw),
        outgoingCommitCount: this.parseCommitCount(outgoingRaw),
      };
    } catch {
      return {
        incomingCommitCount: 0,
        outgoingCommitCount: 0,
      };
    }
  }

  private parseCommitCount(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private parsePorcelainV1(
    output: string
  ): WorkspaceScmStatusResponse["files"] {
    return output
      .split("\n")
      .filter((line) => line.length >= 3)
      .map((line) => {
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        let filePath = line.slice(3);

        // Renamed files: "old-path -> new-path"
        const arrowIdx = filePath.indexOf(" -> ");
        if (arrowIdx !== -1) {
          filePath = filePath.slice(arrowIdx + 4);
        }

        const isUntracked = x === "?" && y === "?";
        const stagedStatus = isUntracked ? null : x !== " " ? x : null;
        const unstagedStatus = y !== " " ? y : null;

        let kind: DiffKind;
        if (isUntracked) {
          kind = "untracked";
        } else if (x === "A") {
          kind = "added";
        } else if (x === "D" || y === "D") {
          kind = "deleted";
        } else if (x === "R") {
          kind = "renamed";
        } else {
          kind = "modified";
        }

        return {
          path: normalizeScmPath(filePath),
          stagedStatus,
          unstagedStatus,
          kind,
        };
      });
  }

  // ── Git diff ─────────────────────────────────────────────────────────────

  async getDiff(requestedPath: string): Promise<WorkspaceScmDiffResponse> {
    const resolved = this.safeResolve(requestedPath);
    if (!resolved) {
      throw new Error("Path not allowed");
    }

    const relPath = this.relativePath(resolved);
    const normalizedRelPath = normalizeScmPath(relPath);
    const gitPath = toGitPath(relPath);
    const language = languageFromPath(resolved);

    // Determine kind from status
    const status = await this.getStatus();
    const fileStatus = status.files.find(
      (f) => normalizeScmPath(f.path) === normalizedRelPath
    );
    const kind: DiffKind = fileStatus?.kind ?? "modified";

    const oldContent = await this.getHeadContent(gitPath);
    let newContent = "";

    if (kind !== "deleted") {
      try {
        newContent = await fs.promises.readFile(resolved, "utf8");
      } catch {
        newContent = "";
      }
    }

    return {
      path: fileStatus?.path ?? normalizedRelPath,
      language,
      oldContent,
      newContent,
      kind,
    };
  }

  private async getHeadContent(gitRelPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.workspaceRoot, "show", `HEAD:${gitRelPath}`],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout;
    } catch {
      return "";
    }
  }

  // ── Git stage / unstage ──────────────────────────────────────────────────

  async stageFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");
    const relPath = toGitPath(this.relativePath(resolved));
    await execFileAsync(
      "git",
      ["-C", this.workspaceRoot, "add", "--", relPath],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  async unstageFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");
    const relPath = toGitPath(this.relativePath(resolved));
    await execFileAsync(
      "git",
      ["-C", this.workspaceRoot, "restore", "--staged", "--", relPath],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  async discardFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");

    const relPath = this.relativePath(resolved);
    const normalizedRelPath = normalizeScmPath(relPath);
    const status = await this.getStatus();
    const fileStatus = status.files.find(
      (file) => normalizeScmPath(file.path) === normalizedRelPath
    );

    if (fileStatus?.kind === "untracked") {
      await fs.promises.rm(resolved, { recursive: true, force: true });
      return;
    }

    await execFileAsync(
      "git",
      [
        "-C",
        this.workspaceRoot,
        "restore",
        "--worktree",
        "--",
        toGitPath(relPath),
      ],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  // ── Git commit ───────────────────────────────────────────────────────────

  async commit(message: string): Promise<void> {
    if (!message.trim()) throw new Error("Commit message is required");
    await execFileAsync(
      "git",
      ["-C", this.workspaceRoot, "commit", "-m", message],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  // ── Git push ─────────────────────────────────────────────────────────────

  async push(): Promise<WorkspacePushResponse> {
    const [branch, remote] = await Promise.all([
      this.currentBranch(),
      this.currentRemote(),
    ]);
    await execFileAsync("git", ["-C", this.workspaceRoot, "push"], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch, remote };
  }

  // ── Commit message generation ────────────────────────────────────────────

  async generateCommitMessage(instructions?: string): Promise<CommitResult | null> {
    return this.commitGenerator.generate(this.workspaceRoot, undefined, instructions);
  }

  // ── Git pull ─────────────────────────────────────────────────────────────

  async pull(): Promise<WorkspacePullResponse> {
    const [branch, remote] = await Promise.all([
      this.currentBranch(),
      this.currentRemote(),
    ]);
    await execFileAsync("git", ["-C", this.workspaceRoot, "pull"], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch, remote };
  }

  // ── Git helpers ──────────────────────────────────────────────────────────

  private async currentBranch(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.workspaceRoot, "branch", "--show-current"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim() || "HEAD";
    } catch {
      return "HEAD";
    }
  }

  private async currentRemote(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.workspaceRoot, "remote"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim().split("\n")[0] ?? "origin";
    } catch {
      return "origin";
    }
  }
}
