import type { IHarnessQuotaCollector } from "../IHarnessQuotaCollector";
import { AntigravityQuotaCollector } from "./AntigravityQuotaCollector";
import { ClaudeQuotaCollector } from "./ClaudeQuotaCollector";
import { CodexQuotaCollector } from "./CodexQuotaCollector";
import { CopilotQuotaCollector } from "./CopilotQuotaCollector";
import { OpenCodeQuotaCollector } from "./OpenCodeQuotaCollector";
import { QwenQuotaCollector } from "./QwenQuotaCollector";

export function createDefaultHarnessQuotaCollectors(): IHarnessQuotaCollector[] {
  return [
    new CopilotQuotaCollector(),
    new ClaudeQuotaCollector(),
    new CodexQuotaCollector(),
    new OpenCodeQuotaCollector(),
    new QwenQuotaCollector(),
    new AntigravityQuotaCollector(),
  ];
}
