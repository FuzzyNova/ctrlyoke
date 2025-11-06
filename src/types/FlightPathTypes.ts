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
