import * as assert from "assert";
import { suite, test } from "mocha";
import {
  DashboardBroadcastHub,
  type DashboardClient,
} from "../../ui/DashboardBroadcastHub";
import type { WorkflowSummary } from "../../types/CtrlYokeTypes";
import type { CliOutput } from "../../types/WebviewMessageTypes";
import type { HarnessId } from "../../types/DashboardConstants";
import type { HarnessAvailabilityReport } from "../../types/WebviewMessageTypes";

suite("DashboardBroadcastHub", () => {
  test("forwards parallelGroups to registered clients", () => {
    const hub = new DashboardBroadcastHub();
    let receivedParallelGroups: unknown;
    const client: DashboardClient = {
      notifyWorkflowAdded: (_summary: WorkflowSummary) => undefined,
      notifyWorkflowDismissed: (_workflowId: string) => undefined,
      notifyWorkflowSummaryUpdated: (_summary: WorkflowSummary) => undefined,
      notifyActiveWorkflowChanged: (_workflowId: string) => undefined,
      notifyCliWatchOutput: (
        _workflowId: string,
        _stepIndex: number,
        _output: CliOutput
      ) => undefined,
      notifyCliPromptsExtended: (
        _workflowId: string,
        _steps: any[],
        _definitionRevision?: number,
        _parallelGroups?: any[]
      ) => undefined,
      notifyHarnessAvailability: (
        _harnessId: HarnessId,
        _report: HarnessAvailabilityReport
      ) => undefined,
      postMessage: (_message: unknown) => undefined,
      updateStepsExtended: (
        _steps: any[],
        _finalStep,
        _executionState,
        _definitionRevision,
        _workflowId,
        parallelGroups
      ) => {
        receivedParallelGroups = parallelGroups;
      },
    };
    hub.addClient(client);

    const parallelGroups = [
      { id: "group-1", startIndex: 0, endIndex: 1, failFast: true },
    ];
    hub.updateStepsExtended(
      [],
      null,
      undefined,
      3,
      "workflow-1",
      parallelGroups
    );

    assert.deepStrictEqual(receivedParallelGroups, parallelGroups);
  });
});
