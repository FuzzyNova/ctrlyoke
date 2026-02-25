import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Log } from "../../utils/Log";
import { ChatSessionParser } from "./ChatSessionParser";

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
 * Monitors VS Code chat session JSON files for completion detection.
 * More reliable than log file monitoring (100% vs 70% reliability).
 *
 * Session files location:
 * - Windows: %APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\*.json|*.jsonl
 * - macOS: ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.json|*.jsonl
 * - Linux: ~/.config/Code/User/workspaceStorage/<hash>/chatSessions/*.json|*.jsonl
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
  private context: vscode.ExtensionContext;
  private sessionFilePath: string | null = null;
  private requestCountBeforeSend: number = 0;
  private promptText: string = ""; // Store prompt text for session matching
  private sessionsBeforeSend: Set<string> = new Set(); // Track session files that existed before sending

  // Session cache: tracks completed request indices in each session file
  // PERSISTS across workflows for performance (only parse files once per VS Code session)
  private sessionCache: Map<string, SessionSnapshot> = new Map();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Get the cached session file path
   * Used by ChatSessionParser to extract structured output
   */
  getSessionFile(): string | undefined {
    return this.sessionFilePath || undefined;
  }

  /**
   * Detect which VS Code variant is running
   * Returns: "Code", "Code - Insiders", "VSCodium", etc.
   */
  private getVSCodeVariant(): string {
    // VS Code sets different executable paths based on variant
    const execPath = process.execPath.toLowerCase();

    if (execPath.includes("insiders")) {
      return "Code - Insiders";
    } else if (execPath.includes("vscodium")) {
      return "VSCodium";
    } else {
      return "Code";
    }
  }

  /**
   * Find VS Code's workspaceStorage directory for all variants
   * Returns array of possible paths (some may not exist)
   */
  private getPossibleWorkspaceStorageRoots(): string[] {
    const platform = process.platform;
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const variant = this.getVSCodeVariant();

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
      // Linux
      const configDir =
        process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
      paths.push(path.join(configDir, variant, "User", "workspaceStorage"));
      if (variant !== "Code") {
        paths.push(path.join(configDir, "Code", "User", "workspaceStorage"));
      }
    }

    return paths;
  }

  /**
   * Find all chat session files across all workspaces and VS Code variants
   */
  private findAllSessionFiles(): SessionFile[] {
    const possibleRoots = this.getPossibleWorkspaceStorageRoots();
    const sessionFiles: SessionFile[] = [];

    for (const workspaceStorageRoot of possibleRoots) {
      if (!fs.existsSync(workspaceStorageRoot)) {
        continue;
      }

      try {
        // Enumerate all workspace hashes
        const workspaceHashes = fs.readdirSync(workspaceStorageRoot);

        for (const hash of workspaceHashes) {
          const chatSessionsDir = path.join(
            workspaceStorageRoot,
            hash,
            "chatSessions"
          );

          if (!fs.existsSync(chatSessionsDir)) {
            continue;
          }

          const files = fs.readdirSync(chatSessionsDir);

          for (const file of files) {
            if (!file.endsWith(".json") && !file.endsWith(".jsonl")) {
              continue;
            }

            const filePath = path.join(chatSessionsDir, file);
            try {
              const stats = fs.statSync(filePath);
              sessionFiles.push({
                path: filePath,
                mtime: stats.mtimeMs,
              });
            } catch (err) {
              // Skip files we can't stat
              continue;
            }
          }
        }
      } catch (err) {
        // Skip roots we can't access
        continue;
      }
    }

    if (sessionFiles.length === 0) {
      Log.warn("⚠️ No chat session files found in any VS Code variant");
    }

    return sessionFiles;
  }

  /**
   * Find the most recently modified session file
   */
  private findMostRecentSessionFile(): string | null {
    const allFiles = this.findAllSessionFiles();

    if (allFiles.length === 0) {
      return null;
    }

    // Sort by modification time (most recent first)
    allFiles.sort((a, b) => b.mtime - a.mtime);

    return allFiles[0].path;
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
    const allFiles = this.findAllSessionFiles();

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

            Log.info(
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
      Log.info(
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
   * Read session file and get request count
   */
  private getRequestCount(sessionFilePath: string): number {
    try {
      const session = ChatSessionParser.parseSessionFile(sessionFilePath);
      return session?.requests?.length ?? 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * Check if the last request in the session is complete
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
        Log.info(
          `      🔍 Last request: result=${hasResult}, timings=${hasTimings}, totalElapsed=${totalElapsed}`
        );
      }

      // Check for cancellation first
      if (
        typeof lastRequest.result?.errorDetails?.message === "string" &&
        lastRequest.result.errorDetails.message.includes("cancel")
      ) {
        return { complete: true, cancelled: true };
      }

      // Check for completion: result.timings.totalElapsed > 0
      const isComplete =
        lastRequest.result != null &&
        lastRequest.result.timings != null &&
        typeof lastRequest.result.timings.totalElapsed === "number" &&
        lastRequest.result.timings.totalElapsed > 0;

      return { complete: isComplete, cancelled: false };
    } catch (err) {
      // File may be locked or corrupted
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
    const allFiles = this.findAllSessionFiles();

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

    Log.info(
      `📍 Snapshot: ${allFiles.length} sessions (parsed ${parsedCount}, skipped ${skippedCount}, ${totalCompletedRequests} completed requests)`
    );

    // If resuming session, get current request count
    if (this.sessionFilePath) {
      // Validate file still exists
      if (!fs.existsSync(this.sessionFilePath)) {
        Log.warn("⚠️ Cached session file no longer exists, resetting");
        this.resetSession();
      } else {
        this.requestCountBeforeSend = this.getRequestCount(
          this.sessionFilePath
        );
        Log.info(
          `📍 Resume session: ${path.basename(this.sessionFilePath)}, requests: ${this.requestCountBeforeSend}`
        );
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
      Log.info(
        `⏳ Monitoring session: ${path.basename(this.sessionFilePath!)} (inactivity timeout: ${Math.round(maxInactivityMs / 1000)}s)`
      );
      // Seed initial mtime so first write resets the inactivity clock
      try {
        lastKnownMtime = fs.statSync(this.sessionFilePath!).mtimeMs;
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

          Log.info(
            `🎯 Found ${sessionType} session after ${elapsed}s: ${basename} (${requestCount} requests)`
          );

          // Seed inactivity tracking from actual file mtime
          try {
            lastKnownMtime = fs.statSync(matchedFile).mtimeMs;
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
                Log.info(
                  "⚠️ User cancelled in chat (detected on file discovery)"
                );
                return {
                  completed: false,
                  userCancelled: true,
                };
              }
              Log.info("✅ Response already complete when session found");
              return { completed: true };
            }
          }

          // Response not complete yet, continue monitoring
          this.requestCountBeforeSend = requestCount;
        } else {
          // Log search progress every 5 seconds
          if (now - lastLogTime >= 5000) {
            const elapsed = Math.round((now - startTime) / 1000);
            Log.info(`🔍 Still searching... (${elapsed}s elapsed)`);
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
        const currentMtime = fs.statSync(this.sessionFilePath!).mtimeMs;
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
        Log.info(
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
          Log.info(
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
