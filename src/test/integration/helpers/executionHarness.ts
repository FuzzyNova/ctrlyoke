import { WorkflowInstance } from "../../../core/WorkflowInstance";
import {
  MockHarnessIntegration,
  MockIntegrationFactory,
  MockPlatform,
} from "../../helpers/mockHarness";

/**
 * Full-flow execution harness: a real `WorkflowInstance` over a temp
 * workspace with a no-op mock harness.
 *
 * The entire production pipeline runs — prompt-file parse, draft working
 * file creation, run promotion, the executor loop, pre/end-condition
 * evaluation, history/timeline persistence — but `sendPrompt` never spawns
 * a CLI: the mock records the prompt text and immediately echoes a canned
 * response. Tests assert on `integration.sentPrompts` (which prompts reached
 * the harness, or that none did) plus on-disk side effects.
 */
export interface ExecutionHarness {
  instance: WorkflowInstance;
  /** The single recording integration every createForExecution() returns. */
  integration: MockHarnessIntegration;
  /**
   * Await pending fire-and-forget work (search-index refresh) and dispose the
   * instance. Must complete before the temp workspace is deleted, or the
   * background refresh races the rmdir (ENOENT/ENOTEMPTY on Windows).
   */
  dispose(): Promise<void>;
}

export function createExecutionHarness(workspace: string): ExecutionHarness {
  const platform = new MockPlatform(workspace);
  const integration = new MockHarnessIntegration(undefined, false);
  // Separate detector instance: pre-flight status checks must not pollute
  // the execution integration's recorded state.
  const detector = new MockHarnessIntegration(undefined, false);

  const instance = new WorkflowInstance(
    platform,
    undefined, // no dashboard sink — assertions read disk + the mock integration
    new MockIntegrationFactory(platform, integration),
    () => detector,
    () => {},
    () => {},
    workspace
  );

  return {
    instance,
    integration,
    dispose: async () => {
      await instance.outputHistoryManager.flushPendingIndexRefresh();
      instance.dispose();
    },
  };
}
