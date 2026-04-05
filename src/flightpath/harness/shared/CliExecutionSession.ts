import type {
  CliResult,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import type { PromptStep } from "../../../types/FlightPathTypes";
import type { WorkflowContext } from "../../../types/WorkflowContextTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import type { CollectedHeadlessResponse } from "./CliResponseCollector";

export interface CliExecutionSessionParams {
  prompt: PromptStep;
  workflowContext?: WorkflowContext;
  resolvedProperties?: ResolvedProperties;
  resolvedSessionId?: string;
  executionStartTime?: Date;
}

export interface CliExecutionSessionSnapshot {
  cliCommand?: string;
  parsedOutput?: UniversalCliOutput;
  result?: CliResult;
}

export class CliExecutionSession {
  readonly prompt: PromptStep;
  readonly workflowContext?: WorkflowContext;
  readonly resolvedProperties?: ResolvedProperties;
  readonly resolvedSessionId?: string;
  readonly executionStartTime: Date;

  private promptText: string;
  private tempFiles: string[] = [];
  private actualPromptSentText?: string;
  private command?: string;
  private parsed?: UniversalCliOutput;
  private cliResult?: CliResult;
  private extractedSessionIdValue?: string;

  constructor(params: CliExecutionSessionParams) {
    this.prompt = params.prompt;
    this.workflowContext = params.workflowContext;
    this.resolvedProperties = params.resolvedProperties;
    this.resolvedSessionId = params.resolvedSessionId;
    this.executionStartTime = params.executionStartTime ?? new Date();
    this.promptText = params.prompt.prompt;
  }

  preparePrompt(promptArgument: string, tempFilePaths: string[]): void {
    this.promptText = promptArgument;
    this.tempFiles = [...tempFilePaths];
  }

  recordCommandPrepared(info: {
    promptArgument: string;
    cliCommand: string;
  }): void {
    this.actualPromptSentText = info.promptArgument;
    this.command = info.cliCommand;
  }

  recordHeadlessResponse(collected: CollectedHeadlessResponse): void {
    this.parsed = collected.parsedOutput;
    this.cliResult = collected.cliResult;
    if (collected.extractedSessionId) {
      this.extractedSessionIdValue = collected.extractedSessionId;
    }
  }

  updateParsedOutput(parsedOutput: UniversalCliOutput | undefined): void {
    this.parsed = parsedOutput;
  }

  updateResult(result: CliResult | undefined): void {
    this.cliResult = result;
  }

  setExtractedSessionId(sessionId: string | undefined): void {
    if (sessionId) {
      this.extractedSessionIdValue = sessionId;
    }
  }

  get promptArgument(): string {
    return this.promptText;
  }

  get tempFilePaths(): string[] {
    return [...this.tempFiles];
  }

  get promptForSessionLog(): string {
    return this.actualPromptSentText ?? this.promptText;
  }

  get parsedOutput(): UniversalCliOutput | undefined {
    return this.parsed;
  }

  get result(): CliResult | undefined {
    return this.cliResult;
  }

  get cliCommand(): string | undefined {
    return this.command;
  }

  get effectiveSessionId(): string | undefined {
    return this.extractedSessionIdValue ?? this.resolvedSessionId;
  }

  toSnapshot(): CliExecutionSessionSnapshot {
    return {
      cliCommand: this.command,
      parsedOutput: this.parsed,
      result: this.cliResult,
    };
  }
}
