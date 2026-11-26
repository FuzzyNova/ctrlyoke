import * as assert from "assert";
import { suite, test } from "mocha";
import {
  createCliSubWorkflowInstance,
  resolveCliSubWorkflowInstanceConfig,
  type CliWorkflowInstanceDependencies,
} from "../../cli/CliWorkflowInstanceFactory";
import { CompositeUserFeedbackSink } from "../../core/CompositeUserFeedbackSink";
import {
  MockHarnessIntegration,
  MockIntegrationFactory,
  MockPlatform,
} from "../helpers/mockHarness";
import { RUNNER_IDS } from "../../types/DashboardConstants";
import type {
  SubWorkflowHandle,
  SubWorkflowHost,
} from "../../types/SubWorkflowTypes";

class UnusedSubWorkflowHost implements SubWorkflowHost {
  async launch(): Promise<SubWorkflowHandle> {
    throw new Error("unused");
  }
}

function makeDependencies(): CliWorkflowInstanceDependencies {
  const platform = new MockPlatform();
  return {
    platform,
    integrationFactory: new MockIntegrationFactory(platform),
    detectorIntegration: new MockHarnessIntegration(undefined, false),
    workspaceFolderPath: process.cwd(),
    hostCanProvidePty: true,
    supportsConcurrentInteractiveSessions: false,
    userFeedbackSink: new CompositeUserFeedbackSink([]),
    runnerHostIdentity: {
      runner: RUNNER_IDS.CLI,
      hostInstanceId: "test-cli",
      pid: process.pid,
    },
    workflowSessionIdFromOverride: true,
  };
}

suite("createCliSubWorkflowInstance", () => {
  test("disables PTY support for concurrent children only", () => {
    const host = new UnusedSubWorkflowHost();
    const base = {
      ancestorPaths: ["/root", "/child"],
      delegationChain: ["lease-root"],
    };
    const concurrent = resolveCliSubWorkflowInstanceConfig(
      makeDependencies(),
      { ...base, concurrent: true },
      host
    );
    const sequential = resolveCliSubWorkflowInstanceConfig(
      makeDependencies(),
      { ...base, concurrent: false },
      host
    );
    assert.strictEqual(concurrent.dependencies.hostCanProvidePty, false);
    assert.strictEqual(sequential.dependencies.hostCanProvidePty, true);
  });

  test("passes the same host and the ancestor chain, but not --session-id", () => {
    const host = new UnusedSubWorkflowHost();
    const config = resolveCliSubWorkflowInstanceConfig(
      makeDependencies(),
      {
        concurrent: false,
        ancestorPaths: ["/root", "/child"],
        delegationChain: ["lease-root"],
      },
      host
    );
    assert.strictEqual(config.executionOptions.subWorkflowHost, host);
    assert.deepStrictEqual(config.executionOptions.ancestorPaths, [
      "/root",
      "/child",
    ]);
    assert.deepStrictEqual(config.executionOptions.delegationChain, [
      "lease-root",
    ]);
    assert.strictEqual(
      config.dependencies.workflowSessionIdFromOverride,
      false
    );
  });

  test("builds a real instance from the resolved config", () => {
    const child = createCliSubWorkflowInstance(
      makeDependencies(),
      { concurrent: true, ancestorPaths: [], delegationChain: [] },
      new UnusedSubWorkflowHost()
    );
    child.dispose();
  });
});
