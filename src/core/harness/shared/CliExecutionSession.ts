import type {
  CliResult,
  UniversalCliOutput,
} from "../../../types/CliOutputTypes";
import type { FailureKind } from "../../../types/CtrlYokeTypes";
import type { PromptStep } from "../../../types/CtrlYokeTypes";
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
  cliCommandSentToRunningTerminal?: boolean;
  parsedOutput?: UniversalCliOutput;
  result?: CliResult;
}

export class CliExecutionSession {
  readonly prompt: PromptStep;
  readonly workflowContext?: WorkflowContext;
  readonly resolvedProperties?: ResolvedProperties;
  readonly executionStartTime: Date;

  private resolvedSessionIdValue?: string;
  private promptText: string;
  private tempFiles: string[] = [];
  private deferredHookEnvironmentFiles: string[] = [];
  private imageFiles: string[] = [];
  private attachedSkillNames?: string[];
  private actualPromptSentText?: string;
  private command?: string;
  private commandSentToRunningTerminal = false;
  private parsed?: UniversalCliOutput;
  private cliResult?: CliResult;
  private extractedSessionIdValue?: string;
  private terminalReusePrepared = false;
  private failureKindValue?: FailureKind;
  private failureMessageValue?: string;

  constructor(params: CliExecutionSessionParams) {
    this.prompt = params.prompt;
    this.workflowContext = params.workflowContext;
    this.resolvedProperties = params.resolvedProperties;
    this.resolvedSessionIdValue = params.resolvedSessionId;
    this.executionStartTime = params.executionStartTime ?? new Date();
    this.promptText = params.prompt.prompt;
  }

  get resolvedSessionId(): string | undefined {
    return this.resolvedSessionIdValue;
  }

  /** Drops a session ID the harness rejected so nothing resumes it again. */
  clearResolvedSessionId(): void {
    this.resolvedSessionIdValue = undefined;
  }

  preparePrompt(
    promptArgument: string,
    tempFilePaths: string[],
    imageFileRefs: readonly string[] = [],
    attachedSkills?: readonly string[]
  ): void {
    this.promptText = promptArgument;
    this.tempFiles = [...tempFilePaths];
    this.imageFiles = [...imageFileRefs];
    this.attachedSkillNames =
      attachedSkills === undefined ? undefined : [...attachedSkills];
    this.terminalReusePrepared = false;
  }

  addTempFilePath(tempFilePath: string): void {
    if (!this.tempFiles.includes(tempFilePath)) {
      this.tempFiles.push(tempFilePath);
    }
  }

  addDeferredHookEnvironmentFilePath(filePath: string): void {
    if (!this.deferredHookEnvironmentFiles.includes(filePath)) {
      this.deferredHookEnvironmentFiles.push(filePath);
    }
  }

  get deferredHookEnvironmentFilePaths(): string[] {
    return [...this.deferredHookEnvironmentFiles];
  }

  markTerminalReusePrepared(): void {
    this.terminalReusePrepared = true;
  }

  get wasTerminalReusePrepared(): boolean {
    return this.terminalReusePrepared;
  }

  recordCommandPrepared(info: {
    promptArgument: string;
    cliCommand: string;
  }): void {
    this.actualPromptSentText = info.promptArgument;
    this.command = info.cliCommand;
    this.commandSentToRunningTerminal = false;
  }

  recordSentPrompt(promptArgument: string): void {
    this.actualPromptSentText = promptArgument;
    this.command = promptArgument;
    this.commandSentToRunningTerminal = true;
  }

  recordHeadlessResponse(collected: CollectedHeadlessResponse): void {
    this.parsed = collected.parsedOutput;
    this.cliResult = collected.cliResult;
    this.failureKindValue = collected.failureKind;
    this.failureMessageValue = collected.failureMessage;
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

  updateFailure(
    failureKind: FailureKind | undefined,
    failureMessage: string | undefined
  ): void {
    this.failureKindValue = failureKind;
    this.failureMessageValue = failureMessage;
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

  get imageFileRefs(): readonly string[] {
    return [...this.imageFiles];
  }

  get attachedSkills(): readonly string[] | undefined {
    return this.attachedSkillNames;
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

  get failureKind(): FailureKind | undefined {
    return this.failureKindValue;
  }

  get failureMessage(): string | undefined {
    return this.failureMessageValue;
  }

  toSnapshot(): CliExecutionSessionSnapshot {
    return {
      cliCommand: this.command,
      cliCommandSentToRunningTerminal:
        this.commandSentToRunningTerminal || undefined,
      parsedOutput: this.parsed,
      result: this.cliResult,
    };
  }
}
