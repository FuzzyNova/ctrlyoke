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
import {
  EXECUTION_MODES,
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  PROMPT_TERMINAL_STATUS,
  RUNNER_IDS,
  STEP_TYPES,
} from "../../types/DashboardConstants";
import {
  SUB_WORKFLOW_SOURCE_KINDS,
  type SubWorkflowHandle,
  type SubWorkflowHost,
} from "../../types/SubWorkflowTypes";
import { SubWorkflowLauncher } from "../../core/orchestration/SubWorkflowLauncher";
import type { WorkflowInstance } from "../../core/WorkflowInstance";
import {
  isScriptStep,
  type RunRef,
  type WorkflowKey,
} from "../../types/CtrlYokeTypes";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

class UnusedSubWorkflowHost implements SubWorkflowHost {
  async launch(): Promise<SubWorkflowHandle> {
    throw new Error("unused");
  }
}

function makeDependencies(workspace?: string): CliWorkflowInstanceDependencies {
  const platform = new MockPlatform(workspace);
  return {
    platform,
    integrationFactory: new MockIntegrationFactory(platform),
    detectorIntegration: new MockHarnessIntegration(undefined, false),
    workspaceFolderPath: workspace ?? process.cwd(),
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

  test("a concurrent child launched through the CLI factory runs its interactive step headless (R5)", async () => {
    const workspace = makeTempDir("ctrlyoke-cli-concurrent-child-");
    const children: WorkflowInstance[] = [];
    try {
      const dependencies = makeDependencies(workspace);
      let launcher: SubWorkflowLauncher;
      launcher = new SubWorkflowLauncher((options) => {
        const child = createCliSubWorkflowInstance(
          dependencies,
          options,
          launcher
        );
        children.push(child);
        return child;
      });
      const handle = await launcher.launch({
        source: {
          kind: SUB_WORKFLOW_SOURCE_KINDS.INLINE,
          definition: {
            steps: [
              {
                type: STEP_TYPES.SCRIPT,
                script: "node --version",
                executionMode: EXECUTION_MODES.INTERACTIVE,
              },
            ],
          },
          displayName: "Lane",
          parentDefinition: {},
        },
        parent: {
          workflowKey: "parent-key" as WorkflowKey,
          runRef: "run-parent" as RunRef,
          phase: FINAL_STEP_PHASES.QUEUE,
          stepId: "lane",
        },
        parentExecution: {
          executionRoot: workspace,
          executionCheckoutRoot: workspace,
        },
        delegationChain: [],
        stateRoot: workspace,
        concurrent: true,
      });
      const result = await handle.done;

      assert.strictEqual(result.status, PROMPT_TERMINAL_STATUS.COMPLETED);
      const child = children[0]!;
      assert.strictEqual(
        child.promptQueue.getState().status,
        EXECUTION_STATES.COMPLETED
      );
      const step = child.promptQueue.getState().steps[0];
      assert.ok(step && isScriptStep(step));
      assert.strictEqual(
        step._runtime?.executionMode,
        EXECUTION_MODES.HEADLESS
      );
    } finally {
      for (const child of children) {
        await child.outputHistoryManager.flushPendingIndexRefresh();
        child.dispose();
      }
      removeTempDir(workspace);
    }
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
