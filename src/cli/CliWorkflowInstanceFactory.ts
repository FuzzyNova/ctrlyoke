import {
  WorkflowInstance,
  type WorkflowInstanceExecutionOptions,
} from "../core/WorkflowInstance";
import type { IntegrationFactory } from "../core/IntegrationFactory";
import type { HarnessCapabilityRegistry } from "../core/HarnessCapabilityRegistry";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import type { UserFeedbackSink } from "../core/UserFeedbackSink";
import type { HarnessId, RunnerHostIdentity } from "../types/CtrlYokeTypes";
import type { HarnessIntegration } from "../core/HarnessIntegration";
import type { SubWorkflowHost } from "../types/SubWorkflowTypes";

export interface CliWorkflowInstanceDependencies {
  platform: PlatformAdapter;
  integrationFactory: IntegrationFactory;
  detectorIntegration: HarnessIntegration;
  workspaceFolderPath: string;
  hostCanProvidePty: boolean;
  supportsConcurrentInteractiveSessions: boolean;
  userFeedbackSink: UserFeedbackSink;
  runnerHostIdentity: RunnerHostIdentity;
  workflowSessionIdFromOverride: boolean;
  compatibilityRegistry?: HarnessCapabilityRegistry;
}

export function createCliWorkflowInstance(
  dependencies: CliWorkflowInstanceDependencies,
  executionOptions: WorkflowInstanceExecutionOptions = {}
): WorkflowInstance {
  const {
    platform,
    integrationFactory,
    detectorIntegration,
    workspaceFolderPath,
    hostCanProvidePty,
    supportsConcurrentInteractiveSessions,
    userFeedbackSink,
    runnerHostIdentity,
    workflowSessionIdFromOverride,
    compatibilityRegistry,
  } = dependencies;

  return new WorkflowInstance(
    platform,
    undefined,
    integrationFactory,
    (_harnessOverride?: HarnessId) => detectorIntegration,
    () => {},
    () => {},
    workspaceFolderPath,
    hostCanProvidePty,
    supportsConcurrentInteractiveSessions,
    compatibilityRegistry,
    userFeedbackSink,
    undefined,
    undefined,
    undefined,
    runnerHostIdentity,
    undefined,
    workflowSessionIdFromOverride,
    undefined,
    executionOptions
  );
}

export function createCliSubWorkflowInstance(
  dependencies: CliWorkflowInstanceDependencies,
  options: {
    concurrent: boolean;
    ancestorPaths: readonly string[];
    delegationChain: readonly string[];
  },
  subWorkflowHost: SubWorkflowHost
): WorkflowInstance {
  return createCliWorkflowInstance(
    {
      ...dependencies,
      hostCanProvidePty: options.concurrent
        ? false
        : dependencies.hostCanProvidePty,
    },
    {
      subWorkflowHost,
      ancestorPaths: options.ancestorPaths,
      delegationChain: options.delegationChain,
    }
  );
}
