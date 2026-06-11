import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Log } from "../../../utils/Log";
import { ChatSessionParser } from "./ChatSessionParser";
import {
  getVSCodeVariant,
  isWSL,
  getWSLWindowsAppDataDirs,
} from "../../../utils/HarnessDirectoryUtils";

interface SessionFile {
  path: string;
  mtime: number;
}

interface CompletionResult {
  completed: boolean;
  userCancelled?: boolean;
  failureReason?: string;
}

interface SessionSnapshot {
  completedRequestIndices: Set<number>; // Indices of requests that are COMPLETE
  requestCount: number; // Total requests when we cached
  lastMtime: number;
}

/**
 * Cache for directory listing results with mtime-based invalidation.
 * Avoids re-scanning the same directories every 500ms during polling.
 */
interface DirectoryCache {
  entries: SessionFile[];
  parentMtimes: Map<string, number>; // dir path → mtime at scan time
  timestamp: number; // when cache was built
}

/**
 * Monitors VS Code chat session JSON files for completion detection.
 * More reliable than log file monitoring (100% vs 70% reliability).
 *
 * Session files location:
 * - Windows: %APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\*.json|*.jsonl
 * - macOS: ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.json|*.jsonl
 * - Linux: ~/.config/Code/User/workspaceStorage/<hash>/chatSessions/*.json|*.jsonl
 * - WSL: /mnt/c/Users/<winuser>/AppData/Roaming/Code/User/workspaceStorage/<hash>/chatSessions/*.json|*.jsonl
 *   (VS Code UI runs on Windows host; session files are written to Windows AppData, not Linux ~/.config)
 *
 * Format note: VS Code switched from .json to .jsonl ~Feb 2026.
 * JSONL: each line is {"kind":N,"v":{...session data...}} — same structure, wrapped in "v".
 *
 * Performance Optimization:
 * - Session cache persists across ALL workflows (entire VS Code session)
 * - First prompt: Parse all ~100 files (~100ms one-time cost)
 * - Subsequent prompts: Only parse NEW/MODIFIED files (~5ms)
 * - Cache automatically cleared on VS Code restart
 */
export class ChatSessionMonitor {
  private sessionFilePath: string | null = null;
  private requestCountBeforeSend: number = 0;
  private promptText: string = ""; // Store prompt text for session matching
  private sessionsBeforeSend: Set<string> = new Set(); // Track session files that existed before sending

  // Session cache: tracks completed request indices in each session file
  // PERSISTS across workflows for performance (only parse files once per VS Code session)
  private sessionCache: Map<string, SessionSnapshot> = new Map();

  // Directory listing cache with mtime-based invalidation
  private dirCache: DirectoryCache | null = null;
  private static readonly DIR_CACHE_TTL_MS = 2000; // Re-scan directories every 2s max

  constructor(_context: vscode.ExtensionContext) {}

  /**
   * Get the cached session file path
   * Used by ChatSessionParser to extract structured output
   */
  getSessionFile(): string | undefined {
    return this.sessionFilePath || undefined;
  }

  /**
   * Find VS Code's workspaceStorage directory for all variants
   * Returns array of possible paths (some may not exist)
   */
  private getPossibleWorkspaceStorageRoots(): string[] {
    const platform = process.platform;
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const variant = getVSCodeVariant();

    const paths: string[] = [];

    if (platform === "win32") {
      const appData = process.env.APPDATA || "";
      // Primary variant
      paths.push(path.join(appData, variant, "User", "workspaceStorage"));
      // Also try standard Code if we're in a different variant
      if (variant !== "Code") {
        paths.push(path.join(appData, "Code", "User", "workspaceStorage"));
      }
    } else if (platform === "darwin") {
      // macOS
      paths.push(
        path.join(
          homeDir,
          "Library",
          "Application Support",
          variant,
          "User",
          "workspaceStorage"
        )
      );
      if (variant !== "Code") {
        paths.push(
          path.join(
            homeDir,
            "Library",
            "Application Support",
            "Code",
            "User",
            "workspaceStorage"
          )
        );
      }
    } else {
      // Linux (including WSL)
      const configDir =
        process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
      paths.push(path.join(configDir, variant, "User", "workspaceStorage"));
      if (variant !== "Code") {
        paths.push(path.join(configDir, "Code", "User", "workspaceStorage"));
      }

      // WSL: also search Windows AppData via /mnt/c/
      // VS Code's UI and chat session writer run on the Windows host, so session
      // files land in Windows AppData, not Linux ~/.config
      if (isWSL()) {
        const wslPaths = getWSLWindowsAppDataDirs(variant, [
          "User",
          "workspaceStorage",
        ]);
        paths.push(...wslPaths);
        Log.debug(
          `🐧 WSL detected — also searching Windows paths: ${wslPaths.join(", ")}`,
          "ChatSessionMonitor"
        );
      }
    }

    return paths;
  }

  /**
   * Find all chat session files across all workspaces and VS Code variants.
   * Uses directory mtime-based caching to avoid redundant re-scans during
   * 500ms polling loops.
   */
  private async findAllSessionFiles(): Promise<SessionFile[]> {
    // Check if cached results are still valid
    if (this.dirCache) {
      const age = Date.now() - this.dirCache.timestamp;
      if (age < ChatSessionMonitor.DIR_CACHE_TTL_MS) {
        // Cache is fresh enough — check if any parent directory mtimes changed
        let cacheValid = true;
        for (const [dirPath, cachedMtime] of this.dirCache.parentMtimes) {
          try {
            const stat = await fs.promises.stat(dirPath);
            if (stat.mtimeMs !== cachedMtime) {
              cacheValid = false;
              break;
            }
          } catch {
            cacheValid = false;
            break;
          }
        }
        if (cacheValid) {
          return this.dirCache.entries;
        }
      }
    }

    // Rebuild cache
    const possibleRoots = this.getPossibleWorkspaceStorageRoots();
    const sessionFiles: SessionFile[] = [];
    const parentMtimes = new Map<string, number>();

    Log.debug(
      `🗂️ Scanning ${possibleRoots.length} workspaceStorage root(s): ${possibleRoots.join(", ")}`,
      "ChatSessionMonitor"
    );

    for (const workspaceStorageRoot of possibleRoots) {
      try {
        await fs.promises.access(workspaceStorageRoot);
      } catch {
        Log.debug(
          `   ✗ Not found: ${workspaceStorageRoot}`,
          "ChatSessionMonitor"
        );
        continue;
      }
      Log.debug(`   ✓ Scanning: ${workspaceStorageRoot}`, "ChatSessionMonitor");

      try {
        const workspaceHashes = await fs.promises.readdir(workspaceStorageRoot);

        for (const hash of workspaceHashes) {
          const chatSessionsDir = path.join(
            workspaceStorageRoot,
            hash,
            "chatSessions"
          );

          try {
            const dirStat = await fs.promises.stat(chatSessionsDir);
            if (!dirStat.isDirectory()) {
              continue;
            }
            // Track directory mtime for cache invalidation
            parentMtimes.set(chatSessionsDir, dirStat.mtimeMs);
          } catch {
            continue;
          }

          const files = await fs.promises.readdir(chatSessionsDir);

          for (const file of files) {
            if (!file.endsWith(".json") && !file.endsWith(".jsonl")) {
              continue;
            }

            const filePath = path.join(chatSessionsDir, file);
            try {
              const stats = await fs.promises.stat(filePath);
              sessionFiles.push({
                path: filePath,
                mtime: stats.mtimeMs,
              });
            } catch {
              continue;
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (sessionFiles.length === 0) {
      Log.warn("⚠️ No chat session files found in any VS Code variant");
    }

    // Store in cache
    this.dirCache = {
      entries: sessionFiles,
      parentMtimes,
      timestamp: Date.now(),
    };

    return sessionFiles;
  }

  /**
   * Synchronous version of findAllSessionFiles for use in findSessionFileByPromptText.
   * This method is called from submitWithRetry's sync callback context.
   * Uses the directory cache if available to minimize blocking I/O.
   */
  private findAllSessionFilesSync(): SessionFile[] {
    // Return cached entries if still fresh
    if (this.dirCache) {
      const age = Date.now() - this.dirCache.timestamp;
      if (age < ChatSessionMonitor.DIR_CACHE_TTL_MS) {
        // Refresh file mtimes only (lightweight sync stat calls)
        const refreshed: SessionFile[] = [];
        for (const entry of this.dirCache.entries) {
          try {
            const stats = fs.statSync(entry.path);
            refreshed.push({ path: entry.path, mtime: stats.mtimeMs });
          } catch {
            // File may have been deleted
          }
        }
        return refreshed;
      }
    }

    // Fall back to full sync scan (only when no cache available)
    const possibleRoots = this.getPossibleWorkspaceStorageRoots();
    const sessionFiles: SessionFile[] = [];

    for (const root of possibleRoots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      try {
        for (const hash of fs.readdirSync(root)) {
          const dir = path.join(root, hash, "chatSessions");
          if (!fs.existsSync(dir)) {
            continue;
          }
          for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith(".json") && !file.endsWith(".jsonl")) {
              continue;
            }
            try {
              const filePath = path.join(dir, file);
              const stats = fs.statSync(filePath);
              sessionFiles.push({ path: filePath, mtime: stats.mtimeMs });
            } catch {
              /* skip */
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    return sessionFiles;
  }

  /**
   * Find session file containing our specific prompt text
   * Searches all session files for matching message.text
   *
   * IMPORTANT: Searches ALL files sorted by modification time (newest first).
   * - Handles resumed sessions from any age (user might resume chat from weeks ago)
   * - Handles duplicate prompts (returns most recently modified match)
   * - VS Code updates mtime when writing to session file, so recently active sessions float to top
   *
   * @param promptText The prompt text to search for
   * @returns Path to session file, or null if not found
   */
  findSessionFileByPromptText(promptText: string): string | null {
    // Get fresh file list with current mtime values (updated on each search)
    // Note: Uses cached directory listing internally (invalidated by mtime)
    // We call the sync-compatible version for this search since it's called
    // from submitWithRetry which expects synchronous returns
    const allFiles = this.findAllSessionFilesSync();

    // Sort by modification time (newest first) - CRITICAL for handling duplicate prompts
    // Recently updated files (including resumed old sessions) will be checked first
    allFiles.sort((a, b) => b.mtime - a.mtime);

    // Normalize prompt for comparison (trim and first 100 chars)
    const normalizedPrompt = promptText.trim().substring(0, 100);

    Log.debug(
      `🔎 Searching ${allFiles.length} session files for prompt: "${normalizedPrompt.substring(0, 60)}..."`,
      "ChatSessionMonitor"
    );

    let filesChecked = 0;
    let textMatchesSkippedDueToCompletion = 0;

    for (const file of allFiles) {
      try {
        const session = ChatSessionParser.parseSessionFile(file.path);

        const basename = path.basename(file.path);
        const cachedSnapshot = this.sessionCache.get(basename);

        if (!session?.requests || session.requests.length === 0) {
          filesChecked++;
          continue;
        }

        // Check each request's message text
        for (let i = 0; i < session.requests.length; i++) {
          const request = session.requests[i];
          const messageText: string | undefined = request.message?.text;

          if (!messageText) {
            continue;
          }

          if (messageText.includes(normalizedPrompt)) {
            // CRITICAL: Check if THIS SPECIFIC REQUEST INDEX was complete BEFORE we sent
            // Three cases:
            // 1. File not in cache yet (NEW session) → use it
            // 2. Request index >= cached request count (NEW request) → use it
            // 3. Request index < cached count AND was complete → skip it (old completed request)
            const wasCompleteBeforeSend =
              cachedSnapshot &&
              i < cachedSnapshot.requestCount &&
              cachedSnapshot.completedRequestIndices.has(i);

            if (wasCompleteBeforeSend) {
              Log.debug(
                `   ⏭️ Skipping ${basename} req[${i}]: text matches but was already complete before send ` +
                  `(cachedCount=${cachedSnapshot?.requestCount}, completedIndices=[${[...(cachedSnapshot?.completedRequestIndices ?? [])].join(",")}])`,
                "ChatSessionMonitor"
              );
              textMatchesSkippedDueToCompletion++;
              continue; // Skip this old completed request, keep searching
            }

            // This request is either:
            // 1. NEW (index >= cached request count) - added after we sent
            // 2. INCOMPLETE (existed before but not finished yet)
            // Both are valid matches!

            const ageSeconds = Math.round((Date.now() - file.mtime) / 1000);
            const ageDisplay =
              ageSeconds < 60
                ? `${ageSeconds}s ago`
                : `${Math.round(ageSeconds / 60)}min ago`;

            const isExisting = this.sessionsBeforeSend.has(basename);
            const sessionType = isExisting ? "EXISTING" : "NEW";
            const cachedInfo = cachedSnapshot
              ? `cachedCount=${cachedSnapshot.requestCount}, completedIndices=[${[...cachedSnapshot.completedRequestIndices].join(",")}]`
              : "not-in-cache";

            Log.debug(
              `✅ Found ${sessionType} session file by prompt match: ${basename} req[${i}] ` +
                `(modified ${ageDisplay}, checked ${filesChecked + 1} files, ${cachedInfo})`
            );
            return file.path;
          }
        }

        filesChecked++;
      } catch (err) {
        // Skip files we can't read or parse
        filesChecked++;
        continue;
      }
    }

    if (textMatchesSkippedDueToCompletion > 0) {
      Log.debug(
        `🔍 Prompt text found in ${textMatchesSkippedDueToCompletion} request(s) but all were already complete before send — still searching for new request`
      );
    }

    return null;
  }

  /**
   * Parse session file and extract completed request indices
   * Returns object with Set of completed request indices and total request count
   */
  private getSessionCompletionState(sessionFilePath: string): {
    completedRequestIndices: Set<number>;
    requestCount: number;
  } {
    const completedRequestIndices = new Set<number>();

    try {
      const session = ChatSessionParser.parseSessionFile(sessionFilePath);

      if (!session?.requests || session.requests.length === 0) {
        return { completedRequestIndices, requestCount: 0 };
      }

      // Check each request by index
      for (let i = 0; i < session.requests.length; i++) {
        const request = session.requests[i];
        const isComplete =
          request.result != null &&
          request.result.timings != null &&
          typeof request.result.timings.totalElapsed === "number" &&
          request.result.timings.totalElapsed > 0;

        if (isComplete) {
          completedRequestIndices.add(i);
        }
      }

      return {
        completedRequestIndices,
        requestCount: session.requests.length,
      };
    } catch (err) {
      return { completedRequestIndices, requestCount: 0 };
    }
  }

  /**
   * Read session file and get request count.
   * Delegates to ChatSessionParser as the single source of truth.
   */
  private getRequestCount(sessionFilePath: string): number {
    return ChatSessionParser.getRequestCount(sessionFilePath);
  }

  /**
   * Check if the last request in the session is complete.
   * Delegates to ChatSessionParser.isSessionComplete() for core completion logic,
   * and adds cancellation detection and optional debug logging on top.
   */
  private isLastRequestComplete(
    sessionFilePath: string,
    debug: boolean = false
  ): {
    complete: boolean;
    cancelled?: boolean;
  } {
    try {
      const session = ChatSessionParser.parseSessionFile(sessionFilePath);

      if (!session?.requests || session.requests.length === 0) {
        return { complete: false };
      }

      const lastRequest = session.requests[session.requests.length - 1];

      if (debug) {
        const hasResult = lastRequest.result != null;
        const hasTimings = hasResult && lastRequest.result.timings != null;
        const totalElapsed = hasTimings
          ? lastRequest.result.timings.totalElapsed
          : "N/A";
        Log.debug(
          `      🔍 Last request: result=${hasResult}, timings=${hasTimings}, totalElapsed=${totalElapsed}`
        );
      }

      // Check for cancellation first (not covered by isSessionComplete)
      if (
        typeof lastRequest.result?.errorDetails?.message === "string" &&
        lastRequest.result.errorDetails.message.includes("cancel")
      ) {
        return { complete: true, cancelled: true };
      }

      // Delegate core completion check to ChatSessionParser
      const isComplete = ChatSessionParser.isSessionComplete(sessionFilePath);

      return { complete: isComplete, cancelled: false };
    } catch (err) {
      if (debug) {
        Log.warn(`      ⚠️ Error reading session file: ${err}`);
      }
      return { complete: false };
    }
  }

  /**
   * Record the current state before sending a prompt
   * Stores prompt text for session file matching after send
   *
   * Strategy: Build cache of completed prompts to avoid matching old sessions
   * - First call: Parse all files (expensive but only once)
   * - Subsequent calls: Only parse NEW or MODIFIED files (fast)
   *
   * @param promptText The prompt text being sent (for session matching)
   */
  async recordPositionBeforeSend(promptText: string): Promise<void> {
    this.promptText = promptText;

    // Get all current session files
    const allFiles = await this.findAllSessionFiles();

    // Update cache: parse NEW or MODIFIED files only
    let parsedCount = 0;
    let skippedCount = 0;

    for (const file of allFiles) {
      const basename = path.basename(file.path);
      const cached = this.sessionCache.get(basename);

      // Check if we need to (re)parse this file
      const needsParsing = !cached || cached.lastMtime !== file.mtime;

      if (needsParsing) {
        // Parse file and extract completion state
        const { completedRequestIndices, requestCount } =
          this.getSessionCompletionState(file.path);

        // Update cache
        this.sessionCache.set(basename, {
          completedRequestIndices,
          requestCount,
          lastMtime: file.mtime,
        });

        parsedCount++;
      } else {
        skippedCount++;
      }
    }

    // Track which session files existed before send (for NEW vs EXISTING detection)
    this.sessionsBeforeSend.clear();
    for (const file of allFiles) {
      this.sessionsBeforeSend.add(path.basename(file.path));
    }

    // Count total completed requests across all sessions (for logging)
    let totalCompletedRequests = 0;
    for (const snapshot of this.sessionCache.values()) {
      totalCompletedRequests += snapshot.completedRequestIndices.size;
    }

    Log.debug(
      `📍 Snapshot: ${allFiles.length} sessions (parsed ${parsedCount}, skipped ${skippedCount}, ${totalCompletedRequests} completed requests)`
    );

    // If resuming session, get current request count
    if (this.sessionFilePath) {
      // Validate file still exists
      try {
        await fs.promises.access(this.sessionFilePath);
        this.requestCountBeforeSend = this.getRequestCount(
          this.sessionFilePath
        );
        Log.info(
          `📍 Resume session: ${path.basename(this.sessionFilePath)}, requests: ${this.requestCountBeforeSend}`
        );
      } catch {
        Log.warn("⚠️ Cached session file no longer exists, resetting");
        this.resetSession();
      }
    }

    // If no cached session, will search for it after submit
    if (!this.sessionFilePath) {
      this.requestCountBeforeSend = 0;
      Log.info("📍 New session - will search for session file after submit");
    }
  }

  /**
   * Wait for completion by polling the session file.
   *
   * Uses **inactivity-based** timeout: the timer resets each time VS Code writes
   * new data to the session file (mtime change). This allows responses that take
   * hours to complete without being cut short by a fixed wall-clock limit.
   *
   * @param isCancellingFn Function that returns true if cancellation requested
   * @param maxInactivityMs Max ms with NO session file writes before timing out
   * @returns Completion result with success/failure/cancellation status
   */
  async waitForCompletion(
    isCancellingFn: () => boolean,
    maxInactivityMs: number = 120000
  ): Promise<CompletionResult> {
    const POLL_INTERVAL = 500; // Check every 500ms
    const startTime = Date.now();
    let lastLogTime = startTime;
    let pollCount = 0;
    let foundSessionFile = !!this.sessionFilePath; // If we already have a session (resume), start tracking immediately

    // Inactivity tracking: reset whenever VS Code writes to the session file (mtime change)
    let lastActivityTime = startTime;
    let lastKnownMtime: number | null = null;

    if (!foundSessionFile) {
      Log.info("⏳ Searching for session file by prompt text...");
    } else {
      Log.debug(
        `⏳ Monitoring session: ${path.basename(this.sessionFilePath!)} (inactivity timeout: ${Math.round(maxInactivityMs / 1000)}s)`
      );
      // Seed initial mtime so first write resets the inactivity clock
      try {
        const stat = await fs.promises.stat(this.sessionFilePath!);
        lastKnownMtime = stat.mtimeMs;
      } catch {
        // File may not exist yet; will be caught on first poll
      }
    }

    while (true) {
      pollCount++;
      const now = Date.now();

      // Check for user cancellation
      if (isCancellingFn()) {
        Log.info("⏹️ Cancellation requested");
        return {
          completed: false,
          userCancelled: true,
        };
      }

      // ── Inactivity timeout check ──────────────────────────────────────────
      // Only enforce inactivity after we have a session file to track.
      // Before that, the submitWithRetry loop already enforces its own limit.
      if (foundSessionFile) {
        const inactiveMs = now - lastActivityTime;
        if (inactiveMs > maxInactivityMs) {
          const totalElapsed = Math.round((now - startTime) / 1000);
          const inactiveSec = Math.round(inactiveMs / 1000);
          const finalRequestCount = this.getRequestCount(this.sessionFilePath!);
          Log.warn(
            `⏱️ Session monitoring timeout after ${inactiveSec}s of inactivity (${totalElapsed}s total, ${finalRequestCount} requests)`
          );
          return {
            completed: false,
            failureReason: `Session monitoring inactivity timeout after ${inactiveSec}s`,
          };
        }
      }

      // ── Search for session file ───────────────────────────────────────────
      if (!foundSessionFile) {
        const matchedFile = this.findSessionFileByPromptText(this.promptText);
        if (matchedFile) {
          this.sessionFilePath = matchedFile;
          foundSessionFile = true;
          const requestCount = this.getRequestCount(matchedFile);
          const elapsed = Math.round((now - startTime) / 1000);

          // Check if this is NEW or EXISTING session
          const basename = path.basename(matchedFile);
          const isExisting = this.sessionsBeforeSend.has(basename);
          const sessionType = isExisting ? "EXISTING" : "NEW";

          Log.debug(
            `🎯 Found ${sessionType} session after ${elapsed}s: ${basename} (${requestCount} requests)`
          );

          // Seed inactivity tracking from actual file mtime
          try {
            const matchStat = await fs.promises.stat(matchedFile);
            lastKnownMtime = matchStat.mtimeMs;
          } catch {
            // ignore
          }
          lastActivityTime = now; // Reset inactivity clock from moment of discovery

          // IMPORTANT: Check if the response is already complete when we find the file
          // This handles the case where Copilot finished before we found the session
          if (requestCount > 0) {
            const { complete, cancelled } =
              this.isLastRequestComplete(matchedFile);
            if (complete) {
              if (cancelled) {
                Log.debug(
                  "⚠️ User cancelled in chat (detected on file discovery)"
                );
                return {
                  completed: false,
                  userCancelled: true,
                };
              }
              Log.debug("✅ Response already complete when session found");
              return { completed: true };
            }
          }

          // Response not complete yet, continue monitoring
          this.requestCountBeforeSend = requestCount;
        } else {
          // Log search progress every 5 seconds
          if (now - lastLogTime >= 5000) {
            const elapsed = Math.round((now - startTime) / 1000);
            Log.trace(`🔍 Still searching... (${elapsed}s elapsed)`);
            lastLogTime = now;
          }
          // Keep searching
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
          continue;
        }
      }

      // ── Check session file mtime for activity ─────────────────────────────
      // VS Code appends JSONL patches while streaming — mtime changes on each write
      try {
        const pollStat = await fs.promises.stat(this.sessionFilePath!);
        const currentMtime = pollStat.mtimeMs;
        if (currentMtime !== lastKnownMtime) {
          if (lastKnownMtime !== null) {
            Log.debug(`📝 Session file updated — inactivity clock reset`);
          }
          lastKnownMtime = currentMtime;
          lastActivityTime = now;
        }
      } catch {
        // File may be temporarily locked; ignore and keep polling
      }

      // ── Completion check ──────────────────────────────────────────────────
      const currentRequestCount = this.getRequestCount(this.sessionFilePath!);
      const inactiveSec = Math.round((now - lastActivityTime) / 1000);
      const totalSec = Math.round((now - startTime) / 1000);

      // Log progress every 5 seconds
      if (now - lastLogTime >= 5000) {
        Log.debug(
          `⏳ Waiting for completion... ${totalSec}s total, ${inactiveSec}s inactive (${currentRequestCount} requests)`
        );
        lastLogTime = now;
      }

      if (currentRequestCount > 0) {
        // Debug logging on first poll or every 10 seconds
        const shouldDebug = pollCount === 1 || totalSec % 10 < 1;

        const { complete, cancelled } = this.isLastRequestComplete(
          this.sessionFilePath!,
          shouldDebug
        );

        if (shouldDebug) {
          Log.debug(
            `   🔎 Completion check result: complete=${complete}, cancelled=${cancelled}`
          );
        }

        if (complete) {
          if (cancelled) {
            Log.info("⚠️ User cancelled in chat");
            return {
              completed: false,
              userCancelled: true,
            };
          }

          Log.info("✅ Response complete (session file)");
          return { completed: true };
        }
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }

  /**
   * Set the session file path if already known (avoids re-searching)
   * @param filePath Path to the session file
   */
  setSessionFile(filePath: string): void {
    this.sessionFilePath = filePath;
    this.requestCountBeforeSend = this.getRequestCount(filePath);

    // Check if this is a NEW or EXISTING session
    const basename = path.basename(filePath);
    const isExisting = this.sessionsBeforeSend.has(basename);
    const sessionType = isExisting ? "EXISTING" : "NEW";

    Log.info(
      `📍 Session file set: ${basename} (${this.requestCountBeforeSend} requests, ${sessionType} session)`
    );
  }

  /**
   * Reset session tracking (call when starting a new chat session)
   *
   * NOTE: Does NOT clear sessionCache - that persists across workflows
   * for performance (only parse files once per VS Code session)
   */
  resetSession(): void {
    this.sessionFilePath = null;
    this.requestCountBeforeSend = 0;
    this.promptText = "";
    this.sessionsBeforeSend.clear();
  }

  /**
   * Initialize the monitor (no-op for session monitoring, kept for API compatibility)
   */
  async initialize(): Promise<void> {
    // Session monitoring doesn't need initialization
    Log.info("✅ Session monitor ready");
  }
}
