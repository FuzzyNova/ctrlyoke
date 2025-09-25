export interface PromptFile {
  prompt?: string;
  prompts?: PromptItem[];
  context?: ContextConfig;
}

export interface PromptItem {
  prompt: string;
  endCondition?: EndCondition;
  context?: ContextConfig;
}

export interface EndCondition {
  script: string;
  returns: string;
  timeout?: number;
}

export interface ContextConfig {
  includeCurrentFile?: boolean;
  includeSelection?: boolean;
  includeWorkspaceFiles?: string[];
}

export interface QueueState {
  currentIndex: number;
  status: "idle" | "running" | "paused" | "completed" | "error";
  prompts: PromptItem[];
  results: PromptResult[];
}

export interface PromptResult {
  prompt: string;
  status: "pending" | "sent" | "completed" | "failed";
  timestamp: Date;
  endConditionResult?: boolean;
  error?: string;
}