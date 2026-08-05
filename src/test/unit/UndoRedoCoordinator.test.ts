import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as Diff from "diff";
import { suite, test } from "mocha";
import { UndoRedoCoordinator } from "../../ui/UndoRedoCoordinator";
import {
  FINAL_STEP_PHASES,
  MESSAGE_TYPES,
  UNDO_FILE_ACTIONS,
} from "../../types/DashboardConstants";
import type { PostMessageFn } from "../../ui/WebviewSettingsSync";
import type { UnifiedDiffHunk } from "../../types/CliOutputTypes";

suite("UndoRedoCoordinator", function () {
  this.timeout(10_000);

  test("undoes two edits to one file and redoes them as a round trip", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-undo-coordinator-")
    );
    try {
      const filePath = path.join(workspaceRoot, "shared.txt");
      const beforeWorkflow = "base\n";
      const afterFirstStep = "first\n";
      const afterSecondStep = "second\n";
      await fs.writeFile(filePath, afterSecondStep, "utf8");

      const firstPatch = Diff.structuredPatch(
        "shared.txt",
        "shared.txt",
        beforeWorkflow,
        afterFirstStep
      ).hunks as UnifiedDiffHunk[];
      const secondPatch = Diff.structuredPatch(
        "shared.txt",
        "shared.txt",
        afterFirstStep,
        afterSecondStep
      ).hunks as UnifiedDiffHunk[];
      const targetOne = {
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 0,
      } as const;
      const targetTwo = {
        kind: FINAL_STEP_PHASES.QUEUE,
        stepIndex: 1,
      } as const;
      const postMessage = (() => undefined) as PostMessageFn;
      const coordinator = new UndoRedoCoordinator(() => undefined);

      await coordinator.handleUndoWorkflowChanges(
        {
          type: MESSAGE_TYPES.UNDO_WORKFLOW_CHANGES,
          data: {
            requestId: "undo-round-trip",
            workspacePath: workspaceRoot,
            entries: [
              {
                target: targetTwo,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
                    structuredPatch: secondPatch,
                  },
                ],
              },
              {
                target: targetOne,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.REVERSE_PATCH,
                    structuredPatch: firstPatch,
                  },
                ],
              },
            ],
          },
        },
        postMessage
      );
      assert.strictEqual(await fs.readFile(filePath, "utf8"), beforeWorkflow);

      await coordinator.handleRedoWorkflowChanges(
        {
          type: MESSAGE_TYPES.REDO_WORKFLOW_CHANGES,
          data: {
            requestId: "redo-round-trip",
            workspacePath: workspaceRoot,
            entries: [
              {
                target: targetOne,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
                    contentToRestore: afterFirstStep,
                    structuredPatch: firstPatch,
                  },
                ],
              },
              {
                target: targetTwo,
                files: [
                  {
                    path: "shared.txt",
                    action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
                    contentToRestore: afterSecondStep,
                    structuredPatch: secondPatch,
                  },
                ],
              },
            ],
          },
        },
        postMessage
      );
      assert.strictEqual(await fs.readFile(filePath, "utf8"), afterSecondStep);
    } finally {
      await fs.rm(workspaceRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });
});
