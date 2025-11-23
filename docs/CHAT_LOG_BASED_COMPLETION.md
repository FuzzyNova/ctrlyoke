# Chat Log-Based Completion Detection

## Overview

Replace the current brittle chat completion detection (tool callbacks + clipboard polling) with a **robust log file monitoring approach** similar to CLI mode's session tracking.

## Current Problems

### Existing Implementation Issues

- ❌ **Tool callback unreliable** - LLM may forget to call `#flightpath_response_complete`
- ❌ **Clipboard polling brittle** - 2-minute stability wait, timing-dependent
- ❌ **Context pollution** - Tool instruction XML tags clutter prompts
- ❌ **Multiple retries** - Complex submit verification with exponential backoff
- ❌ **UI dependencies** - Requires window focus, clipboard access, timing delays

### Why Log-Based Detection is Better

- ✅ **Deterministic** - File-based, no UI timing dependencies
- ✅ **No context pollution** - No tool instructions needed in prompts
- ✅ **Reliable completion markers** - `finish reason: [stop]` appears when done
- ✅ **Proven approach** - Already works successfully in CLI mode
- ✅ **Platform-agnostic** - Same pattern on Windows/macOS/Linux

## Investigation Results

### Log File Location Pattern

```
Windows: %APPDATA%\Roaming\Code\logs\{timestamp}\window{N}\exthost\GitHub.copilot-chat\GitHub Copilot Chat.log
macOS:   ~/Library/Application Support/Code/logs/{timestamp}/window{N}/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log
Linux:   ~/.config/Code/logs/{timestamp}/window{N}/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log
```

**Key Finding**: Multiple window folders exist (`window1`, `window2`, etc.). The active log is determined by **most recent modification time**, not folder name.

### Increasing Log Verbosity

For more detailed log output (including request IDs, session identifiers, and full response details), increase the log level to `Trace`:

#### Method 1: Manual (User Action)

1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type and select: **Developer: Set Log Level...**
3. Select: **GitHub Copilot Chat**
4. Choose: **Trace** (maximum verbosity)

#### Method 2: Programmatic (Extension Code)

Extensions can programmatically set log levels for other extensions by launching a new VS Code instance with command-line arguments:

```typescript
import * as child_process from "child_process";

/**
 * Launch VS Code with increased log verbosity for GitHub Copilot Chat
 * Note: This starts a NEW VS Code instance - not practical for runtime use
 */
function launchWithVerboseLogging() {
  const codePath = process.execPath; // Path to VS Code executable

  child_process.spawn(
    codePath,
    [
      "--log",
      "GitHub.copilot-chat:trace",
      // Can also specify multiple extensions:
      // '--log', 'GitHub.copilot:trace',
      // '--log', 'GitHub.copilot-chat:trace',
    ],
    {
      detached: true,
      stdio: "ignore",
    }
  );
}
```

**Command Line Usage (Direct)**:

```bash
# Windows
code --log GitHub.copilot-chat:trace

# macOS/Linux
code --log GitHub.copilot-chat:trace
```

**Important Notes**:

- ⚠️ **No runtime API**: VS Code does not provide an API for extensions to change log levels of other extensions at runtime
- ⚠️ **New instance required**: Programmatic approach requires launching a new VS Code instance
- ✅ **Manual method recommended**: For investigation purposes, use Command Palette method
- ℹ️ **Log levels**: `off`, `critical`, `error`, `warn`, `info`, `debug`, `trace`

### Log Content Patterns

#### Before Copilot Responds

```log
2025-11-22 14:07:11.252 [info] ccreq:98114b41.copilotmd | markdown
```

#### While Responding (Multiple Updates)

```log
2025-11-22 14:09:54.250 [info] ccreq:fb2c4bdd.copilotmd | success | oswe-vscode-secondary -> capi-noe-ptuc-h200-oswe-vscode-secondary | 5176ms | [panel/editAgent]
2025-11-22 14:10:10.494 [info] ccreq:4381beba.copilotmd | success | oswe-vscode-secondary -> capi-noe-ptuc-h200-oswe-vscode-secondary | 3665ms | [panel/editAgent]
```

#### When Response Completes

```log
2025-11-22 14:11:09.099 [info] message 0 returned. finish reason: [stop]
2025-11-22 14:11:09.099 [info] request done: requestId: [447e3a06-81c7-4b06-9de2-2f5af2261ca0] model deployment ID: []
2025-11-22 14:11:09.101 [info] ccreq:e89f6ef5.copilotmd | success | gpt-4o-mini -> gpt-4o-mini-2024-07-18 | 364ms | [title]
```

### Completion Markers (Validated)

1. **Primary marker**: `finish reason: [stop]`
2. **Secondary marker**: `request done: requestId: [...]`
3. **Pattern**: Both appear together when response completes

### Pattern Statistics (From Investigation)

| Metric                          | Before Response | After Completion |
| ------------------------------- | --------------- | ---------------- |
| Total lines                     | 30              | 34               |
| Lines with `ccreq:`             | 8               | 10               |
| Lines with `success`            | 6               | 8                |
| **Lines with `finish reason:`** | **0**           | **1** ✅         |
| **Lines with `request done:`**  | **0**           | **1** ✅         |

## Proposed Architecture

### New Class: `CopilotChatLogMonitor`

```typescript
/**
 * Monitor GitHub Copilot Chat log files for completion detection
 * Replaces tool callbacks and clipboard polling with reliable file-based detection
 */
export class CopilotChatLogMonitor {
  private logFilePath?: string;
  private fileWatcher?: fs.FSWatcher;
  private lastReadPosition: number = 0;
  private completionCallback?: () => void;

  /**
   * Find the active Copilot Chat log file
   * Recursively searches logs directory and returns most recently modified log
   */
  private async findActiveLogFile(): Promise<string | undefined> {
    const logBaseDir = this.getLogBaseDirectory();
    const allLogs = await this.findFilesRecursive(
      logBaseDir,
      "GitHub Copilot Chat.log"
    );

    if (allLogs.length === 0) {
      return undefined;
    }

    // Sort by modification time (most recent first)
    allLogs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return allLogs[0].path;
  }

  /**
   * Get platform-specific log base directory
   */
  private getLogBaseDirectory(): string {
    const home = os.homedir();

    if (process.platform === "win32") {
      return path.join(home, "AppData", "Roaming", "Code", "logs");
    } else if (process.platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Code", "logs");
    } else {
      return path.join(home, ".config", "Code", "logs");
    }
  }

  /**
   * Recursively find all files matching filename
   */
  private async findFilesRecursive(
    dir: string,
    filename: string
  ): Promise<Array<{ path: string; mtime: Date; size: number }>> {
    // Implementation from chat-log-investigation.ts
  }

  /**
   * Start monitoring log file for completion
   * Returns a promise that resolves when completion marker is detected
   */
  async waitForCompletion(timeoutMs: number = 300000): Promise<boolean> {
    // Find active log file
    this.logFilePath = await this.findActiveLogFile();
    if (!this.logFilePath) {
      throw new Error("Could not find active Copilot Chat log file");
    }

    console.log(`📊 Monitoring log file: ${this.logFilePath}`);

    // Reset read position to current file size (ignore old content)
    const stats = await fs.stat(this.logFilePath);
    this.lastReadPosition = stats.size;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.cleanup();
        resolve(false); // Timeout - completion not detected
      }, timeoutMs);

      // Watch for file changes
      this.fileWatcher = fs.watch(this.logFilePath!, async (eventType) => {
        if (eventType === "change") {
          const completed = await this.checkForCompletion();
          if (completed) {
            clearTimeout(timeoutHandle);
            this.cleanup();
            resolve(true);
          }
        }
      });
    });
  }

  /**
   * Check if completion markers appear in new log content
   */
  private async checkForCompletion(): Promise<boolean> {
    if (!this.logFilePath) return false;

    try {
      const stats = await fs.stat(this.logFilePath);
      const currentSize = stats.size;

      // Only read new content since last check
      if (currentSize <= this.lastReadPosition) {
        return false; // No new content
      }

      const stream = fs.createReadStream(this.logFilePath, {
        start: this.lastReadPosition,
        end: currentSize - 1,
        encoding: "utf-8",
      });

      let newContent = "";
      for await (const chunk of stream) {
        newContent += chunk;
      }

      this.lastReadPosition = currentSize;

      // Check for completion markers
      const hasFinishReason = newContent.includes("finish reason: [stop]");
      const hasRequestDone = newContent.includes("request done:");

      if (hasFinishReason && hasRequestDone) {
        console.log("✅ Completion markers detected in log");
        return true;
      }

      return false;
    } catch (error) {
      console.error("❌ Error checking log file:", error);
      return false;
    }
  }

  /**
   * Cleanup watchers and resources
   */
  private cleanup(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = undefined;
    }
  }

  /**
   * Stop monitoring
   */
  dispose(): void {
    this.cleanup();
  }
}
```

### Integration with CopilotChatIntegration

```typescript
export class CopilotChatIntegration extends CopilotIntegration {
  private logMonitor: CopilotChatLogMonitor;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.logMonitor = new CopilotChatLogMonitor();
    this.initialize();
  }

  async sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection?: boolean,
    workflowContext?: WorkflowContext
  ): Promise<boolean> {
    try {
      // Build prompt WITHOUT tool instructions (no context pollution!)
      const chatPrompt = await this.buildCopilotChatPrompt(
        prompt,
        false, // NO tool instruction needed
        workflowContext
      );

      // Send prompt with direct automation (existing proven method)
      const sent = await this.sendPromptWithDirectAutomation(
        chatPrompt,
        false // No tool detection needed
      );

      if (!sent) {
        throw new Error("Failed to send prompt to Copilot Chat");
      }

      // Wait for completion using log monitoring
      console.log("📊 Waiting for completion via log monitoring...");
      const completed = await this.logMonitor.waitForCompletion(300000); // 5 min timeout

      if (!completed) {
        console.warn("⚠️ Timeout waiting for completion marker in log");
        return false;
      }

      console.log("✅ Copilot response completed (detected via log)");
      return true;
    } catch (error) {
      console.error("❌ Error in sendPrompt:", error);
      return false;
    }
  }
}
```

## Implementation Plan

### Phase 1: Create CopilotChatLogMonitor Class

- [ ] Create `src/flightpath/chat/CopilotChatLogMonitor.ts`
- [ ] Implement `findActiveLogFile()` with recursive search
- [ ] Implement `waitForCompletion()` with file watching
- [ ] Implement `checkForCompletion()` with incremental reads
- [ ] Add comprehensive error handling

### Phase 2: Integrate with CopilotChatIntegration

- [ ] Add `CopilotChatLogMonitor` instance to `CopilotChatIntegration`
- [ ] Remove tool registration code (`registerResponseTool()`)
- [ ] Remove tool callback logic
- [ ] Remove clipboard polling fallback (`waitForCompletionWithFallback()`)
- [ ] Update `sendPrompt()` to use log monitoring
- [ ] Remove tool instruction from `buildCopilotChatPrompt()`

### Phase 3: Cleanup & Simplification

- [ ] Delete `TOOL_INSTRUCTION` constant
- [ ] Remove `isToolRegistered` flag
- [ ] Remove `toolCalledForCurrentPrompt` flag
- [ ] Remove `registerResponseTool()` method
- [ ] Remove `waitForCopilotToFinishStreaming()` method
- [ ] Remove `waitForCompletionWithFallback()` method
- [ ] Simplify `sendPromptWithDirectAutomation()` (no tool flags needed)

### Phase 4: Testing

- [ ] Test single prompt execution
- [ ] Test multi-prompt workflows
- [ ] Test timeout scenarios
- [ ] Test cancellation during monitoring
- [ ] Test with different chat window locations
- [ ] Cross-platform testing (Windows/macOS/Linux)

### Phase 5: Documentation

- [ ] Update `.github/copilot-instructions.md`
- [ ] Update `.github/instructions/flightpath-chat.instructions.md`
- [ ] Document log monitoring approach
- [ ] Add troubleshooting guide for log access issues

## Benefits Summary

### Code Simplification

- Remove ~150 lines of tool callback code
- Remove ~100 lines of clipboard polling code
- Remove ~50 lines of tool instruction logic
- **Total: ~300 lines removed** ✨

### Reliability Improvements

- ✅ No dependence on LLM calling tools correctly
- ✅ No clipboard race conditions
- ✅ No UI focus requirements
- ✅ Deterministic file-based detection
- ✅ Works consistently across all platforms

### User Experience

- ✅ Cleaner prompts (no tool instructions)
- ✅ Faster completion detection (no 2-minute stability wait)
- ✅ More accurate (direct from Copilot's own logs)
- ✅ Consistent with CLI mode architecture

## Potential Enhancements

### Log Verbosity Control

Currently, Copilot Chat logs don't include full response text or token counts. Possible approaches:

1. **Search for hidden verbosity settings**
   - Check Copilot extension settings for debug/verbose modes
   - Look for VS Code developer settings to increase log detail

2. **Export command investigation**
   - `github.copilot.chat.debug.exportPromptLogsAsJson` may accept parameters
   - Could provide full conversation export with responses

3. **Alternative: Response extraction from chat UI**
   - As fallback, still use clipboard copy after completion detected
   - But only AFTER log confirms completion (not for detection)

### File Watching Optimization

- Use `chokidar` library (already a dependency) for robust cross-platform file watching
- Implement debouncing to avoid excessive file reads
- Add retry logic for temporary file access issues

### Performance Monitoring

- Track average time-to-completion detection
- Log false positives/negatives during beta testing
- Compare performance vs. current clipboard polling approach

## Migration Strategy

1. **Implement new log monitor in parallel** - Don't remove existing code yet
2. **Add feature flag** - `flightpath.useLogBasedCompletion` (default: `false`)
3. **Beta testing period** - Test with real workflows, gather metrics
4. **Flip default** - Once proven reliable, set flag to `true`
5. **Deprecation notice** - Warn about removing old approach in next version
6. **Full migration** - Remove tool callback and clipboard polling code

## Risk Mitigation

### What if log file is not accessible?

- Fallback to current clipboard polling approach
- Show warning to user about potential reliability issues
- Document required file system permissions

### What if log format changes?

- Monitor for new Copilot Chat extension versions
- Add pattern version detection
- Graceful degradation to fallback detection method

### What if multiple VS Code windows are open?

- Already handled by "most recent modification time" logic
- The window where chat is actively used will have newest log
- Edge case: User switches windows mid-workflow → Would need to re-detect active log

## Success Criteria

- ✅ Detects completion within 1 second of actual response end
- ✅ Zero false positives in 100 consecutive prompts
- ✅ Zero missed completions in 100 consecutive prompts
- ✅ Works on Windows, macOS, and Linux
- ✅ Handles cancellation gracefully
- ✅ Recovers from temporary file access errors
- ✅ No user-visible regressions vs. current approach

## Open Questions

1. **Does log file format vary between Copilot Chat versions?**
   - Need to test with different extension versions
   - May need version detection logic

2. **Are there rate limits on file watching?**
   - Test with rapid successive prompts
   - Ensure file system doesn't throttle

3. **What happens during Copilot extension updates?**
   - Log directory might change
   - Need to handle log file not found gracefully

4. **Can we increase log verbosity programmatically?**
   - Investigate Copilot extension settings
   - Check for undocumented debug flags

## References

- Investigation results: `src/test/chat-log-investigation.ts`
- CLI session tracking: `src/flightpath/cli/CopilotCommandLineIntegration.ts` (lines 529-575)
- Current chat integration: `src/flightpath/chat/CopilotChatIntegration.ts`
- Log file examples: `docs/CHAT_LOG_BASED_COMPLETION.md` (this file)
