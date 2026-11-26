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
import type {
  SubWorkflowHost,
  SubWorkflowInstanceOptions,
} from "../types/SubWorkflowTypes";

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

/**
 * What a CLI child instance is built with: the parent's dependencies, minus a
 * PTY for a concurrent child (R5) and minus the parent's `--session-id`
 * override, which applies to the top-level workflow only.
 */
export function resolveCliSubWorkflowInstanceConfig(
  dependencies: CliWorkflowInstanceDependencies,
  options: SubWorkflowInstanceOptions,
  subWorkflowHost: SubWorkflowHost
): {
  dependencies: CliWorkflowInstanceDependencies;
  executionOptions: WorkflowInstanceExecutionOptions;
} {
  return {
    dependencies: {
      ...dependencies,
      hostCanProvidePty: options.concurrent
        ? false
        : dependencies.hostCanProvidePty,
      workflowSessionIdFromOverride: false,
    },
    executionOptions: {
      subWorkflowHost,
      ancestorPaths: options.ancestorPaths,
      delegationChain: options.delegationChain,
    },
  };
}

export function createCliSubWorkflowInstance(
  dependencies: CliWorkflowInstanceDependencies,
  options: SubWorkflowInstanceOptions,
  subWorkflowHost: SubWorkflowHost
): WorkflowInstance {
  const config = resolveCliSubWorkflowInstanceConfig(
    dependencies,
    options,
    subWorkflowHost
  );
  return createCliWorkflowInstance(
    config.dependencies,
    config.executionOptions
  );
}
