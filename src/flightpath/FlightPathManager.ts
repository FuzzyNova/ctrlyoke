import * as vscode from "vscode";
import {
  QueueState,
  Harness,
  WorkingFile,
  WorkflowSummary,
} from "../types/FlightPathTypes";
import {
  type ActionType,
  type QueuePosition,
} from "../types/DashboardConstants";
import { FlightPathWebviewProvider } from "../ui/FlightPathWebviewProvider";
import { OutputHistoryManager } from "./orchestration/OutputHistoryManager";
import { WorkflowOrchestrator } from "./WorkflowOrchestrator";

/**
 * FlightPathManager — Thin Shell / Facade
 *
 * All behaviour delegates to WorkflowOrchestrator.
 * This class exists purely to preserve the external API surface used by
 * extension.ts, FlightPathWebviewProvider, and any other call-sites that
 * hold a FlightPathManager reference.  No logic lives here.
 *
 * Phase 2 clean-up note: once every call-site has been updated to accept
 * WorkflowOrchestrator directly, this class can be removed.
 */
export class FlightPathManager {
  private readonly orchestrator: WorkflowOrchestrator;

  constructor(
    context: vscode.ExtensionContext,
    dashboardProvider?: FlightPathWebviewProvider
  ) {
    this.orchestrator = new WorkflowOrchestrator(context, dashboardProvider);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    return this.orchestrator.initialize();
  }

  async setDashboardReady(): Promise<void> {
    return this.orchestrator.setDashboardReady();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File load / session management
  // ─────────────────────────────────────────────────────────────────────────

  async loadPromptFile(filePath: string): Promise<void> {
    return this.orchestrator.loadPromptFile(filePath);
  }

  async resumeSession(): Promise<void> {
    return this.orchestrator.resumeSession();
  }

  async loadWorkingFile(filePath: string): Promise<void> {
    return this.orchestrator.loadWorkingFile(filePath);
  }

  async readWorkingFile(workingFilePath: string): Promise<WorkingFile> {
    return this.orchestrator.readWorkingFile(workingFilePath);
  }

  getCurrentPromptFile(): { fileName: string; prompts: unknown[] } | null {
    return this.orchestrator.getCurrentPromptFile();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────────

  async executeLoadedPromptFile(
    modeOverride?: Harness,
    continueFromCurrent: boolean = false
  ): Promise<void> {
    return this.orchestrator.executeLoadedPromptFile(
      modeOverride,
      continueFromCurrent
    );
  }

  async executePromptFile(
    filePath: string,
    modeOverride?: Harness
  ): Promise<void> {
    return this.orchestrator.executePromptFile(filePath, modeOverride);
  }

  async appendFromFile(
    filePath: string,
    position?: QueuePosition
  ): Promise<void> {
    return this.orchestrator.appendFromFile(filePath, position);
  }

  async takeOff(): Promise<void> {
    return this.orchestrator.takeOff();
  }

  async pause(): Promise<void> {
    return this.orchestrator.pause();
  }

  async resume(): Promise<void> {
    return this.orchestrator.resume();
  }

  async stop(): Promise<void> {
    return this.orchestrator.stop();
  }

  async executeEphemeralPrompt(
    text: string,
    properties: unknown,
    action: ActionType,
    promptName?: string,
    forceNewWorkflow: boolean = false
  ): Promise<void> {
    return this.orchestrator.executeEphemeralPrompt(
      text,
      properties,
      action,
      promptName,
      forceNewWorkflow
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Queue / workflow state
  // ─────────────────────────────────────────────────────────────────────────

  getQueueState(): QueueState {
    return this.orchestrator.getQueueState();
  }

  clearWorkflow(): void {
    this.orchestrator.clearWorkflow();
  }

  async updateWorkflowName(workflowName: string): Promise<void> {
    return this.orchestrator.updateWorkflowName(workflowName);
  }

  updateWorkflowPropertyInQueue(property: string, value: unknown): void {
    this.orchestrator.updateWorkflowPropertyInQueue(property, value);
  }

  async updateWorkingFileProperties(
    properties: Record<string, unknown>,
    options: {
      onlyIfUndefined?: boolean;
      ensureHarnessAndModel?: boolean;
      allowDeletes?: boolean;
    } = {}
  ): Promise<{ workingFile: WorkingFile; appliedKeys: string[] } | null> {
    return this.orchestrator.updateWorkingFileProperties(properties, options);
  }

  async updatePromptInQueue(
    index: number,
    text: string,
    properties: unknown
  ): Promise<void> {
    return this.orchestrator.updatePromptInQueue(index, text, properties);
  }

  async deletePromptFromQueue(index: number): Promise<void> {
    return this.orchestrator.deletePromptFromQueue(index);
  }

  async resetWorkflowState(): Promise<void> {
    return this.orchestrator.resetWorkflowState();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // History
  // ─────────────────────────────────────────────────────────────────────────

  getOutputHistoryManager(): OutputHistoryManager {
    return this.orchestrator.getOutputHistoryManager();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Harness / integration status
  // ─────────────────────────────────────────────────────────────────────────

  async retryHarnessDetection(): Promise<void> {
    return this.orchestrator.retryHarnessDetection();
  }

  getHarnessDetailedStatus() {
    return this.orchestrator.getHarnessDetailedStatus();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI / panel commands
  // ─────────────────────────────────────────────────────────────────────────

  async openPanel(): Promise<void> {
    return this.orchestrator.openPanel();
  }

  async createPromptFile(): Promise<void> {
    return this.orchestrator.createPromptFile();
  }

  async openCurrentPromptFile(): Promise<void> {
    return this.orchestrator.openCurrentPromptFile();
  }

  async createDraftPrompt(): Promise<void> {
    return this.orchestrator.createDraftPrompt();
  }

  async createEndConditionScript(): Promise<void> {
    return this.orchestrator.createEndConditionScript();
  }

  async importAgents(): Promise<void> {
    return this.orchestrator.importAgents();
  }

  async importWorkflowTemplates(): Promise<void> {
    return this.orchestrator.importWorkflowTemplates();
  }

  async createNewTemplate(): Promise<void> {
    return this.orchestrator.createNewTemplate();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-workflow registry
  // ─────────────────────────────────────────────────────────────────────────

  switchWorkflow(workflowId: string): void {
    this.orchestrator.setActiveWorkflow(workflowId);
  }

  getWorkflowsList(): WorkflowSummary[] {
    return this.orchestrator.getWorkflowSummaries();
  }

  getActiveWorkflowId(): string | null {
    return this.orchestrator.getActiveWorkflowId();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dispose
  // ─────────────────────────────────────────────────────────────────────────

  dispose(): void {
    this.orchestrator.dispose();
  }
}
