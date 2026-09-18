import * as fs from "fs/promises";
import { WorkflowOrchestrator } from "../../../core/WorkflowOrchestrator";
import { WorkingFileManager } from "../../../core/WorkingFileManager";
import { WorkflowLineageRepository } from "../../../core/orchestration/WorkflowLineageRepository";
import * as WorkflowPaths from "../../../utils/WorkflowPaths";
import {
  EXECUTION_STATES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "../../../types/DashboardConstants";
import { WebviewSettingsSync } from "../../../ui/WebviewSettingsSync";
import type {
  WorkflowKey,
  RunRef,
  WorkflowStep,
  PromptStep,
} from "../../../types/CtrlYokeTypes";
import type { WorkflowDefinitionMutation } from "../../../types/WebviewMessageTypes";

/**
 * Message-contract integration harness for the property/prompt round trip.
 *
 * These helpers drive the *real* extension-side persistence pipeline
 * (`prepare*Mutation` -> `WebviewSettingsSync` -> `WorkflowOrchestrator` ->
 * `WorkingFileManager` -> disk) using the exact `postMessage` payloads the
 * `WorkflowPropertiesPanel`/`PropertiesDrawer` components emit. No React, no
 * browser, and — for an idle promoted run — no real `WorkflowInstance`: the
 * run-addressed writes take the static `WorkingFileManager.*AtRun` path.
 *
 * See `dev/backlog/UI_EXTENSION_INTEGRATION_TESTS_PLAN.md` for the rationale.
 */

/**
 * Reproduce the `vscode.postMessage` boundary: the real webview bridge
 * structured-clones/serializes the payload, dropping `undefined` (including
 * nested `undefined` inside object values). Passing objects straight through
 * by reference would be more permissive than production, so route values
 * through the same lossy hop the wire imposes.
 */
function wire<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const TEST_CLIENT_ID = "panel";
const VIEW_ONLY_INSTANCE_ID = "view-only-instance";
/** A workflowKey that never matches the run under test, so the seeded instance
 * keeps the run "idle" (static write path) yet still answers getQueueState. */
const VIEW_ONLY_KEY = "__view_only__" as WorkflowKey;

export interface PromotedRun {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  workingFilePath: string;
}

/** Parsed run definition head (`workflow.ctrlyoke.json`), as raw JSON. */
export type RunDefinition = Record<string, unknown> & {
  steps?: Array<Record<string, unknown>>;
  finalStep?: Record<string, unknown>;
  definitionRevision?: number;
};

/**
 * Build a lineage and promote a single run whose definition head is `steps`
 * (+ optional `finalStep`). Returns stable addressing to the promoted run.
 */
export async function createPromotedRun(
  workspace: string,
  options: {
    nameHint?: string;
    workflowName?: string;
    steps: WorkflowStep[];
  }
): Promise<PromotedRun> {
  const steps = options.steps;
  const manager = new WorkingFileManager({
    getWorkingFilePath: () => undefined,
    getSteps: () => steps,
    getCurrentIndex: () => 0,
    getStatus: () => EXECUTION_STATES.COMPLETED,
    getDefinitionRevision: () => 1,
    setDefinitionRevision: () => undefined,
    getWorkflowName: () => options.workflowName ?? "Round Trip",
    mergeDiskSteps: () => [],
    emitStateChange: () => undefined,
    getFinalStepRuntime: () => undefined,
    updateWorkflowProperty: () => undefined,
  });

  const { workflowKey } = await manager.createWorkingFile(
    options.nameHint ?? "round-trip",
    steps,
    workspace,
    options.workflowName ?? "Round Trip"
  );
  const promoted = await manager.promoteToNewRun(
    workspace,
    workflowKey,
    Date.now()
  );

  return {
    workflowKey,
    runRef: promoted.runRef,
    workingFilePath: promoted.workingFilePath,
  };
}

export interface RoundTripHarness {
  /** Messages posted back to the "client" (fake `postMessage`). */
  readonly sentMessages: Array<Record<string, unknown>>;
  /** Mirrors `WebviewMessageRouter.handleUpdateWorkflowProperty`. */
  routeWorkflowPropertyUpdate(property: string, value: unknown): Promise<void>;
  /** Same, but with a caller-supplied mutation (for stale-revision tests). */
  routeWorkflowPropertyUpdateWith(
    mutation: WorkflowDefinitionMutation,
    property: string,
    value: unknown
  ): Promise<void>;
  /** Mirrors `WebviewMessageRouter.handleUpdateWorkflowProperties`. */
  routeWorkflowPropertiesUpdate(
    properties: Record<string, unknown>
  ): Promise<void>;
  /** Mirrors `WebviewMessageRouter.handleUpdatePrompt`. */
  routeUpdatePrompt(message: {
    index: number;
    text: string;
    properties?: unknown;
    promptName?: string;
    clearProperties?: string[];
  }): Promise<void>;
  /** Mirrors `WebviewMessageRouter.handleUpdateFinalStep`. */
  routeUpdateFinalPrompt(message: {
    finalStep: WorkflowStep | null;
    clearProperties?: string[];
  }): Promise<void>;
  /**
   * Rewrite the run definition head in place, leaving `definitionRevision`
   * untouched. Models a hand-authored or CLI-authored workflow: the file
   * already contains properties no dashboard gesture put there. Seeding this
   * way (rather than through a route) keeps the seed itself out of the code
   * paths under test.
   */
  patchRunDefinition(
    mutate: (definition: RunDefinition) => void
  ): Promise<void>;
  /** The live `{ address, expectedDefinitionRevision, expectedDescriptorRevision }`
   * a client would echo — read fresh from disk. */
  currentMutationContext(): Promise<WorkflowDefinitionMutation>;
  /** Parse the promoted run's current definition head. */
  readRunDefinition(): Promise<RunDefinition>;
  /** Build a mutation with a deliberately stale definition revision. */
  staleMutationContext(): Promise<WorkflowDefinitionMutation>;
}

/**
 * Seed a lightweight orchestrator bound to `run`, wire a real
 * `WebviewSettingsSync`, and expose router-shaped routing helpers.
 */
export function createRoundTripHarness(
  workspace: string,
  run: PromotedRun
): RoundTripHarness {
  const repository = new WorkflowLineageRepository();
  const sentMessages: Array<Record<string, unknown>> = [];
  const fakePost = (message: unknown) => {
    sentMessages.push(message as Record<string, unknown>);
  };

  const orchestrator = Object.create(
    WorkflowOrchestrator.prototype
  ) as WorkflowOrchestrator;
  const internal = orchestrator as unknown as Record<string, unknown>;
  internal.currentWorkspaceFolderPath = workspace;
  internal.lineageRepository = repository;
  internal.viewerRegistry = new Map<string, string>([
    [TEST_CLIENT_ID, VIEW_ONLY_INSTANCE_ID],
  ]);
  internal.viewAddressRegistry = new Map([
    [
      TEST_CLIENT_ID,
      {
        workflowKey: run.workflowKey,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
        runRef: run.runRef,
      },
    ],
  ]);
  internal.viewMessageSinks = new Map();
  internal.lineageBindingClients = new Set<string>();
  internal.retiredInstances = new Map();
  internal.externalRunSessions = new Map();
  // A benign resident instance for an *unrelated* lineage keeps the run under
  // test idle (static write path) while giving getQueueState() a clean answer
  // so the settings-sync republish can actually post.
  internal.instances = new Map<string, unknown>([
    [
      VIEW_ONLY_INSTANCE_ID,
      {
        id: VIEW_ONLY_INSTANCE_ID,
        getQueueState: () => ({ workflowKey: VIEW_ONLY_KEY }),
        getExecutionRunRef: () => undefined,
        expectDefinitionRevision: () => undefined,
      },
    ],
  ]);
  internal.loadFreshInstanceAndReplay = async () => {
    throw new Error("An idle run edit must not fork a draft / new instance");
  };

  const settingsSync = new WebviewSettingsSync(fakePost, () => orchestrator);

  const runFilePath = () =>
    WorkflowPaths.runFilePath(workspace, run.workflowKey, run.runRef);

  const readRunDefinition = async (): Promise<RunDefinition> =>
    JSON.parse(await fs.readFile(runFilePath(), "utf8")) as RunDefinition;

  const currentMutationContext =
    async (): Promise<WorkflowDefinitionMutation> => {
      const [definition, descriptor] = await Promise.all([
        readRunDefinition(),
        repository.readDescriptor(workspace, run.workflowKey),
      ]);
      return {
        address: {
          workflowKey: run.workflowKey,
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
          runRef: run.runRef,
        },
        expectedDefinitionRevision: definition.definitionRevision ?? 1,
        expectedDescriptorRevision: descriptor.revision,
      };
    };

  const staleMutationContext =
    async (): Promise<WorkflowDefinitionMutation> => {
      const fresh = await currentMutationContext();
      return {
        ...fresh,
        expectedDefinitionRevision: fresh.expectedDefinitionRevision - 1,
      };
    };

  return {
    sentMessages,
    readRunDefinition,
    currentMutationContext,
    staleMutationContext,
    async routeWorkflowPropertyUpdate(property, value) {
      await this.routeWorkflowPropertyUpdateWith(
        await currentMutationContext(),
        property,
        value
      );
    },
    async routeWorkflowPropertyUpdateWith(mutation, property, value) {
      await orchestrator.prepareWorkflowPropertiesMutation(
        mutation,
        TEST_CLIENT_ID
      );
      await settingsSync.handleUpdateWorkflowProperty(
        mutation,
        property,
        wire(value),
        fakePost,
        TEST_CLIENT_ID
      );
    },
    async routeWorkflowPropertiesUpdate(properties) {
      const mutation = await currentMutationContext();
      await orchestrator.prepareWorkflowPropertiesMutation(
        mutation,
        TEST_CLIENT_ID
      );
      await settingsSync.handleUpdateWorkflowProperties(
        mutation,
        wire(properties),
        fakePost,
        TEST_CLIENT_ID
      );
    },
    async routeUpdatePrompt(message) {
      const wired = wire(message);
      const mutation = await currentMutationContext();
      await orchestrator.prepareDefinitionMutation(mutation, TEST_CLIENT_ID);
      await orchestrator.updatePromptInQueue(
        mutation,
        wired.index,
        wired.text,
        wired.properties,
        wired.promptName,
        wired.clearProperties,
        TEST_CLIENT_ID
      );
    },
    async routeUpdateFinalPrompt(message) {
      const wired = wire(message);
      const mutation = await currentMutationContext();
      await orchestrator.prepareDefinitionMutation(mutation, TEST_CLIENT_ID);
      await orchestrator.updateFinalStepInQueue(
        mutation,
        wired.finalStep as PromptStep | null,
        wired.clearProperties,
        TEST_CLIENT_ID
      );
    },
    async patchRunDefinition(mutate) {
      const definition = await readRunDefinition();
      mutate(definition);
      await fs.writeFile(
        runFilePath(),
        JSON.stringify(definition, null, 2),
        "utf8"
      );
    },
  };
}
