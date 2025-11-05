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
  resumeSession?: string;
  allowedTools?: string[];
  deniedTools?: string[];
}

export interface CopilotCliResult {
  success: boolean;
  response: string;
  statistics: string;
  error?: string;
  exitCode?: number;
}

export interface CopilotCliStatistics {
  usageEstimate: string;
  apiDuration: string;
  wallDuration: string;
  codeChanges: string;
  modelUsage?: string;
}
