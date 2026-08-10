import type { IHarnessUsageProvider } from "../IHarnessUsageProvider";
import { AntigravityUsageProvider } from "./AntigravityUsageProvider";
import { ClaudeUsageProvider } from "./ClaudeUsageProvider";
import { CodexUsageProvider } from "./CodexUsageProvider";
import { CopilotUsageProvider } from "./CopilotUsageProvider";
import { OpenCodeUsageProvider } from "./OpenCodeUsageProvider";
import { QwenUsageProvider } from "./QwenUsageProvider";

export function createDefaultHarnessUsageProviders(): IHarnessUsageProvider[] {
  return [
    new CopilotUsageProvider(),
    new ClaudeUsageProvider(),
    new CodexUsageProvider(),
    new OpenCodeUsageProvider(),
    new QwenUsageProvider(),
    new AntigravityUsageProvider(),
  ];
}

export {
  AntigravityUsageProvider,
  ClaudeUsageProvider,
  CodexUsageProvider,
  CopilotUsageProvider,
  OpenCodeUsageProvider,
  QwenUsageProvider,
};
