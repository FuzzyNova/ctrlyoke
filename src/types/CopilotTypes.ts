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
