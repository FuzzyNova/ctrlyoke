import * as vscode from 'vscode';

export interface CopilotChatRequest {
  prompt: string;
  context?: CopilotContext;
}

export interface CopilotChatResponse {
  content: string;
  timestamp: Date;
  success: boolean;
  error?: string;
}

export interface CopilotContext {
  activeDocument?: vscode.TextDocument;
  selection?: vscode.Selection;
  workspaceFiles?: string[];
}

export interface CopilotIntegration {
  sendMessage(request: CopilotChatRequest): Promise<CopilotChatResponse>;
  isAvailable(): boolean;
  getContext(): Promise<CopilotContext>;
}