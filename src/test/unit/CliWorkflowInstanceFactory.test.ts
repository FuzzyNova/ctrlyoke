import * as assert from "assert";
import { suite, test } from "mocha";
import {
  createCliSubWorkflowInstance,
  createCliWorkflowInstance,
} from "../../cli/CliWorkflowInstanceFactory";
import type { WorkflowInstanceExecutionOptions } from "../../core/WorkflowInstance";
import { CompositeUserFeedbackSink } from "../../core/CompositeUserFeedbackSink";
import {
  MockHarnessIntegration,
  MockIntegrationFactory,
  MockPlatform,
} from "../helpers/mockHarness";
import { RUNNER_IDS } from "../../types/DashboardConstants";

suite("createCliWorkflowInstance", () => {
  test("disables PTY support for concurrent children", () => {
    const platform = new MockPlatform();
    const dependencies = {
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
      workflowSessionIdFromOverride: false,
    };
    const host = {
      launch: async () => {
        throw new Error("unused");
      },
    };
    const child = createCliWorkflowInstance(dependencies, {
      ancestorPaths: [],
      subWorkflowHost: host,
    });
    const childInstance = createCliSubWorkflowInstance(
      dependencies,
      {
        concurrent: true,
        ancestorPaths: ["/root", "/child"],
        delegationChain: ["lease-root"],
      },
      host
    );
    assert.strictEqual(
      (childInstance as unknown as { hostCanProvidePty: boolean })
        .hostCanProvidePty,
      false
    );
    assert.deepStrictEqual(
      (
        childInstance as unknown as {
          executionOptions: WorkflowInstanceExecutionOptions;
        }
      ).executionOptions.ancestorPaths,
      ["/root", "/child"]
    );
    child.dispose();
    childInstance.dispose();
  });
});
