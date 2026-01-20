import * as vscode from "vscode";

export interface CopilotChatRequest {
  prompt: string;
}

export interface CopilotChatResponse {
  content: string;
  timestamp: Date;
  success: boolean;
  error?: string;
}

export interface CopilotIntegration {
  sendMessage(request: CopilotChatRequest): Promise<CopilotChatResponse>;
  isAvailable(): boolean;
}

/**
 * CLI-specific types
 */
export interface CopilotCliOptions {
  addDirs?: string[];
  model?: string;
  agent?: string; // Custom agent name (CLI mode only)
  resumeSession?: string;
  // Tool permissions (per-prompt override)
  allowedTools?: string[];
  deniedTools?: string[];
  // Logging (per-prompt override)
  logLevel?: string;
  logDir?: string;
  // Advanced options (future use)
  mcpConfig?: string;
  disableParallelTools?: boolean;
  noCustomInstructions?: boolean;
}

/**
 * Generic CLI result interface used by ALL CLI providers
 * (Copilot, Claude, Codex, etc.)
 */
export interface CliResult {
  success: boolean;
  response: string;
  statistics: string;
  error?: string;
  exitCode?: number;
  sessionId?: string;
  codeChanges?: string;
  modelUsage?: string;
}
