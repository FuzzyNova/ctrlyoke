/**
 * WebviewMessageRouter — client-supplied workflow file paths.
 *
 * Dashboard clients name workflow files by path in two messages: LOAD_WORKFLOW
 * ("Load from File") and APPEND_FILE ("Queue from File"). Neither path is
 * guaranteed absolute — `WorkflowFilePickerModal`'s manual field is documented
 * as workspace-relative — and nothing downstream resolves one: the parser does a
 * bare `fs.readFile`, so a relative path silently resolves against the extension
 * host's cwd. Both handlers must resolve at the transport edge, identically.
 */
import * as assert from "assert";
import * as path from "path";
import { WebviewMessageRouter } from "../../ui/WebviewMessageRouter";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";

function buildRouter(orchestrator: unknown): WebviewMessageRouter {
  const settingsSync = {
    sendWorkflowPropertiesToSettings: async () => {},
  } as any;
  return new WebviewMessageRouter(
    () => {},
    settingsSync,
    {} as any,
    () => orchestrator as any,
    {} as any,
    { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
  );
}

suite("WebviewMessageRouter — client workflow file paths", () => {
  test("LOAD_WORKFLOW resolves a workspace-relative path to an absolute one", async () => {
    const loaded: string[] = [];
    const router = buildRouter({
      loadPromptFileForClient: async (filePath: string) => {
        loaded.push(filePath);
      },
    });

    await router.route({
      type: MESSAGE_TYPES.LOAD_WORKFLOW,
      filePath: "manual-test/pass-retry-test.ctrlyoke.json",
    });

    assert.strictEqual(loaded.length, 1, "the file should have been loaded");
    assert.ok(
      path.isAbsolute(loaded[0]),
      `a relative payload must be resolved before loading, got "${loaded[0]}"`
    );
    assert.ok(
      loaded[0]
        .replace(/\\/g, "/")
        .endsWith("manual-test/pass-retry-test.ctrlyoke.json"),
      `resolution must preserve the requested file, got "${loaded[0]}"`
    );
  });

  test("APPEND_FILE resolves a workspace-relative path to an absolute one", async () => {
    const appended: string[] = [];
    const router = buildRouter({
      appendFromFileForClient: async (_mutation: unknown, filePath: string) => {
        appended.push(filePath);
      },
    });

    await router.route({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath: "manual-test/pass-retry-test.ctrlyoke.json",
    });

    assert.strictEqual(appended.length, 1, "the file should have been queued");
    assert.ok(
      path.isAbsolute(appended[0]),
      `a relative payload must be resolved before queueing, got "${appended[0]}"`
    );
    assert.ok(
      appended[0]
        .replace(/\\/g, "/")
        .endsWith("manual-test/pass-retry-test.ctrlyoke.json"),
      `resolution must preserve the requested file, got "${appended[0]}"`
    );
  });

  test("an absolute path is passed through unchanged by both handlers", async () => {
    const absolute = path.join(
      path.sep === "\\" ? "C:\\tmp" : "/tmp",
      "flows",
      "example.ctrlyoke.yaml"
    );
    const seen: string[] = [];
    const router = buildRouter({
      loadPromptFileForClient: async (filePath: string) => {
        seen.push(filePath);
      },
      appendFromFileForClient: async (_mutation: unknown, filePath: string) => {
        seen.push(filePath);
      },
    });

    await router.route({
      type: MESSAGE_TYPES.LOAD_WORKFLOW,
      filePath: absolute,
    });
    await router.route({
      type: MESSAGE_TYPES.APPEND_FILE,
      filePath: absolute,
    });

    assert.deepStrictEqual(
      seen,
      [absolute, absolute],
      "an already-absolute path must not be rewritten"
    );
  });
});

/**
 * A run-view request the client never gets an answer to is not merely a lost
 * click: while it is outstanding the client suppresses every *requestless*
 * RUN_VIEW_LOADED, so definition mutations from other clients, draft→run
 * promotions, and rewind invalidations all stop landing — and a cross-lineage
 * switch leaves the interaction-blocking WorkflowSwitchOverlay on top of that.
 * Every LOAD_RUN_VIEW must therefore terminate in a reply carrying its
 * requestId, including the paths that decline to do any work.
 */
suite(
  "WebviewMessageRouter — LOAD_RUN_VIEW always answers its requestId",
  () => {
    test("replies with a failure when the orchestrator is not available yet", async () => {
      const emitted: any[] = [];
      const router = new WebviewMessageRouter(
        (message: unknown) => emitted.push(message),
        { sendWorkflowPropertiesToSettings: async () => {} } as any,
        {} as any,
        () => undefined,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address: { workflowKey: "workflow-a", kind: "draft" },
        requestId: "run-view-42",
      });

      const failure = emitted.find(
        (message) => message.type === MESSAGE_TYPES.WORKFLOW_ACTION_FAILED
      );
      assert.ok(
        failure,
        "returning silently leaves the client's request outstanding forever"
      );
      assert.strictEqual(
        failure.requestId,
        "run-view-42",
        "the client retires a pending request only on a matching requestId"
      );
    });

    test("replies with a failure when the addressed view cannot be read", async () => {
      const emitted: any[] = [];
      const router = new WebviewMessageRouter(
        (message: unknown) => emitted.push(message),
        { sendWorkflowPropertiesToSettings: async () => {} } as any,
        {} as any,
        () =>
          ({
            loadRunViewForClient: async () => {
              throw new Error("run directory was pruned");
            },
            publishViewIdentityToViewers: async () => undefined,
          }) as any,
        {} as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
      );

      await router.route({
        type: MESSAGE_TYPES.LOAD_RUN_VIEW,
        address: {
          workflowKey: "workflow-a",
          kind: "run",
          runRef: "run-2026-01-01T00-00-00-000Z",
        },
        requestId: "run-view-43",
      });

      const failure = emitted.find(
        (message) => message.type === MESSAGE_TYPES.WORKFLOW_ACTION_FAILED
      );
      assert.strictEqual(failure?.requestId, "run-view-43");
    });
  }
);
