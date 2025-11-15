/**
 * Copilot integration mode
 */
export enum CopilotIntegrationMode {
  CLI = "cli",
  Chat = "chat",
}

export interface PromptFile {
  prompt?: string;
  prompts?: PromptItem[];
}

export interface PromptItem {
  prompt: string;
  model?:
    | "claude-sonnet-4.5"
    | "claude-sonnet-4"
    | "claude-haiku-4.5"
    | "gpt-5";
  endCondition?: EndCondition;
}

export interface EndCondition {
  script: string;
  returns: string;
  timeout?: number;
  maxRetries?: number; // Maximum number of retry attempts (default: 0)
  retryPrompt?: string; // Template with placeholders for retry messages
}

export interface QueueState {
  currentIndex: number;
  status: "idle" | "running" | "paused" | "completed" | "error";
  prompts: PromptItem[];
  results: PromptResult[];
  stopped: boolean; // True if stop() was called, reset on new execution
}

export interface PromptResult {
  prompt: string;
  status: "pending" | "sent" | "completed" | "failed" | "cancelled";
  timestamp: Date;
  endConditionResult?: boolean;
  error?: string;
  retryCount?: number; // Track retry attempts for this prompt
  scriptOutput?: string; // Capture last script output for debugging
}
