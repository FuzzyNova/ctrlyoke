# CLI Integration Architecture Refactoring Plan (Composition-Based)

**Date**: January 15, 2026  
**Approach**: Composition over Inheritance  
**Purpose**: Make CLI integrations maximally extensible for easy addition of new providers (Gemini, OpenCode, etc.)

## Problem Statement

The current CLI integration architecture has two major issues:

1. **Provider-specific logic scattered across shared utilities**:
   - `CliResponseParser` contains `parseClaudeStreamJson()`, `parseCodexJsonLines()`, `parseCopilotText()`
   - `CliNotificationMonitor` contains `buildClaudeStopHookSettings()`, `buildCodexNotifyConfig()`, `buildCopilotHookConfig()`
   - `CliToolPermissionMapper` contains `buildClaudeArgs()`, `buildCopilotArgs()`, `buildCodexArgs()`

2. **Inheritance-based architecture requires implementing 15+ abstract methods**:
   - `BaseCliIntegration` has many abstract methods each provider must implement
   - Adding providers = extending base class + implementing all abstract methods
   - Tight coupling through inheritance hierarchy

## Design Goals

1. **Zero Base Class Changes**: Adding providers should NEVER require modifying core classes or interfaces
2. **Composition Over Inheritance**: Use "has-a" instead of "is-a" relationships
3. **Provider Isolation**: Each provider owns ALL its logic in one directory
4. **Interface-Driven**: TypeScript guides implementation via interfaces
5. **Easy Testing**: Test provider components independently without mocking
6. **Discoverable Pattern**: Clear template for adding new providers

## Proposed Architecture: Composition-Based

### Core Concept

**Single generic integration class** that accepts a **provider descriptor** containing all provider-specific logic:

```typescript
// Generic integration class (one class for ALL providers)
class CliIntegration extends CopilotIntegration {
  constructor(
    private provider: ICliProvider,
    context: vscode.ExtensionContext
  ) {
    super(context);
  }

  // All methods delegate to provider
  protected getCliName() { return this.provider.config.name; }
  protected getEscapeIndicator() { return this.provider.config.escapeIndicator; }
  // ...
}

// Provider descriptor with ALL provider-specific logic
class CopilotCliProvider implements ICliProvider {
  readonly config: ProviderConfig = { /* all configuration */ };
  readonly responseParser: IResponseParser;
  readonly notificationMonitor: INotificationMonitor;
  readonly toolPermissionMapper: IToolPermissionMapper;

  // Provider-specific methods
  buildHeadlessArgs(...) { /* Copilot-specific logic */ }
  buildInteractiveCommand(...) { /* Copilot-specific logic */ }
}
```

### Directory Structure

```
src/flightpath/cli/
├── CliIntegration.ts                  # Generic integration class (one for all providers)
├── ICliProvider.ts                    # Provider interface (rarely changes)
├── copilot/
│   ├── CopilotCliProvider.ts          # Provider descriptor (ALL Copilot logic)
│   ├── CopilotResponseParser.ts       # Response parsing
│   ├── CopilotNotificationMonitor.ts  # Completion detection
│   └── CopilotToolPermissionMapper.ts # Permission args
├── claude/
│   ├── ClaudeCliProvider.ts           # Provider descriptor (ALL Claude logic)
│   ├── ClaudeResponseParser.ts
│   ├── ClaudeNotificationMonitor.ts
│   └── ClaudeToolPermissionMapper.ts
├── codex/
│   ├── CodexCliProvider.ts            # Provider descriptor (ALL Codex logic)
│   ├── CodexResponseParser.ts
│   ├── CodexNotificationMonitor.ts
│   └── CodexToolPermissionMapper.ts
├── shared/
│   ├── interfaces/                    # NEW: Provider contracts
│   │   ├── ICliProvider.ts            # Main provider interface
│   │   ├── IResponseParser.ts         # Response parsing interface
│   │   ├── INotificationMonitor.ts    # Completion detection interface
│   │   └── IToolPermissionMapper.ts   # Permission mapping interface
│   ├── CliProcessManager.ts           # Process/terminal management (truly shared)
│   ├── TuiStreamProcessor.ts          # TUI streaming utilities (truly shared)
│   ├── CliMcpConfigGenerator.ts       # MCP config generation (truly shared)
│   └── TempFileManager.ts             # Temp file utilities (truly shared)
└── gemini/                            # FUTURE: Easy to add new providers
    ├── GeminiCliProvider.ts
    ├── GeminiResponseParser.ts
    ├── GeminiNotificationMonitor.ts
    └── GeminiToolPermissionMapper.ts
```

## Core Interfaces

### 1. ICliProvider (Main Provider Interface)

The main contract that each provider must implement:

```typescript
/**
 * Provider configuration (static metadata)
 */
export interface ProviderConfig {
  /** Provider name (e.g., "copilot", "claude", "codex") */
  name: string;

  /** Display name for status messages */
  displayName: string;

  /** Installation hint when CLI not found */
  installHint: string;

  /** Escape indicator for TUI completion detection */
  escapeIndicator: string;

  /** Screen end pattern for TUI parsing */
  screenEndPattern: RegExp;

  /** TUI chrome patterns for filtering */
  chromePatterns: RegExp[];

  /** Whether to stream headless output in real-time */
  shouldStreamHeadlessOutput: boolean;
}

/**
 * Main provider interface - each CLI provider must implement this
 */
export interface ICliProvider {
  /** Static provider configuration */
  readonly config: ProviderConfig;

  /** Response parser component */
  readonly responseParser: IResponseParser;

  /** Notification monitor component */
  readonly notificationMonitor: INotificationMonitor;

  /** Tool permission mapper component */
  readonly toolPermissionMapper: IToolPermissionMapper;

  /**
   * Build CLI arguments for headless mode with file reference
   * @param baseArgs Base arguments array
   * @param promptFileRef File reference (e.g., "@.flightpath/temp/prompt.md")
   * @returns Complete arguments array
   */
  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[];

  /**
   * Build CLI arguments for headless mode with direct prompt
   * @param baseArgs Base arguments array
   * @param promptText Prompt text
   * @returns Complete arguments array
   */
  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[];

  /**
   * Build CLI command for interactive TUI mode
   * @param baseArgs Base arguments array
   * @returns Complete command string
   */
  buildInteractiveTuiCommand(baseArgs: string[]): string;

  /**
   * Format a file path reference for this CLI
   * @param relativeFilePath Relative file path
   * @returns Formatted file reference (e.g., "@path" or "path")
   */
  formatFileReference(relativeFilePath: string): string;

  /**
   * Generate MCP server configuration arguments (optional)
   * @param mcpServerPath Absolute path to MCP server executable
   * @param workspaceRoot Workspace root directory
   * @returns CLI arguments array, or null if MCP not supported
   */
  getMcpConfigArgs?(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null>;

  /**
   * Check if CLI is available on the system
   * @returns True if CLI executable found
   */
  checkAvailability(): Promise<boolean>;

  /**
   * Get CLI version string
   * @returns Version string if available
   */
  getVersion?(): Promise<string | undefined>;
}
```

### 2. IResponseParser (Response Parsing Interface)

```typescript
/**
 * Response parsing interface
 */
export interface IResponseParser {
  /**
   * Parse CLI output into structured result
   * @param stdout CLI stdout
   * @param stderr CLI stderr
   * @param exitCode Process exit code
   * @returns Parsed result with optional session ID
   */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string };

  /**
   * Process streaming chunk for real-time display
   * @param chunk Raw stdout chunk
   * @param streamState Accumulated state (persists across chunks)
   * @returns Processed content to emit, or undefined to skip
   */
  processStreamingChunk?(
    chunk: string,
    streamState: Map<string, any>
  ): string | undefined;

  /**
   * Extract session/thread ID from CLI output
   * @param output Raw CLI output
   * @returns Session ID if found
   */
  extractSessionId?(output: string): string | undefined;

  /**
   * Parse token counts from output
   * @param output CLI output or statistics string
   * @returns Token counts if found
   */
  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined;
}

/**
 * Shared utilities for response parsers (optional base class)
 */
export abstract class ResponseParserBase implements IResponseParser {
  abstract parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string };
  abstract parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined;

  /**
   * Format usage statistics for display
   */
  protected formatStatistics(
    usage:
      | { input_tokens: number; output_tokens: number; total_tokens?: number }
      | undefined,
    model?: string
  ): string {
    if (!usage) return "";

    const { input_tokens, output_tokens, total_tokens } = usage;
    const total = total_tokens || input_tokens + output_tokens;
    let stats = `Usage: ${input_tokens} input + ${output_tokens} output = ${total} tokens`;

    if (model) {
      stats += ` | Model: ${model}`;
    }

    return stats;
  }
}
```

### 3. INotificationMonitor (Completion Detection Interface)

```typescript
/**
 * Notification monitoring configuration
 */
export interface NotificationConfig {
  directory: string;
  pollMs?: number;
  timeoutMs: number;
}

/**
 * Notification monitoring result
 */
export interface NotificationResult {
  completed: boolean;
  error?: string;
  data?: any;
}

/**
 * Hook configuration result (varies by CLI)
 */
export type HookConfig =
  | { type: "json"; config: object } // Copilot: JSON object
  | { type: "json-string"; config: string } // Claude: JSON string
  | { type: "toml-inline"; config: string } // Codex: TOML inline
  | { type: "none" }; // No hook support

/**
 * Notification monitoring interface
 */
export interface INotificationMonitor {
  /**
   * Monitor for completion notification
   * @param config Monitoring configuration
   * @param sessionId Optional session/thread ID (undefined = wildcard mode)
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns Monitoring result
   */
  monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult>;

  /**
   * Build hook/notification configuration
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory
   * @returns Hook configuration (format varies by CLI)
   */
  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig;

  /**
   * Get notification directory for this CLI
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  getNotificationDirectory(workspaceRoot: string): string;

  /**
   * Extract session/thread ID from notification data
   * @param data Notification file content
   * @returns Session ID if found
   */
  extractSessionId?(data: any): string | undefined;
}

/**
 * Shared utilities for notification monitors (optional base class)
 */
export abstract class NotificationMonitorBase implements INotificationMonitor {
  abstract monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult>;

  abstract buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig;

  abstract getNotificationDirectory(workspaceRoot: string): string;

  /** Shared: Simple delay utility */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Shared: Read and parse JSON notification file */
  protected async readNotificationFile(filePath: string): Promise<any | null> {
    try {
      const fs = await import("fs");
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /** Shared: Check for specific notification file */
  protected async checkSpecificFile(
    directory: string,
    fileName: string
  ): Promise<NotificationResult> {
    const path = require("path");
    const filePath = path.join(directory, fileName);

    const data = await this.readNotificationFile(filePath);
    if (data) {
      return { completed: true, data };
    }

    return { completed: false };
  }
}
```

### 4. IToolPermissionMapper (Permission Mapping Interface)

```typescript
/**
 * Tool permission mode
 */
export type ToolPermissionMode = "dangerouslyAllowAll" | "allowAll" | "custom";

/**
 * Tool permission configuration
 */
export interface ToolPermissionConfig {
  mode: ToolPermissionMode;
  allowedTools: string[];
  deniedTools: string[];
}

/**
 * Tool permission mapper interface
 */
export interface IToolPermissionMapper {
  /**
   * Build CLI arguments for tool permissions
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[];

  /**
   * Check if full permissions are granted (no prompts will occur)
   * @param config Tool permission configuration
   * @returns True if all permissions auto-granted
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean;
}

/**
 * Shared utilities for tool permission mappers (optional base class)
 */
export abstract class ToolPermissionMapperBase implements IToolPermissionMapper {
  abstract buildArgs(config: ToolPermissionConfig): string[];
  abstract hasFullPermissions(config: ToolPermissionConfig): boolean;

  /**
   * Parse a tool pattern into name and arguments
   * @param pattern Tool pattern string (e.g., "shell(git:*)")
   * @returns [toolName, args] or null if invalid
   */
  protected parsePattern(pattern: string): [string, string] | null {
    const match = pattern.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/);
    if (!match) {
      return null;
    }
    return [match[1], match[2] || ""];
  }
}
```

## Generic CliIntegration Class

**Single integration class** that works with any provider:

```typescript
/**
 * Generic CLI integration using composition
 *
 * This class delegates all provider-specific behavior to the ICliProvider instance.
 * Adding a new CLI provider requires:
 * 1. Creating a new provider class implementing ICliProvider
 * 2. Instantiating CliIntegration with that provider
 *
 * NO changes to this class are needed when adding providers.
 */
export class CliIntegration extends CopilotIntegration {
  protected sessionId?: string;
  protected initializationStatus: CopilotStatus = CopilotStatus.Initializing;
  protected lastResult?: CopilotCliResult;
  protected lastCliCommand?: string;
  protected lastFullPrompt?: string;
  protected currentProcess?: ChildProcess;
  protected processManager: CliProcessManager;
  protected currentExecution?: vscode.TerminalShellExecution;
  private readAbortController?: AbortController;
  protected lastSanitizedPrompt?: string;
  private cachedMcpConfigPath?: string;
  private streamState = new Map<string, any>();

  constructor(
    private provider: ICliProvider,
    context: vscode.ExtensionContext
  ) {
    super(context);
    this.processManager = new CliProcessManager(provider.config.name);
  }

  // Delegate to provider config
  public getIntegrationMode(): string {
    return `${this.provider.config.name}-cli`;
  }

  protected getCliDisplayName(): string {
    return this.provider.config.displayName;
  }

  protected getInstallHint(): string {
    return this.provider.config.installHint;
  }

  protected getCliName(): string {
    return this.provider.config.name;
  }

  protected getEscapeIndicator(): string {
    return this.provider.config.escapeIndicator;
  }

  protected getScreenEndPattern(): RegExp {
    return this.provider.config.screenEndPattern;
  }

  protected getTuiChromePatterns(): RegExp[] {
    return this.provider.config.chromePatterns;
  }

  protected shouldStreamHeadlessOutput(): boolean {
    return this.provider.config.shouldStreamHeadlessOutput;
  }

  // Delegate to provider methods
  protected buildHeadlessArgs(
    baseArgs: string[],
    promptFileRef: string
  ): string[] {
    return this.provider.buildHeadlessArgs(baseArgs, promptFileRef);
  }

  protected buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    return this.provider.buildHeadlessArgsWithDirectPrompt(
      baseArgs,
      promptText
    );
  }

  protected buildInteractiveTuiCommand(baseArgs: string[]): string {
    return this.provider.buildInteractiveTuiCommand(baseArgs);
  }

  protected formatFileReference(relativeFilePath: string): string {
    return this.provider.formatFileReference(relativeFilePath);
  }

  protected async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    if (!this.provider.getMcpConfigArgs) {
      return null; // Provider doesn't support MCP
    }
    return this.provider.getMcpConfigArgs(mcpServerPath, workspaceRoot);
  }

  // Delegate to response parser
  parseTokenCounts(statistics: string) {
    return this.provider.responseParser.parseTokenCounts(statistics);
  }

  protected processStreamingChunk(chunk: string): string | undefined {
    if (!this.provider.responseParser.processStreamingChunk) {
      return chunk; // Default: pass through
    }
    return this.provider.responseParser.processStreamingChunk(
      chunk,
      this.streamState
    );
  }

  // Delegate to tool permission mapper
  protected hasFullPermissions(): boolean {
    const config = this.getToolPermissionConfig();
    return this.provider.toolPermissionMapper.hasFullPermissions(config);
  }

  private getToolPermissionConfig(): ToolPermissionConfig {
    const mode = ConfigurationUtils.getToolPermissionMode();
    return {
      mode,
      allowedTools: ConfigurationUtils.getAllowedTools(),
      deniedTools: ConfigurationUtils.getDeniedTools(),
    };
  }

  // Initialize by checking provider availability
  async initialize(): Promise<void> {
    try {
      const isAvailable = await this.provider.checkAvailability();

      if (!isAvailable) {
        this.initializationStatus = CopilotStatus.SetupRequired;
        this.emitStatusChange(
          CopilotStatus.SetupRequired,
          this.provider.config.installHint
        );
        return;
      }

      // Optionally get version
      if (this.provider.getVersion) {
        const version = await this.provider.getVersion();
        Log.info(
          `✅ ${this.provider.config.displayName} version ${version || "unknown"}`
        );
      }

      this.initializationStatus = CopilotStatus.Ready;
      this.emitStatusChange(
        CopilotStatus.Ready,
        `${this.provider.config.displayName} ready`
      );
    } catch (error) {
      this.initializationStatus = CopilotStatus.SetupRequired;
      this.emitStatusChange(
        CopilotStatus.SetupRequired,
        `${this.provider.config.displayName} initialization failed`
      );
    }
  }

  // ... rest of implementation delegates to provider components
}
```

## Example Provider Implementation

### CopilotCliProvider.ts

```typescript
import {
  ICliProvider,
  ProviderConfig,
} from "../shared/interfaces/ICliProvider";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IToolPermissionMapper } from "../shared/interfaces/IToolPermissionMapper";
import { CopilotResponseParser } from "./CopilotResponseParser";
import { CopilotNotificationMonitor } from "./CopilotNotificationMonitor";
import { CopilotToolPermissionMapper } from "./CopilotToolPermissionMapper";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Copilot CLI Provider
 *
 * Implements all Copilot-specific logic:
 * - TUI patterns and completion detection
 * - sessionEnd hook configuration
 * - Plain text output parsing
 * - Tool permission conversion from user-friendly patterns
 */
export class CopilotCliProvider implements ICliProvider {
  readonly config: ProviderConfig = {
    name: "copilot",
    displayName: "GitHub Copilot CLI",
    installHint: "Install via: npm install -g @githubnext/github-copilot-cli",
    escapeIndicator: "Esc to cancel",
    screenEndPattern: /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand\s+recent/gi,
    chromePatterns: [
      /^[─═╭╮╰╯│┌┐└┘├┤┬┴┼]{8,}$/,
      /^[─═]{50,}$/,
      /^│\s*│$/,
      /^Welcome to GitHub Copilot CLI/i,
      /Version.*·.*Commit/i,
      /check for mistakes/i,
      /^●\s+Logged in as user:/i,
      /^●\s+Connected to.*MCP Server/i,
      /^●\s+Model changed to:/i,
      /^\s*[·∙◉◎●]\s*$/,
      /^\s*[·∙◉◎●]\s+.*\(Esc to cancel/i,
      /\[⎇\s+\w+\*?\].*gpt-.*\(\d+x\)/i,
      /Ctrl\+c\s+Exit\s*·\s*Ctrl\+r\s+Expand/i,
      /Enter @ to mention files/i,
      /^>\s*$/,
      /^Do you want to run this command\?/i,
      /Confirm with number keys.*Cancel with Esc/i,
      /^❯\s*\d+\./,
      /No, and tell Copilot what to do differently/i,
    ],
    shouldStreamHeadlessOutput: true,
  };

  readonly responseParser: IResponseParser = new CopilotResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new CopilotNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new CopilotToolPermissionMapper();

  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    return [...baseArgs, promptFileRef];
  }

  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    return [...baseArgs, promptText];
  }

  buildInteractiveTuiCommand(baseArgs: string[]): string {
    return `copilot ${baseArgs.join(" ")}`;
  }

  formatFileReference(relativeFilePath: string): string {
    return `@${relativeFilePath}`;
  }

  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    // Copilot CLI MCP support (if implemented)
    return null; // TODO: Implement when Copilot CLI supports MCP
  }

  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("copilot --version");
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("copilot --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
```

## Factory Pattern in FlightPathManager

```typescript
private createCopilotIntegration(provider: Provider): CopilotIntegration {
  switch (provider) {
    case Provider.CopilotCli: {
      const copilotProvider = new CopilotCliProvider();
      return new CliIntegration(copilotProvider, this.context);
    }
    case Provider.ClaudeCli: {
      const claudeProvider = new ClaudeCliProvider();
      return new CliIntegration(claudeProvider, this.context);
    }
    case Provider.CodexCli: {
      const codexProvider = new CodexCliProvider();
      return new CliIntegration(codexProvider, this.context);
    }
    case Provider.GeminiCli: {  // NEW: Easy to add!
      const geminiProvider = new GeminiCliProvider();
      return new CliIntegration(geminiProvider, this.context);
    }
    case Provider.CopilotChat:
      return new CopilotChatIntegration(this.context);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
```

```typescript
/**
 * Notification monitoring configuration
 */
export interface NotificationConfig {
  directory: string;
  pollMs?: number;
  timeoutMs: number;
}

/**
 * Abstract base class for CLI completion notification monitoring
 *
 * Each CLI integration must implement a notification monitor that:
 * 1. Configures hook/notification scripts
 * 2. Monitors for completion events
 * 3. Extracts session IDs from notifications
 */
export abstract class BaseNotificationMonitor {
  /**
   * Monitor for completion notification
   *
   * @param config Monitoring configuration
   * @param sessionId Optional session/thread ID (undefined = wildcard mode)
   * @param startTime Execution start time
   * @param onCancel Cancellation callback
   * @returns Monitoring result
   */
  abstract monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult>;

  /**
   * Build hook/notification configuration
   *
   * @param scriptPath Path to notification handler script
   * @param notifyDir Notification directory
   * @param workspaceRoot Workspace root directory
   * @returns Hook configuration (format varies by CLI)
   */
  abstract buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig;

  /**
   * Get notification directory for this CLI
   *
   * @param workspaceRoot Workspace root
   * @returns Notification directory path
   */
  abstract getNotificationDirectory(workspaceRoot: string): string;

  /**
   * Extract session/thread ID from notification data
   *
   * @param data Notification file content
   * @returns Session ID if found
   */
  abstract extractSessionId(data: any): string | undefined;

  /**
   * Shared utility: Simple delay
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Shared utility: Read and parse JSON notification file
   */
  protected async readNotificationFile(filePath: string): Promise<any | null> {
    try {
      const fs = await import("fs");
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Shared utility: Check for specific notification file
   */
  protected async checkSpecificFile(
    directory: string,
    fileName: string
  ): Promise<NotificationResult> {
    const path = require("path");
    const filePath = path.join(directory, fileName);

    const data = await this.readNotificationFile(filePath);
    if (data) {
      return { completed: true, data };
    }

    return { completed: false };
  }

  /**
   * Shared utility: Check for any new file in directory
   */
  protected async checkForNewFile(
    directory: string,
    initialFiles: Set<string>
  ): Promise<NotificationResult> {
    const fs = await import("fs");
    const path = require("path");

    try {
      const currentFiles = fs.readdirSync(directory);

      for (const file of currentFiles) {
        if (!initialFiles.has(file) && file.endsWith(".json")) {
          const data = await this.readNotificationFile(
            path.join(directory, file)
          );
          if (data) {
            return { completed: true, data };
          }
        }
      }
    } catch (error) {
      // Directory read error
    }

    return { completed: false };
  }
}

/**
 * Hook configuration result (varies by CLI)
 */
export type HookConfig =
  | { type: "json"; config: object } // Copilot: JSON object
  | { type: "json-string"; config: string } // Claude: JSON string
  | { type: "toml-inline"; config: string }; // Codex: TOML inline string
```

**Usage in integration class**:

```typescript
export class ClaudeCommandLineIntegration extends BaseCliIntegration {
  private notificationMonitor: ClaudeNotificationMonitor;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.notificationMonitor = new ClaudeNotificationMonitor();
  }

  private async monitorNotificationFile(
    sessionId: string | undefined,
    startTime: Date,
    timeoutMs: number
  ): Promise<NotificationResult> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    return this.notificationMonitor.monitorForCompletion(
      { directory: notifyDir, timeoutMs },
      sessionId,
      startTime
    );
  }

  private buildStopHookSettings(): string {
    const scriptPath = this.getStopHookScriptPath();
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);

    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot
    );

    return hookConfig.config; // JSON string for Claude
  }
}
```

### 3. BaseToolPermissionMapper (Abstract Base Class)

```typescript
/**
 * Tool permission mode
 */
export type ToolPermissionMode = "dangerouslyAllowAll" | "allowAll" | "custom";

/**
 * Tool permission configuration
 */
export interface ToolPermissionConfig {
  mode: ToolPermissionMode;
  allowedTools: string[];
  deniedTools: string[];
}

/**
 * Abstract base class for CLI tool permission mapping
 *
 * Each CLI integration must implement a permission mapper that:
 * 1. Converts user configuration to CLI-specific arguments
 * 2. Handles mode-based permissions (dangerouslyAllowAll, allowAll, custom)
 * 3. Maps tool patterns between formats (if needed)
 */
export abstract class BaseToolPermissionMapper {
  /**
   * Build CLI arguments for tool permissions
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  abstract buildArgs(config: ToolPermissionConfig): string[];

  /**
   * Check if full permissions are granted (no prompts will occur)
   *
   * @param config Tool permission configuration
   * @returns True if all permissions auto-granted
   */
  abstract hasFullPermissions(config: ToolPermissionConfig): boolean;

  /**
   * Convert tool pattern to CLI-specific format (if needed)
   *
   * Example: Copilot "shell(git:*)" → Claude "Bash(git:*)"
   *
   * @param pattern User-specified tool pattern
   * @returns CLI-specific tool pattern
   */
  protected convertToolPattern(pattern: string): string {
    // Default: no conversion needed
    return pattern;
  }

  /**
   * Parse a tool pattern into name and arguments
   *
   * Example: "shell(git:*)" → ["shell", "(git:*)"]
   *
   * @param pattern Tool pattern string
   * @returns [toolName, args] or null if invalid
   */
  protected parsePattern(pattern: string): [string, string] | null {
    const match = pattern.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/);
    if (!match) {
      return null;
    }
    return [match[1], match[2] || ""];
  }
}
```

**Usage in integration class**:

```typescript
export class ClaudeCommandLineIntegration extends BaseCliIntegration {
  private toolPermissionMapper: ClaudeToolPermissionMapper;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.toolPermissionMapper = new ClaudeToolPermissionMapper();
  }

  protected hasFullPermissions(): boolean {
    const mode = ConfigurationUtils.getToolPermissionMode();
    const config: ToolPermissionConfig = {
      mode,
      allowedTools: ConfigurationUtils.getAllowedTools(),
      deniedTools: ConfigurationUtils.getDeniedTools(),
    };

    return this.toolPermissionMapper.hasFullPermissions(config);
  }

  private getToolPermissionArgs(): string[] {
    const mode = ConfigurationUtils.getToolPermissionMode();
    const config: ToolPermissionConfig = {
      mode,
      allowedTools: ConfigurationUtils.getAllowedTools(),
      deniedTools: ConfigurationUtils.getDeniedTools(),
    };

    return this.toolPermissionMapper.buildArgs(config);
  }
}
```

## Migration Strategy

### Phase 1: Create Interface Definitions (No Breaking Changes)

**Goal**: Define contracts without touching existing code

1. Create `src/flightpath/cli/shared/interfaces/` directory
2. Add interface files:
   - `ICliProvider.ts` - Main provider contract
   - `IResponseParser.ts` - Response parsing contract
   - `INotificationMonitor.ts` - Completion detection contract
   - `IToolPermissionMapper.ts` - Permission mapping contract
   - `ProviderConfig.ts` - Configuration types
3. Add optional base classes (for shared utilities):
   - `ResponseParserBase.ts`
   - `NotificationMonitorBase.ts`
   - `ToolPermissionMapperBase.ts`

**Deliverable**: Interfaces defined, zero production code changes

**Time**: 2 hours

---

### Phase 2: Create Generic CliIntegration Class

**Goal**: Build composition-based integration class (parallel to existing)

1. Create `src/flightpath/cli/CliIntegration.ts`
2. Implement generic integration using composition
3. Delegate all behavior to `ICliProvider` instance
4. Keep `BaseCliIntegration.ts` unchanged (existing providers still work)

**Deliverable**: New `CliIntegration` class ready to use, existing code unaffected

**Time**: 3 hours

---

### Phase 3: Refactor Copilot (Pilot Implementation)

**Goal**: Prove the pattern works with one provider

1. Create `src/flightpath/cli/copilot/` directory
2. Create component classes:
   - `CopilotCliProvider.ts` - Implements `ICliProvider`
   - `CopilotResponseParser.ts` - Implements `IResponseParser`
   - `CopilotNotificationMonitor.ts` - Implements `INotificationMonitor`
   - `CopilotToolPermissionMapper.ts` - Implements `IToolPermissionMapper`
3. Extract Copilot-specific logic from:
   - `CopilotCommandLineIntegration.ts` → `CopilotCliProvider.ts`
   - `CliResponseParser.parseCopilotText()` → `CopilotResponseParser.parse()`
   - `CliNotificationMonitor.buildCopilotHookConfig()` → `CopilotNotificationMonitor.buildHookConfig()`
   - `CliToolPermissionMapper.buildCopilotArgs()` → `CopilotToolPermissionMapper.buildArgs()`
4. Update `FlightPathManager` factory to use `CliIntegration` with `CopilotCliProvider`
5. Test thoroughly (interactive mode, headless mode, session resumption)

**Deliverable**: Copilot working with new architecture, old `CopilotCommandLineIntegration` can be deleted

**Time**: 5 hours

---

### Phase 4: Refactor Claude

**Goal**: Apply proven pattern to second provider

1. Create `src/flightpath/cli/claude/` directory
2. Create component classes (same structure as Copilot):
   - `ClaudeCliProvider.ts`
   - `ClaudeResponseParser.ts`
   - `ClaudeNotificationMonitor.ts`
   - `ClaudeToolPermissionMapper.ts`
3. Extract Claude-specific logic from shared utilities
4. Update factory to use `CliIntegration` with `ClaudeCliProvider`
5. Test thoroughly
6. Delete old `ClaudeCommandLineIntegration.ts`

**Deliverable**: Claude working with new architecture

**Time**: 4 hours

---

### Phase 5: Refactor Codex

**Goal**: Complete migration of all existing providers

1. Create `src/flightpath/cli/codex/` directory
2. Create component classes (same structure):
   - `CodexCliProvider.ts`
   - `CodexResponseParser.ts`
   - `CodexNotificationMonitor.ts`
   - `CodexToolPermissionMapper.ts`
3. Extract Codex-specific logic from shared utilities
4. Update factory to use `CliIntegration` with `CodexCliProvider`
5. Test thoroughly
6. Delete old `CodexCommandLineIntegration.ts`

**Deliverable**: All 3 providers using new architecture

**Time**: 4 hours

---

### Phase 6: Clean Up Old Code

**Goal**: Remove deprecated files and methods

1. Delete old integration classes:
   - `BaseCliIntegration.ts` (replaced by `CliIntegration.ts`)
   - `CopilotCommandLineIntegration.ts`
   - `ClaudeCommandLineIntegration.ts`
   - `CodexCommandLineIntegration.ts`
2. Delete provider-specific methods from shared utilities:
   - `CliResponseParser.parseClaudeStreamJson()` → DELETED
   - `CliResponseParser.parseCodexJsonLines()` → DELETED
   - `CliResponseParser.parseCopilotText()` → DELETED
   - `CliNotificationMonitor.buildClaudeStopHookSettings()` → DELETED
   - `CliNotificationMonitor.buildCodexNotifyConfig()` → DELETED
   - `CliNotificationMonitor.buildCopilotHookConfig()` → DELETED
   - `CliToolPermissionMapper.buildClaudeArgs()` → DELETED
   - `CliToolPermissionMapper.buildCopilotArgs()` → DELETED
   - `CliToolPermissionMapper.buildCodexArgs()` → DELETED
3. Keep only truly generic utilities in shared:
   - `CliProcessManager.ts`
   - `TuiStreamProcessor.ts`
   - `CliMcpConfigGenerator.ts`
   - `TempFileManager.ts`
4. Update imports across codebase
5. Run full test suite
6. Check for TypeScript errors

**Deliverable**: Clean codebase with only composition-based architecture

**Time**: 2 hours

---

### Phase 7: Update Documentation

**Goal**: Guide future developers

1. Update `.github/instructions/flightpath-cli.instructions.md`:
   - Document composition-based architecture
   - Explain provider interface contracts
   - Update code examples
2. Create `docs/ADDING_NEW_CLI_PROVIDER.md`:
   - Step-by-step guide with checklist
   - Complete code templates for each component
   - Example: Adding Gemini CLI integration
3. Update main README if needed

**Deliverable**: Comprehensive documentation for extensibility

**Time**: 2 hours

---

## Total Implementation Effort

| Phase     | Description           | Effort       | Risk   |
| --------- | --------------------- | ------------ | ------ |
| Phase 1   | Create interfaces     | 2 hours      | Low    |
| Phase 2   | Create CliIntegration | 3 hours      | Low    |
| Phase 3   | Refactor Copilot      | 5 hours      | Medium |
| Phase 4   | Refactor Claude       | 4 hours      | Low    |
| Phase 5   | Refactor Codex        | 4 hours      | Low    |
| Phase 6   | Clean up old code     | 2 hours      | Medium |
| Phase 7   | Update docs           | 2 hours      | Low    |
| **Total** | **Complete refactor** | **22 hours** | -      |

## Adding a New Provider (Post-Refactor)

### Step-by-Step Checklist for Adding Gemini CLI

#### 1. Create Provider Directory

```bash
mkdir src/flightpath/cli/gemini
```

#### 2. Create Response Parser

**File**: `src/flightpath/cli/gemini/GeminiResponseParser.ts`

```typescript
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import { ResponseParserBase } from "../shared/interfaces/IResponseParser";
import { CopilotCliResult } from "../../../types/CopilotTypes";

export class GeminiResponseParser extends ResponseParserBase {
  parse(
    stdout: string,
    stderr: string,
    exitCode: number
  ): CopilotCliResult & { sessionId?: string } {
    // Gemini-specific parsing logic
    // Example: If Gemini outputs JSON
    try {
      const json = JSON.parse(stdout);
      return {
        success: exitCode === 0,
        response: json.response || "",
        statistics: this.formatStatistics(json.usage),
        sessionId: json.session_id,
        exitCode,
      };
    } catch {
      // Fallback to plain text
      return {
        success: exitCode === 0,
        response: stdout.trim(),
        statistics: stderr.trim(),
        exitCode,
      };
    }
  }

  processStreamingChunk(
    chunk: string,
    streamState: Map<string, any>
  ): string | undefined {
    // Gemini-specific streaming (e.g., parse JSON lines)
    // Return extracted content or undefined to skip
    return chunk; // Default: pass through
  }

  extractSessionId(output: string): string | undefined {
    // Extract from output: "session_id: abc123" or JSON
    const match = output.match(/session_id[:\s]+([a-f0-9-]+)/i);
    return match?.[1];
  }

  parseTokenCounts(
    output: string
  ): { prompt: number; completion: number } | undefined {
    // Parse Gemini token format: "Tokens: 123 in + 456 out"
    const match = output.match(/(\d+)\s+in\s+\+\s+(\d+)\s+out/i);
    if (match) {
      return { prompt: parseInt(match[1]), completion: parseInt(match[2]) };
    }
    return undefined;
  }
}
```

#### 3. Create Notification Monitor

**File**: `src/flightpath/cli/gemini/GeminiNotificationMonitor.ts`

```typescript
import {
  INotificationMonitor,
  NotificationConfig,
  NotificationResult,
  HookConfig,
} from "../shared/interfaces/INotificationMonitor";
import { NotificationMonitorBase } from "../shared/interfaces/INotificationMonitor";
import * as path from "path";
import * as fs from "fs";

export class GeminiNotificationMonitor extends NotificationMonitorBase {
  async monitorForCompletion(
    config: NotificationConfig,
    sessionId: string | undefined,
    startTime: Date,
    onCancel?: () => boolean
  ): Promise<NotificationResult> {
    const pollMs = config.pollMs || 500;

    // Ensure directory exists
    if (!fs.existsSync(config.directory)) {
      fs.mkdirSync(config.directory, { recursive: true });
    }

    // Poll for completion file
    while (Date.now() - startTime.getTime() < config.timeoutMs) {
      if (onCancel && onCancel()) {
        return { completed: false, error: "User cancelled" };
      }

      const fileName = sessionId ? `${sessionId}.json` : "*.json";

      if (sessionId) {
        const result = await this.checkSpecificFile(
          config.directory,
          `${sessionId}.json`
        );
        if (result.completed) return result;
      } else {
        // Wildcard mode: check for any new file
        const files = fs.readdirSync(config.directory);
        if (files.length > 0) {
          const file = files[0];
          const result = await this.checkSpecificFile(config.directory, file);
          if (result.completed) return result;
        }
      }

      await this.delay(pollMs);
    }

    return { completed: false, error: "Timeout waiting for completion" };
  }

  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    workspaceRoot: string
  ): HookConfig {
    // Gemini uses JSON config (example)
    const config = {
      hooks: {
        onComplete: {
          command: `node "${scriptPath}" "${notifyDir}"`,
          timeout: 10,
        },
      },
    };

    return { type: "json", config };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return path.join(
      workspaceRoot,
      ".flightpath",
      "temp",
      "gemini-notifications"
    );
  }

  extractSessionId(data: any): string | undefined {
    return data.session_id || data.id;
  }
}
```

#### 4. Create Tool Permission Mapper

**File**: `src/flightpath/cli/gemini/GeminiToolPermissionMapper.ts`

```typescript
import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { ToolPermissionMapperBase } from "../shared/interfaces/IToolPermissionMapper";

export class GeminiToolPermissionMapper extends ToolPermissionMapperBase {
  buildArgs(config: ToolPermissionConfig): string[] {
    const args: string[] = [];

    if (config.mode === "dangerouslyAllowAll") {
      return ["--allow-all-tools"];
    }

    if (config.mode === "allowAll") {
      args.push("--auto-approve");
    } else if (config.mode === "custom") {
      // Custom mode: add specific allow/deny patterns
      config.allowedTools.forEach((tool) => {
        args.push("--allow-tool", tool);
      });
    }

    // Add deny patterns (applies to all modes except dangerouslyAllowAll)
    config.deniedTools.forEach((tool) => {
      args.push("--deny-tool", tool);
    });

    return args;
  }

  hasFullPermissions(config: ToolPermissionConfig): boolean {
    return config.mode === "dangerouslyAllowAll" || config.mode === "allowAll";
  }
}
```

#### 5. Create Provider Descriptor

**File**: `src/flightpath/cli/gemini/GeminiCliProvider.ts`

```typescript
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
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class GeminiCliProvider implements ICliProvider {
  readonly config: ProviderConfig = {
    name: "gemini",
    displayName: "Google Gemini CLI",
    installHint:
      "Install Gemini CLI: https://ai.google.dev/gemini-api/docs/cli",
    escapeIndicator: "esc to stop",
    screenEndPattern: /gemini>\s*$/g,
    chromePatterns: [
      /^Gemini CLI v[\d.]+/i,
      /^═+$/,
      /^│\s*│$/,
      /^Welcome to Gemini/i,
      /gemini>\s*$/,
      /Press Ctrl\+C to exit/i,
    ],
    shouldStreamHeadlessOutput: true,
  };

  readonly responseParser: IResponseParser = new GeminiResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new GeminiNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new GeminiToolPermissionMapper();

  buildHeadlessArgs(baseArgs: string[], promptFileRef: string): string[] {
    // Gemini uses --input-file flag
    return [...baseArgs, "--input-file", promptFileRef];
  }

  buildHeadlessArgsWithDirectPrompt(
    baseArgs: string[],
    promptText: string
  ): string[] {
    // Gemini uses --prompt flag
    return [...baseArgs, "--prompt", promptText];
  }

  buildInteractiveTuiCommand(baseArgs: string[]): string {
    return `gemini ${baseArgs.join(" ")}`;
  }

  formatFileReference(relativeFilePath: string): string {
    // Gemini doesn't use @ prefix
    return relativeFilePath;
  }

  async getMcpConfigArgs(
    mcpServerPath: string,
    workspaceRoot: string
  ): Promise<string[] | null> {
    // Gemini MCP support (if available)
    return ["--mcp-server", mcpServerPath, "--workspace", workspaceRoot];
  }

  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("gemini --version");
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("gemini --version");
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}
```

#### 6. Update FlightPathManager Factory

**File**: `src/flightpath/FlightPathManager.ts`

```typescript
import { GeminiCliProvider } from "./cli/gemini/GeminiCliProvider";

// In createCopilotIntegration method:
case Provider.GeminiCli: {
  const geminiProvider = new GeminiCliProvider();
  return new CliIntegration(geminiProvider, this.context);
}
```

#### 7. Add Configuration Settings

**File**: `package.json`

```json
"flightpath.geminiCliModel": {
  "type": "string",
  "enum": ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
  "default": "gemini-2.0-flash",
  "description": "Default model for Gemini CLI"
}
```

#### 8. Add Provider to Enum

**File**: `src/types/FlightPathTypes.ts`

```typescript
export enum Provider {
  CopilotChat = "copilot-chat",
  CopilotCli = "copilot-cli",
  ClaudeCli = "claude-cli",
  CodexCli = "codex-cli",
  GeminiCli = "gemini-cli", // NEW
}
```

#### 9. Test the Integration

**Manual testing checklist**:

- ✅ Interactive mode execution
- ✅ Headless mode execution
- ✅ Completion detection (hook or polling)
- ✅ Session resumption (`--resume` flag if supported)
- ✅ Tool permissions (allow/deny patterns)
- ✅ Token counting and statistics
- ✅ Error handling (CLI not found, invalid model, etc.)
- ✅ Streaming output in both modes
- ✅ MCP integration (if supported)

---

### Summary: Adding Gemini CLI

**Files created**: 4 new files in `gemini/` directory  
**Files modified**: 3 (FlightPathManager, package.json, FlightPathTypes)  
**Base classes/interfaces modified**: 0 (design goal achieved!)

**Total implementation time**: ~4 hours for a new provider

## Benefits: Before vs After

### Before Refactor (Current Inheritance-Based State)

**Architecture problems**:

- Provider logic scattered across 4+ files
- Inheritance hierarchy with 15+ abstract methods
- Shared utilities contain provider-specific static methods
- Unclear scope when adding new providers

**Adding Gemini CLI requires**:

1. Create `GeminiCommandLineIntegration extends BaseCliIntegration`
2. Implement 15+ abstract methods
3. Modify `CliResponseParser` - add `parseGeminiJson()` static method
4. Modify `CliNotificationMonitor` - add `buildGeminiHookConfig()` static method
5. Modify `CliToolPermissionMapper` - add `buildGeminiArgs()` static method
6. Update `FlightPathManager` factory
7. Hope you didn't break Copilot/Claude/Codex in the process

**Total**: 1 new class + 3 modified shared classes + ~15 abstract methods = **confusing and error-prone**

---

### After Refactor (Composition-Based State)

**Architecture benefits**:

- All provider logic colocated in one directory
- Composition via interfaces (no deep inheritance)
- Shared utilities contain ONLY truly generic code
- Crystal clear extension pattern

**Adding Gemini CLI requires**:

1. Create `gemini/` directory with 4 files:
   - `GeminiCliProvider.ts` - Implements `ICliProvider`
   - `GeminiResponseParser.ts` - Implements `IResponseParser`
   - `GeminiNotificationMonitor.ts` - Implements `INotificationMonitor`
   - `GeminiToolPermissionMapper.ts` - Implements `IToolPermissionMapper`
2. Update `FlightPathManager` factory - instantiate `CliIntegration` with `GeminiCliProvider`
3. Add settings to `package.json`

**Total**: 4 new files in isolated directory + 2 trivial updates = **clear and safe**

---

### Code Organization Comparison

**Current (confusing)**:

```
Where is all the Copilot code?
├── CopilotCommandLineIntegration.ts    ← Some Copilot logic
├── shared/
│   ├── CliResponseParser.ts            ← parseCopilotText() buried here
│   ├── CliNotificationMonitor.ts       ← buildCopilotHookConfig() buried here
│   └── CliToolPermissionMapper.ts      ← buildCopilotArgs() buried here
```

**Proposed (clear)**:

```
All Copilot code in one place:
└── copilot/
    ├── CopilotCliProvider.ts           ← ALL Copilot logic starts here
    ├── CopilotResponseParser.ts        ← Parsing logic
    ├── CopilotNotificationMonitor.ts   ← Completion detection
    └── CopilotToolPermissionMapper.ts  ← Permissions
```

---

### Testing Improvements

**Before (tight coupling)**:

- Testing `CopilotCommandLineIntegration` requires mocking `BaseCliIntegration`
- Testing parsing logic requires calling static methods on `CliResponseParser`
- Can't test Copilot logic without affecting other providers
- Integration tests are complex due to inheritance

**After (loose coupling)**:

- Testing `CopilotCliProvider` requires no mocking (pure logic)
- Testing `CopilotResponseParser` is trivial (implement interface, no inheritance)
- Copilot tests completely isolated from other providers
- Integration tests simple: `new CliIntegration(new CopilotCliProvider())`

---

### Extensibility Comparison

| Aspect                   | Before (Inheritance)    | After (Composition)        |
| ------------------------ | ----------------------- | -------------------------- |
| **Files to create**      | 1 main class            | 4 focused classes          |
| **Files to modify**      | 3-4 shared utilities    | 0 shared utilities         |
| **Abstract methods**     | Implement 15+           | Implement 4 interfaces     |
| **Risk to existing**     | High (shared code)      | Zero (isolated)            |
| **TypeScript guidance**  | Some (abstract methods) | Full (interface contracts) |
| **Testing complexity**   | High (mocking)          | Low (pure functions)       |
| **Code discoverability** | Low (scattered)         | High (colocated)           |
| **Merge conflicts**      | Likely (shared files)   | Unlikely (separate dirs)   |

## Success Criteria

### Phase-by-phase validation:

**Phase 1** (Interfaces):

- ✅ All interfaces compile without errors
- ✅ Optional base classes provide useful utilities
- ✅ No production code changes

**Phase 2** (CliIntegration):

- ✅ Generic `CliIntegration` compiles
- ✅ Delegates all behavior to provider
- ✅ Existing integrations still work

**Phase 3** (Copilot refactor):

- ✅ All manual-test workflows pass with Copilot
- ✅ Interactive mode works (TUI, completion detection)
- ✅ Headless mode works (background process)
- ✅ Session resumption works
- ✅ Tool permissions work (allow/deny patterns)
- ✅ Token counting accurate
- ✅ No regressions in user experience

**Phase 4** (Claude refactor):

- ✅ Same validation as Copilot
- ✅ Claude-specific features work (Stop hook, stream-json)

**Phase 5** (Codex refactor):

- ✅ Same validation as Copilot
- ✅ Codex-specific features work (notify hook, JSONL)

**Phase 6** (Cleanup):

- ✅ All old classes deleted
- ✅ No TypeScript errors
- ✅ No circular dependencies
- ✅ Full test suite passes
- ✅ All manual-test workflows pass

**Phase 7** (Documentation):

- ✅ Clear guide for adding new providers
- ✅ Complete code templates
- ✅ Architecture diagrams updated

### Final validation:

1. ✅ **Zero base class/interface changes** needed to add new provider
2. ✅ **All provider code colocated** (easy to find and modify)
3. ✅ **No regressions** (all existing functionality works)
4. ✅ **Clear template** (new developers can add providers easily)
5. ✅ **Testable** (provider components testable in isolation)
6. ✅ **TypeScript-guided** (interfaces prevent mistakes)
7. ✅ **Documentation** (comprehensive guide with examples)

## Future Enhancements Enabled

After this refactor, these features become trivial:

### 1. Dynamic Provider Loading

```typescript
// Load providers from config or plugins
const providerRegistry = new ProviderRegistry();
providerRegistry.register(new CopilotCliProvider());
providerRegistry.register(new ClaudeCliProvider());
providerRegistry.register(loadPlugin("gemini-provider")); // Third-party!

const integration = new CliIntegration(
  providerRegistry.get(userSelectedProvider),
  context
);
```

### 2. Provider Capability Detection

```typescript
interface ICliProvider {
  readonly capabilities: {
    supportsMcp: boolean;
    supportsStreaming: boolean;
    supportsSessionResumption: boolean;
    supportsToolPermissions: boolean;
  };
}

// UI can show/hide features based on provider capabilities
if (provider.capabilities.supportsMcp) {
  showMcpSettings();
}
```

### 3. Provider Metrics & Telemetry

```typescript
class MetricsWrapper implements ICliProvider {
  constructor(
    private inner: ICliProvider,
    private metrics: MetricsCollector
  ) {}

  async checkAvailability(): Promise<boolean> {
    const start = Date.now();
    const result = await this.inner.checkAvailability();
    this.metrics.record("availability_check", Date.now() - start);
    return result;
  }

  // Wrap all methods to collect metrics per provider
}
```

### 4. Provider A/B Testing

```typescript
// Test new Gemini provider against existing Copilot
const abTest = new ABTestProvider(
  new CopilotCliProvider(),
  new GeminiCliProvider(),
  0.5 // 50% split
);

const integration = new CliIntegration(abTest, context);
```

### 5. Provider Composition & Fallback

```typescript
// Try Gemini, fallback to Copilot if unavailable
const fallbackProvider = new FallbackProvider([
  new GeminiCliProvider(),
  new CopilotCliProvider(),
]);

const integration = new CliIntegration(fallbackProvider, context);
```

### 6. Third-Party Provider Packages

```typescript
// External NPM packages can provide integrations
import { OpenCodeProvider } from "@flightpath/opencode-provider";
import { DeepSeekProvider } from "@community/deepseek-flightpath";

// No FlightPath code changes needed!
const integration = new CliIntegration(new OpenCodeProvider(), context);
```

## Conclusion

This refactoring transforms FlightPath's CLI integration architecture from:

**Inheritance-based monolith** → **Composition-based modular system**

### Key improvements:

1. **Extensibility**: Adding providers goes from 4+ file modifications to 4 isolated files
2. **Maintainability**: Provider code colocated, easy to find and modify
3. **Testability**: Components testable independently, no mocking needed
4. **Safety**: Changes isolated to provider directories, zero cross-provider risk
5. **Clarity**: Interface contracts guide implementation, TypeScript prevents mistakes
6. **Future-proof**: Enables advanced features (plugins, A/B testing, metrics)

### Investment vs Return:

- **Effort**: ~22 hours of focused refactoring
- **Return**:
  - Each new provider: 4 hours instead of 8+ hours
  - Zero risk to existing providers
  - Clear pattern for community contributions
  - Foundation for advanced provider features

The composition-based architecture is the **right long-term solution** for FlightPath's multi-provider vision.

---

**Ready to implement?** Start with Phase 1 (create interfaces) and validate the approach before committing to full migration.
