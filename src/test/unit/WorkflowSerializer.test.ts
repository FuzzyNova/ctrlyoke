import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { WorkflowSerializer } from "../../ui/WorkflowSerializer";
import { configService } from "../../config/CtrlYokeConfigService";
import { CONFIG_KEYS } from "../../utils/ConfigurationUtils";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";
import type { WorkflowViewAddress } from "../../types/CtrlYokeTypes";
import { WorkflowLineageRepository } from "../../core/orchestration/WorkflowLineageRepository";

/** Minimal in-memory vscode.Memento stub for tests that don't exercise persistence. */
function fakeWorkspaceState(): any {
  const store = new Map<string, unknown>();
  return {
    get: (key: string, defaultValue?: unknown) =>
      store.has(key) ? store.get(key) : defaultValue,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

suite("WorkflowSerializer", () => {
  suite("handleSetDefaultTemplate", () => {
    test("should write general.defaultTemplate and notify the webview", async () => {
      const originalSet = configService.set.bind(configService);
      const setCalls: Array<{ key: string; value: unknown; scope: string }> =
        [];
      const messages: any[] = [];

      try {
        configService.set = (async (key, value, scope) => {
          setCalls.push({ key, value, scope });
        }) as typeof configService.set;

        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () => undefined,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSetDefaultTemplate("blank");

        assert.deepStrictEqual(setCalls, [
          {
            key: CONFIG_KEYS.GENERAL_DEFAULT_TEMPLATE,
            value: "blank",
            scope: "user",
          },
        ]);
        assert.deepStrictEqual(messages, [
          {
            type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
            templateId: "blank",
          },
        ]);
      } finally {
        configService.set = originalSet;
      }
    });
  });

  suite("handleSaveWorkflow", () => {
    test("should persist errorBehavior at workflow and step level", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-serializer-")
      );
      const workingFilePath = path.join(tempDir, "input.ctrlyoke.json");
      const outputPath = path.join(tempDir, "saved.ctrlyoke.json");
      const messages: any[] = [];
      const address = {
        workflowKey: "serializer-test-1",
        kind: "draft",
      } as WorkflowViewAddress;

      try {
        await fs.writeFile(
          workingFilePath,
          JSON.stringify(
            {
              workflowName: "serializer-test",
              startedAt: Date.now(),
              errorBehavior: {
                onError: "retry",
                maxRetries: 2,
                retryDelayMs: 2500,
              },
              steps: [
                {
                  prompt: "Step one",
                  errorBehavior: { onError: "continue" },
                  _runtime: { startedAt: 1 },
                },
              ],
              _runtime: { currentIndex: 0, executionState: "idle" },
            },
            null,
            2
          ),
          "utf8"
        );

        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getQueueState: () => ({ workingFilePath }),
              getViewAddress: () => address,
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflow(
          "save-test",
          address,
          outputPath,
          "json"
        );

        const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
        assert.deepStrictEqual(saved.errorBehavior, {
          onError: "retry",
          maxRetries: 2,
          retryDelayMs: 2500,
        });
        assert.deepStrictEqual(saved.steps[0].errorBehavior, {
          onError: "continue",
        });
        assert.strictEqual(saved.steps[0]._runtime, undefined);
        assert.ok(
          messages.some(
            (message) => message.type === MESSAGE_TYPES.WORKFLOW_SAVED
          )
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  suite("addressed save-path checks", () => {
    test("uses the same workspace containment rules for preflight and final save", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-save-path-")
      );
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      const messages: any[] = [];
      const address = {
        workflowKey: "save-path-test-1",
        kind: "draft",
      } as WorkflowViewAddress;

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "save-path-test",
              index: 0,
            },
          ],
          configurable: true,
        });
        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getViewAddress: () => address,
              getQueueState: () => ({ workingFilePath: "unused" }),
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await fs.mkdir(path.join(workspaceRoot, "exports"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspaceRoot, "exports", "existing.ctrlyoke.yaml"),
          "steps: []\n"
        );

        await serializer.handleCheckSavePath(
          "check-existing",
          "exports/existing.ctrlyoke.yaml",
          address
        );
        assert.deepStrictEqual(messages.pop(), {
          type: MESSAGE_TYPES.SAVE_PATH_CHECKED,
          requestId: "check-existing",
          path: "exports/existing.ctrlyoke.yaml",
          exists: true,
        });

        await serializer.handleCheckSavePath(
          "check-escape",
          "../outside.ctrlyoke.yaml",
          address
        );
        const escaped = messages.pop();
        assert.strictEqual(escaped.type, MESSAGE_TYPES.SAVE_PATH_CHECKED);
        assert.strictEqual(escaped.exists, false);
        assert.match(escaped.error, /inside the open workspace/i);
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    test("rejects a save after the client switches to another address", async () => {
      const messages: any[] = [];
      const current = {
        workflowKey: "workflow-current-1",
        kind: "draft",
      } as WorkflowViewAddress;
      const stale = {
        workflowKey: "workflow-stale-1",
        kind: "draft",
      } as WorkflowViewAddress;
      const serializer = new WorkflowSerializer(
        (message) => messages.push(message),
        {} as any,
        () =>
          ({
            getViewAddress: () => current,
            getQueueState: () => ({ workingFilePath: "unused" }),
          }) as any,
        () => undefined,
        fakeWorkspaceState()
      );

      await serializer.handleCheckSavePath(
        "stale-check",
        "workflow.ctrlyoke.yaml",
        stale
      );
      assert.deepStrictEqual(messages.pop(), {
        type: MESSAGE_TYPES.SAVE_PATH_CHECKED,
        requestId: "stale-check",
        path: "workflow.ctrlyoke.yaml",
        exists: false,
        error: "The viewed workflow changed.",
      });
    });
  });

  suite("addressed save framing", () => {
    test("frames a pending rewind as an intentional run export", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-save-frame-")
      );
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      const messages: any[] = [];

      try {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: [
            {
              uri: vscode.Uri.file(workspaceRoot),
              name: "save-frame-test",
              index: 0,
            },
          ],
          configurable: true,
        });
        const repository = new WorkflowLineageRepository();
        const lineage = await repository.createLineage(
          workspaceRoot,
          "pending-save",
          "Pending save",
          path.join(workspaceRoot, "source.ctrlyoke.yaml")
        );
        const run = await repository.allocateRun(
          workspaceRoot,
          lineage.workflowKey
        );
        const address = {
          workflowKey: lineage.workflowKey,
          kind: "run",
          runRef: run.runRef,
        } as WorkflowViewAddress;
        const startedAt = Date.UTC(2026, 6, 20);
        await fs.writeFile(
          run.stagingRunFilePath,
          JSON.stringify({
            workflowName: "Pending save",
            definitionRevision: 2,
            steps: [],
            _runtime: {
              currentIndex: 0,
              executionState: "completed",
              pendingRewind: {
                fromStepIndex: 1,
                baseDefinitionRevision: 1,
              },
            },
          })
        );
        await fs.writeFile(
          path.join(run.stagingRunDir, "manifest.json"),
          JSON.stringify({
            schemaVersion: "2.2.0",
            storageKind: "timeline",
            workflowId: "test",
            runId: run.runId,
            startedAt,
            executionState: "completed",
            definitionRevision: 2,
            stepCount: 0,
            eventCount: 0,
            nextSequence: 0,
            lastUpdatedAt: startedAt,
          })
        );
        await fs.writeFile(path.join(run.stagingRunDir, "events.jsonl"), "");
        await repository.finalizeAllocatedRun(
          workspaceRoot,
          lineage.workflowKey,
          run
        );
        const serializer = new WorkflowSerializer(
          (message) => messages.push(message),
          {} as any,
          () =>
            ({
              getViewAddress: () => address,
              getQueueState: () => ({ workingFilePath: "unused" }),
            }) as any,
          () => undefined,
          fakeWorkspaceState()
        );

        await serializer.handleSaveWorkflowRequest("save-pending", address);
        const dialog = messages.pop();
        assert.strictEqual(
          dialog.type,
          MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA
        );
        assert.strictEqual(
          dialog.title,
          `Save run ${run.runId} — pending continuation`
        );
        assert.strictEqual(dialog.address.runRef, run.runRef);
        assert.strictEqual(
          dialog.defaultPath,
          path.join(workspaceRoot, "source.ctrlyoke.yaml")
        );
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });
});
