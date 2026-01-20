# Adding a New CLI Provider to FlightPath

**Last Updated**: January 15, 2026  
**Architecture**: Composition-Based (Zero Core Modifications)

## Overview

FlightPath uses a **composition-based architecture** that makes adding new CLI providers (Gemini, OpenCode, DeepSeek, etc.) simple and safe:

- **Zero core class modifications** - CliIntegration never changes
- **Provider isolation** - All logic in one directory
- **Interface-driven** - TypeScript guides implementation
- **Testable components** - No mocking needed

This guide provides **complete code templates** and a **step-by-step checklist** for adding a new provider.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Architecture Overview](#architecture-overview)
3. [Step-by-Step Guide](#step-by-step-guide)
4. [Code Templates](#code-templates)
5. [Testing Checklist](#testing-checklist)
6. [Troubleshooting](#troubleshooting)
7. [Example: Gemini CLI Integration](#example-gemini-cli-integration)

---

## Prerequisites

Before starting, ensure you have:

1. **CLI Tool Installed**: The CLI you're integrating (e.g., `gemini` command available)
2. **CLI Documentation**: Understanding of CLI arguments, output format, completion detection
3. **Development Environment**: FlightPath extension running in debug mode (F5)
4. **Basic Knowledge**: TypeScript, VS Code Extension API, async/await patterns

---

## Architecture Overview

### Why Composition Over Inheritance?

**Before (Inheritance)**: Adding a provider meant:

- Extending BaseCliIntegration class
- Implementing 15+ abstract methods
- Modifying 3-4 shared utility classes
- High risk of breaking existing providers

**After (Composition)**: Adding a provider means:

- Creating 4 focused classes in a new directory
- Implementing 4 clear interfaces
- ZERO modifications to core classes
- Complete isolation from existing providers

### The 5 Required Components

Every CLI provider consists of exactly **5 files** implementing **4 interfaces** + **1 log parser**:

| File                              | Interface/Type          | Purpose                                              |
| --------------------------------- | ----------------------- | ---------------------------------------------------- |
| `ProviderCliProvider.ts`          | `ICliProvider`          | Main provider descriptor - aggregates all components |
| `ProviderResponseParser.ts`       | `IResponseParser`       | Parses CLI output, extracts tokens/session IDs       |
| `ProviderNotificationMonitor.ts`  | `INotificationMonitor`  | Monitors for completion events (hooks/polling)       |
| `ProviderToolPermissionMapper.ts` | `IToolPermissionMapper` | Converts permissions to CLI arguments                |
| `ProviderLogParser.ts`            | `ILogParser`            | Parses log files for session IDs and completion      |

### Directory Structure

```
src/flightpath/cli/
├── CliIntegration.ts                  # Generic integration (NEVER modified)
├── shared/
│   ├── interfaces/                    # Interfaces (rarely change)
│   │   ├── ICliProvider.ts
│   │   ├── IResponseParser.ts
│   │   ├── INotificationMonitor.ts
│   │   └── IToolPermissionMapper.ts
│   ├── CliProcessManager.ts           # Truly shared utilities
│   ├── TuiStreamProcessor.ts
│   └── ...
├── copilot/                           # Example: Copilot provider
│   ├── CopilotCliProvider.ts
│   ├── CopilotResponseParser.ts
│   ├── CopilotNotificationMonitor.ts
│   ├── CopilotToolPermissionMapper.ts
│   └── CopilotLogParser.ts
├── claude/                            # Example: Claude provider
│   └── ...
└── gemini/                            # NEW: Your provider here
    ├── GeminiCliProvider.ts
    ├── GeminiResponseParser.ts
    ├── GeminiNotificationMonitor.ts
    ├── GeminiToolPermissionMapper.ts
    └── GeminiLogParser.ts
```

---

## Step-by-Step Guide

### Phase 1: Research the CLI

**Goal**: Understand the CLI's capabilities and limitations.

**Checklist**:

- [ ] Install CLI and verify it works: `gemini --version`
- [ ] Test basic prompt: `gemini "Hello, world"`
- [ ] Identify output format (plain text, JSON, JSONL)
- [ ] Document completion indicators (exit code, JSON event, log file event)
- [ ] Check for hooks/notifications (like Copilot's sessionEnd or Codex's notify)
- [ ] **Identify log file format and location** (JSONL, JSON, plain text)
- [ ] **Document log file structure** (session events, completion events, errors)
- [ ] **Test log file monitoring** (can completion be detected from logs?)
- [ ] Test session resumption: `gemini --resume <id>` (or equivalent)
- [ ] Document tool permission flags: `--allow-tools`, `--deny-tools`, etc.
- [ ] Test file references: `@file`, `-f file`, or other syntax
- [ ] Check token counting: Where are token counts reported?

**Example Research Notes**:

```
Gemini CLI v1.0.0
- Command: gemini
- Basic prompt: gemini "your question"
- Output: Plain text to stdout, stats to stderr
- Completion: Exit code 0 indicates success
- Hooks: No native hooks, use log file monitoring
- Log files: ~/.gemini/sessions/<session-id>.jsonl (JSONL format)
- Log events: {"type":"session.started"}, {"type":"turn.completed"}
- Session: --continue-session <id>
- Permissions: --allow-all-tools, --deny-tool <name>
- File reference: @path/to/file
- Tokens: Printed at end: "Tokens: 100 in, 50 out"
```

---

### Phase 2: Create Provider Directory

**Goal**: Set up the file structure.

```bash
cd src/flightpath/cli
mkdir gemini
cd gemini
```

**Create 4 empty files**:

```bash
touch GeminiCliProvider.ts
touch GeminiResponseParser.ts
touch GeminiNotificationMonitor.ts
touch GeminiToolPermissionMapper.ts
```

---

### Phase 2.5: Create Log Parser

**Goal**: Implement log file parsing for session discovery and completion detection.

```bash
touch GeminiLogParser.ts
```

**Template**: Extend `BaseLogParser` from `src/flightpath/cli/shared/BaseLogParser.ts`

**Implementation checklist**:

- [ ] Implement `getLogDirectory()` - Return CLI's log directory path
- [ ] Implement `getLogFilePattern()` - Return regex pattern for log files (e.g., `session-*.jsonl`)
- [ ] Implement `parseLogLine()` - Parse single JSONL line into structured event
- [ ] Implement `isCompletionEvent()` - Check if event indicates completion
- [ ] Implement `extractSessionId()` - Extract session ID from log events
- [ ] Implement `findSessionByPrompt()` - Match session by prompt text (for session discovery)
- [ ] Test with actual CLI log files

**Example Log Parser**:

```typescript
import path from "path";
import os from "os";
import { BaseLogParser } from "../shared/BaseLogParser";

export class GeminiLogParser extends BaseLogParser {
  getLogDirectory(): string {
    // Example: ~/.gemini/sessions/
    return path.join(os.homedir(), ".gemini", "sessions");
  }

  getLogFilePattern(): RegExp {
    // Example: Match session-abc123.jsonl
    return /^session-[a-f0-9-]+\.jsonl$/;
  }

  parseLogLine(line: string): any | null {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  isCompletionEvent(event: any): boolean {
    // Example: Check for completion event type
    return event?.type === "turn.completed" || event?.type === "session.ended";
  }

  extractSessionId(event: any): string | undefined {
    return event?.session_id || event?.sessionId;
  }
}
```

**Why log file monitoring?**

- More reliable than parsing terminal output
- Works consistently across providers
- Enables session discovery by matching prompt content
- No need for complex TUI escape sequence parsing

---

### Phase 3: Implement IResponseParser

**Goal**: Parse CLI output into structured result.

**Why start here?** Response parsing is the simplest component and has no dependencies.

**Template**: See [Code Templates - GeminiResponseParser.ts](#geminiresponseparsertstemplatemd)

**Implementation checklist**:

- [ ] Implement `parse()` method (stdout/stderr → CopilotCliResult)
- [ ] Implement `parseTokenCounts()` method (extract prompt/completion tokens)
- [ ] Implement `extractSessionId()` method (if CLI provides session IDs)
- [ ] Implement `processStreamingChunk()` method (optional, for real-time streaming)
- [ ] Test with sample CLI output

**Example**:

```typescript
// Test your parser
const parser = new GeminiResponseParser();
const result = parser.parse("Response text\nTokens: 100 in, 50 out", "", 0);
console.log(result.text); // "Response text"
console.log(result.statistics); // "Usage: 100 input + 50 output = 150 tokens"
```

---

### Phase 4: Implement INotificationMonitor

**Goal**: Monitor for completion events.

**Template**: See [Code Templates - GeminiNotificationMonitor.ts](#gemininotificationmonitortemplatemd)

**Implementation checklist**:

- [ ] Implement `monitorForCompletion()` method (file polling or hook-based)
- [ ] Implement `buildHookConfig()` method (if CLI supports hooks)
- [ ] Implement `getNotificationDirectory()` method (where to watch for files)
- [ ] Implement `extractSessionId()` method (if notifications contain session ID)
- [ ] Test completion detection with actual CLI execution

**Approaches**:

1. **Hook-based** (like Codex): CLI calls script when done, writes JSON
2. **Log-based** (like Copilot/Claude): Poll log file for completion event (RECOMMENDED)
3. **Exit-based** (simple): Monitor process exit code only

---

### Phase 5: Implement IToolPermissionMapper

**Goal**: Convert FlightPath permissions to CLI-specific arguments.

**Template**: See [Code Templates - GeminiToolPermissionMapper.ts](#geminitoolpermissionmappertemplatemd)

**Implementation checklist**:

- [ ] Implement `buildArgs()` method (permission config → CLI arguments)
- [ ] Implement `hasFullPermissions()` method (check if all permissions granted)
- [ ] Handle 3 modes: `dangerouslyAllowAll`, `allowAll`, `custom`
- [ ] Convert FlightPath tool patterns to CLI-specific syntax
- [ ] Test with various permission configurations

**Permission Modes**:

- `dangerouslyAllowAll`: Bypass ALL restrictions (e.g., `--skip-permissions`)
- `allowAll`: Auto-grant all tools but respect deny list (e.g., `--allow-all-tools` + denies)
- `custom`: Use specific allow/deny patterns

---

### Phase 6: Implement ICliProvider

**Goal**: Aggregate all components and define provider configuration.

**Template**: See [Code Templates - GeminiCliProvider.ts](#geminicliprovidertemplatemd)

**Implementation checklist**:

- [ ] Define `config: ProviderConfig` (name, displayName, TUI patterns, etc.)
- [ ] Instantiate components (responseParser, notificationMonitor, toolPermissionMapper)
- [ ] Implement `buildHeadlessArgs()` method (file reference → CLI args)
- [ ] Implement `buildHeadlessArgsWithDirectPrompt()` method (direct prompt → CLI args)
- [ ] Implement `buildInteractiveTuiCommand()` method (TUI command string)
- [ ] Implement `formatFileReference()` method (format file paths for CLI)
- [ ] Implement `getMcpConfigArgs()` method (optional, if CLI supports MCP)
- [ ] Implement `checkAvailability()` method (check if CLI installed)
- [ ] Test provider instantiation

**Critical: TUI Patterns**

The `chromePatterns` array defines UI elements to filter from TUI output:

```typescript
chromePatterns: [
  /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/, // Box drawing (8+ chars = UI chrome)
  /^●\s+Thinking\.\.\./i, // Spinner/status (pure chrome)
  /Esc to cancel/i, // Cancel hint
  /^>\s*$/, // Empty prompt line
];
```

**Why filter chrome?** FlightPath only wants the AI's response text, not the CLI's UI decorations.

---

### Phase 7: Integrate with FlightPathManager

**Goal**: Add provider to factory pattern.

**File**: `src/flightpath/FlightPathManager.ts`

**Steps**:

1. **Import provider**:

```typescript
import { GeminiCliProvider } from "./cli/gemini/GeminiCliProvider";
```

2. **Add to factory switch**:

```typescript
private async initializeCopilotIntegration(): Promise<void> {
    const provider = vscode.workspace.getConfiguration("flightpath").get<string>("provider");

    switch (provider) {
        case "copilot-cli":
            this.copilotIntegration = new CliIntegration(new CopilotCliProvider(), this.context);
            break;
        case "claude-cli":
            this.copilotIntegration = new CliIntegration(new ClaudeCliProvider(), this.context);
            break;
        case "codex-cli":
            this.copilotIntegration = new CliIntegration(new CodexCliProvider(), this.context);
            break;
        case "gemini-cli":  // ADD THIS
            this.copilotIntegration = new CliIntegration(new GeminiCliProvider(), this.context);
            break;
        case "copilot-chat":
            this.copilotIntegration = new CopilotChatIntegration(this.context);
            break;
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}
```

**That's it!** No other code changes needed.

---

### Phase 8: Add Settings to package.json

**Goal**: Expose provider and model settings to users.

**File**: `package.json`

**Steps**:

1. **Add provider enum value**:

```json
{
  "flightpath.provider": {
    "type": "string",
    "enum": [
      "copilot-cli",
      "claude-cli",
      "codex-cli",
      "gemini-cli", // ADD THIS
      "copilot-chat"
    ],
    "enumDescriptions": [
      "GitHub Copilot CLI (default, best reliability)",
      "Claude Code CLI (Anthropic's Claude with stream-json output)",
      "Codex CLI (OpenAI's Codex with JSONL events)",
      "Gemini CLI (Google's Gemini AI)", // ADD THIS
      "Copilot Chat window (UI automation, fallback)"
    ],
    "default": "copilot-cli"
  }
}
```

2. **Add model setting** (if CLI supports multiple models):

```json
{
  "flightpath.geminiCliModel": {
    "type": "string",
    "enum": ["gemini-pro", "gemini-ultra", "gemini-flash"],
    "enumDescriptions": [
      "Balanced performance (recommended)",
      "Maximum capability (slowest)",
      "Fastest, good for simple tasks"
    ],
    "default": "gemini-pro",
    "description": "Gemini CLI model to use (only applies when provider is gemini-cli)"
  }
}
```

3. **Update ModelConstants.ts** (for model IntelliSense):

```typescript
// src/utils/ModelConstants.ts
export const GEMINI_CLI_MODELS = [
  { id: "gemini-pro", displayName: "Gemini Pro (Balanced)" },
  { id: "gemini-ultra", displayName: "Gemini Ultra (Most Capable)" },
  { id: "gemini-flash", displayName: "Gemini Flash (Fastest)" },
] as const;
```

4. **Run sync script**:

```bash
npm run sync-models
```

---

### Phase 9: Test Thoroughly

**Goal**: Ensure provider works in all scenarios.

**Checklist**: See [Testing Checklist](#testing-checklist) section below.

---

### Phase 10: Document

**Goal**: Help future developers and users.

**Files to create/update**:

1. **Provider-specific doc** (optional): `docs/GEMINI_CLI_INTEGRATION.md`
   - CLI-specific quirks
   - Completion detection approach
   - Known limitations

2. **Update main instructions**: `.github/instructions/flightpath-cli.instructions.md`
   - Add provider to `<providerSpecifics>` section

3. **Example workflow**: `manual-test/gemini-test.flightpath.yaml`
   ```yaml
   prompt: |
     Analyze this code for potential improvements.
     Focus on performance and readability.
   model: gemini-pro
   ```

---

## Code Templates

### GeminiCliProvider.ts (Template)

````typescript
import { exec } from "child_process";
import { promisify } from "util";
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { GeminiResponseParser } from "./GeminiResponseParser";
import { GeminiNotificationMonitor } from "./GeminiNotificationMonitor";
import { GeminiToolPermissionMapper } from "./GeminiToolPermissionMapper";

const execAsync = promisify(exec);

/**
 * Gemini CLI Provider
 *
 * Implements all Gemini-specific logic using composition pattern:
 * - Log file monitoring for completion detection
 * - Plain text output parsing (or JSON if Gemini uses structured output)
 * - Tool permission conversion
 * - File reference formatting
 * - Session discovery via log file analysis
 *
 * This provider aggregates specialized components:
 * - GeminiResponseParser: Parses output and extracts tokens
 * - GeminiNotificationMonitor: Monitors for completion events
 * - GeminiToolPermissionMapper: Converts permissions to CLI arguments
 * - GeminiLogParser: Parses log files for sessions and completion
 * - CliMcpConfigGenerator: Generates MCP configuration (if supported)
 *
 * Usage:
 * ```typescript
 * const provider = new GeminiCliProvider();
 * const integration = new CliIntegration(provider, context);
 * ```
 */
export class GeminiCliProvider implements ICliProvider {
  readonly config: ProviderConfig = {
    name: "gemini",
    displayName: "Google Gemini CLI",
    installHint: "Install via: npm install -g @google/gemini-cli",

    // Log file monitoring for completion detection
    useLogFileMonitoring: true,

    // Whether to stream headless output in real-time
    // Set to false if CLI uses JSON/JSONL (buffer until complete)
    shouldStreamHeadlessOutput: true,
  };

  // Component aggregation - each implements a specific interface
  readonly responseParser: IResponseParser = new GeminiResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new GeminiNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new GeminiToolPermissionMapper();
  readonly logParser: ILogParser = new GeminiLogParser();

  /**
   * Build CLI arguments for headless mode with file reference
   *
   * Adjust based on how Gemini CLI accepts file references.
   * Examples:
   * - Copilot: ["--prompt", "@file"]
   * - Claude: ["file"]
   * - Codex: ["-f", "file"]
   *
   * @param baseArgs Base arguments array (permissions, model, etc.)
   * @param promptFileRef File reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Example: Gemini uses --prompt flag with @ prefix
    return ["--prompt", `"${promptFileRef}"`, ...baseArgs];
  }

  /**
   * Build CLI arguments for headless mode with direct prompt
   *
   * Used for simple prompts (≤300 characters) to avoid temp file overhead.
   *
   * @param baseArgs Base arguments array
   * @param promptText Prompt text
   * @returns Complete arguments array
   */
  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    // Example: Gemini accepts direct prompt with --prompt flag
    return ["--prompt", `"${promptText}"`, ...baseArgs];
  }

  /**
   * Build CLI command for interactive TUI mode
   *
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string {
    return `${this.config.name} ${baseArgs.join(" ")}`;
  }

  /**
   * Format a file path reference for Gemini CLI
   *
   * Examples:
   * - Copilot: @path/to/file.ts
   * - Claude: path/to/file.ts (no @)
   * - Codex: -f path/to/file.ts
   *
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference
   */
  formatFileReference(relativeFilePath: string): string {
    // Example: Gemini uses @ prefix like Copilot
    return `@${relativeFilePath}`;
  }

  /**
   * Generate MCP server configuration arguments (optional)
   *
   * Only implement if Gemini CLI supports MCP integration.
   * Return null if not supported.
   *
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array with MCP config, or null if not supported
   */
  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    // Example: MCP not supported by Gemini CLI
    return null;

    // If supported, generate config file and return args:
    // const configPath = await generateMcpConfig(...);
    // return ["--mcp-config", configPath];
  }

  /**
   * Check if Gemini CLI is available on the system
   *
   * @returns True if CLI executable found
   */
  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("gemini --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get CLI version string (optional, for debugging/telemetry)
   *
   * @returns Version string if available
   */
  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("gemini --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
````

---

### GeminiResponseParser.ts (Template)

```typescript
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { CopilotCliResult } from "../../../types/FlightPathTypes";

/**
 * Gemini CLI Response Parser
 *
 * Parses Gemini CLI output into structured result with:
 * - Response text (stdout)
 * - Token counts (prompt + completion)
 * - Session ID (if available)
 * - Error handling
 *
 * Adjust parsing logic based on actual Gemini output format.
 */
export class GeminiResponseParser implements IResponseParser {
  /**
   * Parse CLI output into structured result
   *
   * @param stdout CLI stdout (main response text)
   * @param stderr CLI stderr (may contain statistics or errors)
   * @param exitCode Process exit code (0 = success)
   * @returns Parsed result with text, statistics, and optional session ID
   */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    // Handle errors
    if (exitCode !== 0) {
      return {
        text: stdout || stderr || "Gemini CLI failed with no output",
        statistics: "",
        error: `Gemini CLI exited with code ${exitCode}`,
      };
    }

    // Extract token counts from output
    const tokenCounts = this.parseTokenCounts(stdout + "\n" + stderr);

    // Format statistics string for dashboard display
    let statistics = "";
    if (tokenCounts) {
      const total = tokenCounts.prompt + tokenCounts.completion;
      statistics = `Usage: ${tokenCounts.prompt} input + ${tokenCounts.completion} output = ${total} tokens`;
    }

    // Clean response text (remove token count line if present)
    let responseText = stdout;
    const tokenLine = /Tokens:\s+\d+\s+in,\s+\d+\s+out/i;
    if (tokenLine.test(responseText)) {
      responseText = responseText.replace(tokenLine, "").trim();
    }

    // Extract session ID if CLI provides it
    const sessionId = this.extractSessionId(stdout + "\n" + stderr);

    return {
      text: responseText.trim(),
      statistics,
      ...(sessionId && { sessionId }),
    };
  }

  /**
   * Parse token counts from CLI output
   *
   * Adjust regex based on actual Gemini output format.
   * Examples:
   * - Copilot: "Tokens: 100 in, 50 out" (stderr)
   * - Claude: JSON with usage.input_tokens and usage.output_tokens
   * - Codex: JSONL with token fields
   *
   * @param output Full CLI output (stdout + stderr)
   * @returns Token counts or undefined if not found
   */
  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined {
    // Example: Gemini prints "Tokens: 100 in, 50 out"
    const match = output.match(/Tokens:\s+(\d+)\s+in,\s+(\d+)\s+out/i);
    if (match) {
      return {
        prompt: parseInt(match[1], 10),
        completion: parseInt(match[2], 10),
      };
    }

    // Alternative format: JSON statistics
    // const jsonMatch = output.match(/"tokens":\s*\{\s*"input":\s*(\d+),\s*"output":\s*(\d+)/);
    // if (jsonMatch) { ... }

    return undefined;
  }

  /**
   * Extract session ID from CLI output (optional)
   *
   * Only implement if Gemini CLI provides session IDs for multi-turn conversations.
   *
   * @param output Full CLI output
   * @returns Session ID if found
   */
  extractSessionId(output: string): string | undefined {
    // Example: Gemini prints "Session: abc-123-def"
    const match = output.match(/Session:\s+([a-zA-Z0-9-]+)/i);
    if (match) {
      return match[1];
    }

    // Alternative: JSON with session_id field
    // const jsonMatch = output.match(/"session_id":\s*"([^"]+)"/);
    // if (jsonMatch) { return jsonMatch[1]; }

    return undefined;
  }

  /**
   * Process streaming chunk for real-time display (optional)
   *
   * Only implement if Gemini CLI outputs structured streaming data (JSON/JSONL).
   * For plain text streaming, return chunk as-is.
   *
   * @param chunk Raw stdout chunk
   * @param streamState Accumulated state (persists across chunks)
   * @returns Processed content to emit, or undefined to skip
   */
  processStreamingChunk(
    chunk: string,
    streamState: Map<string, any>
  ): string | undefined {
    // Example: Plain text streaming - return as-is
    return chunk;

    // Example: JSON streaming - extract delta content
    // try {
    //   const json = JSON.parse(chunk);
    //   if (json.type === "content_delta") {
    //     return json.delta.text;
    //   }
    // } catch { }
    // return undefined;
  }
}
```

---

### GeminiNotificationMonitor.ts (Template)

```typescript
import * as vscode from "vscode";
import { promises as fs } from "fs";
import { join } from "path";
import {
  INotificationMonitor,
  NotificationConfig,
  NotificationResult,
  HookConfig,
} from "../shared/interfaces/INotificationMonitor";

/**
 * Gemini CLI Notification Monitor
 *
 * Monitors for completion events via:
 * - Hook-based: CLI calls script when done, writes JSON notification
 * - Log-based: Poll log file for completion event
 * - Fallback: Return immediately and rely on TUI escape indicator
 *
 * Adjust approach based on Gemini CLI capabilities.
 */
export class GeminiNotificationMonitor implements INotificationMonitor {
  /**
   * Monitor for completion notification
   *
   * Implementation depends on CLI completion detection mechanism:
   * - Hook-based: Poll notification directory for new files
   * - Log-based: Poll log file for specific pattern
   * - Fallback: Return immediately (TuiStreamProcessor handles completion)
   *
   * @param config Monitoring configuration (directory, timeout)
   * @param sessionId Optional session ID (undefined = wildcard mode)
   * @param startTime Execution start time (for timeout calculation)
   * @param onCancel Cancellation callback (returns true if canceled)
   * @returns Monitoring result (completed, error, data)
   */
  async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    const { directory, pollMs = 100, timeoutMs } = config;
    const endTime = new Date(startTime.getTime() + timeoutMs);

    // Approach 1: Hook-based monitoring (if Gemini supports hooks)
    // Poll directory for notification files
    const initialFiles = await this.listDirectory(directory);

    while (new Date() < endTime) {
      // Check for cancellation
      if (onCancel?.()) {
        return { completed: false, error: "Canceled by user" };
      }

      // Check for new notification file
      const currentFiles = await this.listDirectory(directory);
      const newFiles = currentFiles.filter((f) => !initialFiles.has(f));

      for (const file of newFiles) {
        if (file.endsWith(".json")) {
          try {
            const data = await this.readNotificationFile(join(directory, file));
            if (data) {
              // Verify this notification is for our session (if session ID available)
              if (!sessionId || this.matchesSession(data, sessionId)) {
                return { completed: true, data };
              }
            }
          } catch (error) {
            // Ignore parse errors, continue polling
          }
        }
      }

      // Wait before next poll
      await this.delay(pollMs);
    }

    // Timeout
    return { completed: false, error: "Notification timeout" };

    // Approach 2: No monitoring needed (rely on TUI escape indicator)
    // return { completed: true };
  }

  /**
   * Build hook/notification configuration
   *
   * Only implement if Gemini CLI supports hooks.
   * Return { type: "none" } if no hook support.
   *
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory
   * @returns Hook configuration (format varies by CLI)
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // Example 1: No hook support
    return { type: "none" };

    // Example 2: JSON hook config (like Copilot)
    // return {
    //   type: "json",
    //   config: {
    //     on_complete: {
    //       command: "node",
    //       args: [scriptPath, notifyDir]
    //     }
    //   }
    // };

    // Example 3: JSON string (like Claude)
    // return {
    //   type: "json-string",
    //   config: JSON.stringify({
    //     command: ["node", scriptPath, notifyDir]
    //   })
    // };

    // Example 4: TOML inline (like Codex)
    // return {
    //   type: "toml-inline",
    //   config: `notify='["node","${scriptPath}","${notifyDir}"]'`
    // };
  }

  /**
   * Get notification directory for this CLI
   *
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return join(workspaceRoot, ".flightpath", "temp", "gemini-notifications");
  }

  /**
   * Extract session ID from notification data (optional)
   *
   * Only implement if notifications contain session IDs.
   *
   * @param data Notification file content (parsed JSON)
   * @returns Session ID if found
   */
  extractSessionId(data: any): string | undefined {
    // Example: Notification has session_id field
    return data?.session_id || data?.sessionId;
  }

  // ===== Helper Methods =====

  /**
   * Check if notification matches session ID
   */
  private matchesSession(data: any, sessionId: string): boolean {
    const notificationSessionId = this.extractSessionId(data);
    return !notificationSessionId || notificationSessionId === sessionId;
  }

  /**
   * List files in directory (returns Set for easy comparison)
   */
  private async listDirectory(directory: string): Promise<Set<string>> {
    try {
      const files = await fs.readdir(directory);
      return new Set(files);
    } catch {
      return new Set();
    }
  }

  /**
   * Read and parse JSON notification file
   */
  private async readNotificationFile(filePath: string): Promise<any | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Simple delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

---

### GeminiToolPermissionMapper.ts (Template)

```typescript
import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";

/**
 * Gemini CLI Tool Permission Mapper
 *
 * Converts FlightPath permission configuration to Gemini CLI arguments.
 *
 * Handles 3 modes:
 * - dangerouslyAllowAll: Bypass ALL restrictions (e.g., --skip-all-permissions)
 * - allowAll: Auto-grant all tools but respect deny list (e.g., --allow-all-tools + denies)
 * - custom: Use specific allow/deny patterns
 *
 * Adjust CLI flags based on actual Gemini CLI syntax.
 */
export class GeminiToolPermissionMapper implements IToolPermissionMapper {
  /**
   * Build CLI arguments for tool permissions
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    const { mode, allowedTools, deniedTools } = config;
    const args: string[] = [];

    switch (mode) {
      case "dangerouslyAllowAll":
        // Bypass ALL restrictions - no prompts, no denies
        // Example: --skip-all-permissions
        args.push("--skip-all-permissions");
        break;

      case "allowAll":
        // Auto-grant all tools but respect deny list
        // Example: --allow-all-tools + individual denies
        args.push("--allow-all-tools");

        // Add deny flags for each denied tool
        for (const tool of deniedTools) {
          args.push("--deny-tool", tool);
        }
        break;

      case "custom":
        // Use specific allow/deny patterns
        // Example: --allow-tool <pattern> --deny-tool <pattern>

        // Add allow flags
        for (const tool of allowedTools) {
          args.push("--allow-tool", tool);
        }

        // Add deny flags (denies take precedence)
        for (const tool of deniedTools) {
          args.push("--deny-tool", tool);
        }
        break;
    }

    return args;
  }

  /**
   * Check if full permissions are granted (no prompts will occur)
   *
   * Used to determine if headless mode is safe (won't block on prompts).
   *
   * @param config Tool permission configuration
   * @returns True if all permissions auto-granted
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean {
    // dangerouslyAllowAll always grants full permissions
    if (config.mode === "dangerouslyAllowAll") {
      return true;
    }

    // allowAll grants full permissions (denies don't cause prompts)
    if (config.mode === "allowAll") {
      return true;
    }

    // custom mode: only full permissions if allowed tools is non-empty
    // (empty allow list = no permissions granted = prompts will occur)
    return config.allowedTools.length > 0;
  }
}
```

---

## Testing Checklist

### 1. Basic Functionality

- [ ] **Installation Check**:
  - Run `gemini --version` in terminal - verify CLI installed
  - FlightPath detects CLI via `provider.checkAvailability()`
  - Status bar shows "Ready" not "Setup Required"

- [ ] **Simple Prompt** (interactive mode):
  - Create test file: `manual-test/gemini-simple.flightpath.yaml`

  ```yaml
  prompt: "What is 2+2?"
  model: gemini-pro
  ```

  - Run with FlightPath
  - Fresh terminal opens with Gemini TUI
  - Response appears correctly
  - Token counts displayed in dashboard
  - Status returns to "Ready"

- [ ] **Complex Prompt** (file reference):
  - Create prompt with >300 characters
  - Verify FlightPath creates temp file
  - Verify file reference formatted correctly (e.g., `@.flightpath/temp/prompt-123.md`)
  - Response includes context from prompt file

---

### 2. Execution Modes

- [ ] **Interactive Mode**:
  - Setting: `flightpath.cliExecutionMode = "interactive"`
  - Fresh terminal opens for each prompt
  - TUI displays correctly (spinner, status visible)
  - Chrome filtering works (no UI decorations in response)
  - Completion detected reliably
  - Ctrl+C cancellation works

- [ ] **Headless Mode**:
  - Setting: `flightpath.cliExecutionMode = "headless"`
  - No terminal window opens
  - Output appears in FlightPath Output panel (if showCliOutput = true)
  - Completion detected via process exit
  - Response extracted correctly
  - Cancellation works (process killed)

---

### 3. Session Continuity

- [ ] **Multi-Turn Conversation**:
  - Create workflow with 2 prompts:

  ```yaml
  prompts:
    - id: first
      prompt: "My favorite color is blue."
    - id: second
      prompt: "What is my favorite color?"
      newChatSession: false # Continue session
  ```

  - Run workflow
  - First prompt creates session
  - Second prompt resumes session (verify `--continue-session <id>` flag)
  - Second response references first prompt ("Your favorite color is blue")

- [ ] **Session Reset**:
  - Set `newChatSession: true` on second prompt
  - Second response does NOT reference first prompt (fresh session)

---

### 4. Tool Permissions

- [ ] **dangerouslyAllowAll Mode**:
  - Setting: `flightpath.cliToolPermissions = "dangerouslyAllowAll"`
  - Run prompt that requires tools (e.g., "List files in current directory")
  - Verify CLI flag: `--skip-all-permissions`
  - No permission prompts appear
  - Tool executes successfully

- [ ] **allowAll Mode**:
  - Setting: `flightpath.cliToolPermissions = "allowAll"`
  - Add denied tool: `flightpath.cliDeniedTools = ["shell(rm:*)"]`
  - Verify CLI flags: `--allow-all-tools --deny-tool shell(rm:*)`
  - Most tools work, denied tool blocked

- [ ] **custom Mode**:
  - Setting: `flightpath.cliToolPermissions = "custom"`
  - Add allowed: `flightpath.cliAllowedTools = ["shell(git:*)", "write"]`
  - Add denied: `flightpath.cliDeniedTools = ["shell(rm:*)"]`
  - Verify CLI flags include allow/deny patterns
  - Only allowed tools execute

---

### 5. Response Parsing

- [ ] **Token Counting**:
  - Run any prompt
  - Verify token counts appear in dashboard
  - Check format: "Usage: X input + Y output = Z tokens"
  - Verify numbers match CLI output

- [ ] **Error Handling**:
  - Run invalid prompt (e.g., trigger CLI error)
  - Verify error message displayed in dashboard
  - Verify exit code != 0 handled gracefully
  - Status returns to "Ready" (not stuck in "Running")

- [ ] **Session ID Extraction**:
  - Run prompt and check session ID extracted
  - Verify stored in CliIntegration.sessionId
  - Verify used in subsequent prompts (if newChatSession = false)

---

### 6. Completion Detection

- [ ] **Interactive TUI**:
  - Monitor completion detection approach (hook/log/escape indicator)
  - Verify completion detected within reasonable time (<10s for simple prompt)
  - Verify no false positives (doesn't complete while CLI still working)

- [ ] **Headless**:
  - Verify process exit triggers completion
  - Verify exit code 0 = success, non-zero = error

- [ ] **Cancellation**:
  - Start long-running prompt
  - Click Stop button
  - Verify process killed immediately
  - Verify status returns to "Ready"
  - Verify no zombie processes (`ps aux | grep gemini`)

---

### 7. Edge Cases

- [ ] **Empty Response**:
  - Run prompt that returns empty response
  - Verify doesn't crash
  - Verify dashboard shows "(No response)" or similar

- [ ] **Very Long Response**:
  - Run prompt that generates 10,000+ tokens
  - Verify entire response captured
  - Verify streaming works (if enabled)

- [ ] **Special Characters**:
  - Run prompt with quotes, newlines, emojis, unicode
  - Verify special chars preserved in response

- [ ] **File References**:
  - Run prompt with `@workspace`, `#file:path:10-20`
  - Verify file content attached correctly
  - Verify line selection extracted

---

### 8. Settings & Configuration

- [ ] **Model Selection**:
  - Change `flightpath.geminiCliModel` to each supported model
  - Verify CLI receives correct `--model` flag
  - Verify response quality varies by model

- [ ] **Provider Switching**:
  - Switch to copilot-cli, run test
  - Switch to gemini-cli, run same test
  - Verify no conflicts or state leakage

- [ ] **Output Panel**:
  - Setting: `flightpath.showCliOutput = true`
  - Verify prompt, response, and stats appear in Output panel
  - Setting: `flightpath.showCliOutput = false`
  - Verify Output panel silent

---

### 9. Error Recovery

- [ ] **CLI Not Installed**:
  - Uninstall Gemini CLI temporarily
  - Open FlightPath
  - Verify status bar shows "Setup Required"
  - Verify error message includes install hint
  - Reinstall CLI, reload window
  - Verify status returns to "Ready"

- [ ] **CLI Crashes**:
  - Simulate CLI crash (kill process mid-execution)
  - Verify FlightPath handles gracefully
  - Verify error message shown
  - Verify can retry

- [ ] **Invalid Arguments**:
  - Manually edit provider to use invalid CLI flag
  - Run prompt
  - Verify error message includes stderr output

---

### 10. Integration Tests

- [ ] **Multi-Step Workflow**:
  - Create workflow with 5+ prompts, mixed modes
  - Verify all prompts execute sequentially
  - Verify session continuity across prompts
  - Verify end conditions work (if using)

- [ ] **Dynamic Queue Extension**:
  - Enable: `flightpath.enableDynamicQueue = true`
  - Run workflow that modifies its own .flightpath.yaml file
  - Verify new prompts appended to queue
  - Verify workflow extends itself dynamically

- [ ] **Dashboard Integration**:
  - Run workflow and watch dashboard
  - Verify progress updates (step 1/5, 2/5, etc.)
  - Verify token counts accumulate
  - Verify status changes (Running → Paused → Running → Completed)

---

## Troubleshooting

### Problem: "Setup Required" status

**Cause**: CLI not found in PATH

**Solutions**:

1. Install CLI: `npm install -g @google/gemini-cli`
2. Verify installation: `gemini --version`
3. Restart VS Code
4. Check PATH includes npm global bin directory

---

### Problem: Completion never detected (timeout)

**Cause**: Completion detection mechanism failing

**Solutions**:

1. Check `escapeIndicator` matches actual CLI output
2. Review TUI output in terminal - look for completion indicator
3. Implement hook-based monitoring (more reliable than TUI parsing)
4. Check notification files created in `.flightpath/temp/gemini-notifications/`
5. Increase timeout: `flightpath.chatInactivityTimeout = 600` (10 minutes)

---

### Problem: Response text includes UI chrome

**Cause**: `chromePatterns` not filtering correctly

**Solutions**:

1. Capture actual TUI output to file
2. Identify UI patterns (box drawing, spinners, status lines)
3. Add patterns to `config.chromePatterns` array
4. Test: Response should contain ONLY AI's text, no CLI UI elements

**Debugging**:

```typescript
// Temporarily disable chrome filtering to see raw output
chromePatterns: [],
```

---

### Problem: Tool permissions not working

**Cause**: CLI flags incorrect or tool patterns wrong

**Solutions**:

1. Check CLI documentation for permission flags
2. Test manually: `gemini --allow-tool shell "List files"`
3. Verify `buildArgs()` returns correct flags
4. Check logs: FlightPath Output panel shows CLI command
5. Compare with working provider (Copilot/Claude)

---

### Problem: Session resumption not working

**Cause**: Session ID not extracted or resume flag incorrect

**Solutions**:

1. Check `extractSessionId()` logic matches CLI output
2. Verify session ID logged to console
3. Check resume flag syntax: `--resume <id>` vs `-r <id>`
4. Test manually: Run two prompts with `--resume` flag

---

### Problem: Token counts not appearing

**Cause**: `parseTokenCounts()` regex doesn't match CLI output

**Solutions**:

1. Capture actual CLI output
2. Identify token count format (e.g., "Tokens: 100 in, 50 out")
3. Update regex in `parseTokenCounts()`
4. Test with sample output

**Debugging**:

```typescript
console.log("Raw output:", stdout, stderr);
const tokens = this.parseTokenCounts(stdout + "\n" + stderr);
console.log("Parsed tokens:", tokens);
```

---

## Example: Gemini CLI Integration

This example shows a complete integration for a hypothetical "Gemini CLI" with these characteristics:

- Command: `gemini`
- TUI with "Thinking..." indicator
- Plain text output with "Tokens: X in, Y out" footer
- Session resumption via `--continue-session <id>`
- Tool permissions via `--allow-tool` and `--deny-tool`
- File references via `@path/to/file`
- No native hooks (use log monitoring)

### Directory Structure

```
src/flightpath/cli/gemini/
├── GeminiCliProvider.ts
├── GeminiResponseParser.ts
├── GeminiNotificationMonitor.ts
└── GeminiToolPermissionMapper.ts
```

All files use the templates provided above. Key customizations:

1. **GeminiCliProvider.ts**:
   - `escapeIndicator`: "Esc to cancel"
   - `chromePatterns`: Includes `/^●\s+Thinking\.\.\./i`
   - `formatFileReference()`: Returns `@${path}`

2. **GeminiResponseParser.ts**:
   - `parseTokenCounts()`: Regex matches "Tokens: X in, Y out"
   - `extractSessionId()`: Regex matches "Session: abc-123"

3. **GeminiNotificationMonitor.ts**:
   - `buildHookConfig()`: Returns `{ type: "none" }` (no hook support)
   - `monitorForCompletion()`: Returns immediately (rely on TUI escape indicator)

4. **GeminiToolPermissionMapper.ts**:
   - `buildArgs()`: Uses `--allow-tool` and `--deny-tool` flags
   - `hasFullPermissions()`: Returns true for dangerouslyAllowAll and allowAll modes

### FlightPathManager Integration

```typescript
// src/flightpath/FlightPathManager.ts
import { GeminiCliProvider } from "./cli/gemini/GeminiCliProvider";

// In initializeCopilotIntegration():
case "gemini-cli":
    this.copilotIntegration = new CliIntegration(
        new GeminiCliProvider(),
        this.context
    );
    break;
```

### package.json Settings

```json
{
  "flightpath.provider": {
    "enum": [
      "copilot-cli",
      "claude-cli",
      "codex-cli",
      "gemini-cli",
      "copilot-chat"
    ],
    "default": "copilot-cli"
  },
  "flightpath.geminiCliModel": {
    "type": "string",
    "enum": ["gemini-pro", "gemini-ultra", "gemini-flash"],
    "default": "gemini-pro"
  }
}
```

### Test Workflow

```yaml
# manual-test/gemini-test.flightpath.yaml
prompts:
  - id: introduce
    prompt: |
      Hello! My name is Alice and I'm a software engineer.
    model: gemini-pro

  - id: recall
    prompt: |
      What is my name and profession?
    newChatSession: false # Continue session
    model: gemini-pro
```

**Expected Output**:

- First prompt: "Hello Alice! Nice to meet you."
- Second prompt: "Your name is Alice and you're a software engineer."

---

## Summary

Adding a new CLI provider to FlightPath requires:

1. **Research** the CLI's capabilities (15-30 minutes)
2. **Implement 4 classes** using provided templates (2-4 hours)
3. **Integrate** with FlightPathManager (5 minutes)
4. **Add settings** to package.json (10 minutes)
5. **Test thoroughly** using checklist (1-2 hours)
6. **Document** provider-specific quirks (30 minutes)

**Total time**: 4-8 hours for a complete, tested integration.

**Key benefits of composition architecture**:

- ✅ Zero core class modifications
- ✅ Provider code colocated and easy to find
- ✅ Interface contracts prevent mistakes
- ✅ Testable components (no mocking needed)
- ✅ Clear template to follow

---

## Next Steps

1. Start with **Phase 1: Research** - understand your CLI thoroughly
2. Copy templates and customize for your CLI
3. Test incrementally (parser → monitor → mapper → provider)
4. Run full testing checklist
5. Submit PR with provider implementation + tests + docs

**Questions or Issues?**

- Review existing providers: copilot/, claude/, codex/
- Check `.github/instructions/flightpath-cli.instructions.md`
- Open GitHub issue with `provider-integration` label

Happy integrating! 🚀
