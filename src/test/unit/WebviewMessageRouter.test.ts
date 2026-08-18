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
import * as vscode from "vscode";
import { WebviewMessageRouter } from "../../ui/WebviewMessageRouter";
import {
  MESSAGE_TYPES,
  END_CONDITION_SCRIPT_TYPES,
  USER_FEEDBACK_SEVERITY,
  VSCODE_COMMANDS,
} from "../../types/DashboardConstants";
import { WorkflowVariantService } from "../../core/orchestration/WorkflowVariantService";
import { VsCodeUserFeedbackSink } from "../../platform/VsCodeUserFeedbackSink";

function buildRouter(
  orchestrator: unknown,
  defaultPostMessage: (message: unknown) => void = () => {}
): WebviewMessageRouter {
  const settingsSync = {
    sendWorkflowPropertiesToSettings: async () => {},
  } as any;
  return new WebviewMessageRouter(
    defaultPostMessage,
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

  test("RELOAD_WINDOW invokes VS Code's window reload command", async () => {
    const originalExecuteCommand = vscode.commands.executeCommand;
    const commands: string[] = [];
    vscode.commands.executeCommand = (async (command: string) => {
      commands.push(command);
      return undefined;
    }) as typeof vscode.commands.executeCommand;

    try {
      await buildRouter(undefined).route({
        type: MESSAGE_TYPES.RELOAD_WINDOW,
      });
    } finally {
      vscode.commands.executeCommand = originalExecuteCommand;
    }

    assert.deepStrictEqual(commands, [VSCODE_COMMANDS.RELOAD_WINDOW]);
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

suite("WebviewMessageRouter — native feedback", () => {
  test("delegates each severity to the existing VS Code feedback sink", async () => {
    const calls: string[] = [];
    const sink = new VsCodeUserFeedbackSink({
      showInformationMessage: () => calls.push("info"),
      showWarningMessage: () => calls.push("warning"),
      showErrorMessage: () => calls.push("error"),
    });
    const router = new WebviewMessageRouter(
      () => {},
      { sendWorkflowPropertiesToSettings: async () => {} } as any,
      {} as any,
      () => undefined,
      {} as any,
      {
        handleClearWorkflow: async () => {},
        updateWorkflowName: () => {},
        handleNativeFeedback: (feedback) => sink.notify(feedback),
      }
    );

    for (const [severity, expectedApi] of [
      [USER_FEEDBACK_SEVERITY.INFO, "info"],
      [USER_FEEDBACK_SEVERITY.SUCCESS, "info"],
      [USER_FEEDBACK_SEVERITY.WARNING, "warning"],
      [USER_FEEDBACK_SEVERITY.ERROR, "error"],
    ] as const) {
      await router.route({
        type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
        severity,
        message: "Feedback",
        detail: "More detail",
      });
      assert.strictEqual(calls.at(-1), expectedApi);
    }
  });

  test("ignores malformed feedback payloads", async () => {
    const received: unknown[] = [];
    const router = new WebviewMessageRouter(
      () => {},
      { sendWorkflowPropertiesToSettings: async () => {} } as any,
      {} as any,
      () => undefined,
      {} as any,
      {
        handleClearWorkflow: async () => {},
        updateWorkflowName: () => {},
        handleNativeFeedback: (feedback) => received.push(feedback),
      }
    );

    await router.route({
      type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
      severity: "unknown",
      message: "Feedback",
    });
    await router.route({
      type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
      severity: USER_FEEDBACK_SEVERITY.INFO,
      message: 42,
    });

    assert.deepStrictEqual(received, []);
  });
});

suite("WebviewMessageRouter — end-condition script creation", () => {
  test("delegates to the evaluator and replies only to the initiating client", async () => {
    const created: string[] = [];
    const panelMessages: unknown[] = [];
    const browserMessages: unknown[] = [];
    const router = buildRouter(
      {
        createSampleScript: async (scriptType: string) => {
          created.push(scriptType);
          return ".ctrlyoke/scripts/check_condition.js";
        },
      },
      (message) => panelMessages.push(message)
    );

    await router.route(
      {
        type: MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT,
        requestId: "create-1",
        scriptType: END_CONDITION_SCRIPT_TYPES.JAVASCRIPT,
      },
      {
        clientTag: "browser:1",
        postMessage: (message: unknown) => browserMessages.push(message),
      }
    );

    assert.deepStrictEqual(created, [END_CONDITION_SCRIPT_TYPES.JAVASCRIPT]);
    assert.deepStrictEqual(browserMessages, [
      {
        type: MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATED,
        requestId: "create-1",
        scriptPath: ".ctrlyoke/scripts/check_condition.js",
      },
    ]);
    assert.deepStrictEqual(panelMessages, []);
  });

  test("returns a typed, scoped failure when generation fails", async () => {
    const panelMessages: unknown[] = [];
    const browserMessages: unknown[] = [];
    const router = buildRouter(
      {
        createSampleScript: async () => {
          throw new Error("permission denied");
        },
      },
      (message) => panelMessages.push(message)
    );

    await router.route(
      {
        type: MESSAGE_TYPES.CREATE_END_CONDITION_SCRIPT,
        requestId: "create-2",
        scriptType: END_CONDITION_SCRIPT_TYPES.PYTHON,
      },
      {
        clientTag: "browser:2",
        postMessage: (message: unknown) => browserMessages.push(message),
      }
    );

    assert.deepStrictEqual(browserMessages, [
      {
        type: MESSAGE_TYPES.END_CONDITION_SCRIPT_CREATION_FAILED,
        requestId: "create-2",
        error: "permission denied",
      },
    ]);
    assert.deepStrictEqual(panelMessages, []);
  });
});

suite("WebviewMessageRouter — harness detection retry", () => {
  test("retries detection and replies only to the initiating client", async () => {
    const panelMessages: unknown[] = [];
    const browserMessages: unknown[] = [];
    let retryCount = 0;
    const router = buildRouter(
      {
        retryHarnessDetection: async () => {
          retryCount += 1;
        },
      },
      (message) => panelMessages.push(message)
    );

    await router.route(
      {
        type: MESSAGE_TYPES.RETRY_HARNESS_DETECTION,
        requestId: "retry-1",
      },
      {
        clientTag: "browser:retry",
        postMessage: (message: unknown) => browserMessages.push(message),
      }
    );

    assert.strictEqual(retryCount, 1);
    assert.deepStrictEqual(browserMessages, [
      {
        type: MESSAGE_TYPES.HARNESS_DETECTION_RETRY_RESULT,
        requestId: "retry-1",
        success: true,
      },
    ]);
    assert.deepStrictEqual(panelMessages, []);
  });
});

suite("WebviewMessageRouter — workspace statistics", () => {
  const snapshot = { workflowCount: 2 } as any;

  function makeStatsRouter(emitted: unknown[], calls: string[]) {
    return new WebviewMessageRouter(
      (message: unknown) => emitted.push(message),
      { sendWorkflowPropertiesToSettings: async () => {} } as any,
      {} as any,
      () =>
        ({
          getWorkspaceStatsService: () => ({
            getSnapshot: async () => {
              calls.push("getSnapshot");
              return snapshot;
            },
          }),
          refreshWorkspaceStats: async () => {
            calls.push("refreshWorkspaceStats");
            return snapshot;
          },
        }) as any,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );
  }

  test("returns the cached snapshot and starts a background refresh", async () => {
    const emitted: unknown[] = [];
    const calls: string[] = [];
    const router = makeStatsRouter(emitted, calls);

    await router.route({ type: MESSAGE_TYPES.REQUEST_WORKSPACE_STATS });

    assert.deepStrictEqual(emitted[0], {
      type: MESSAGE_TYPES.WORKSPACE_STATS_UPDATED,
      snapshot,
    });
    assert.deepStrictEqual(calls, ["getSnapshot", "refreshWorkspaceStats"]);
  });

  test("awaits an explicit stats refresh", async () => {
    const emitted: unknown[] = [];
    const calls: string[] = [];
    const router = makeStatsRouter(emitted, calls);

    await router.route({ type: MESSAGE_TYPES.REFRESH_WORKSPACE_STATS });

    assert.deepStrictEqual(emitted[0], {
      type: MESSAGE_TYPES.WORKSPACE_STATS_UPDATED,
      snapshot,
    });
    assert.deepStrictEqual(calls, ["refreshWorkspaceStats"]);
  });
});

suite("WebviewMessageRouter — workflow variant delivery", () => {
  const originalCreateWorkflowVariant =
    WorkflowVariantService.prototype.createWorkflowVariant;

  teardown(() => {
    WorkflowVariantService.prototype.createWorkflowVariant =
      originalCreateWorkflowVariant;
  });

  function variantMessage(requestId: string) {
    return {
      type: MESSAGE_TYPES.CREATE_WORKFLOW_VARIANT,
      requestId,
      source: { workflowKey: "source-workflow", kind: "draft" as const },
      workflowName: "Variant",
    };
  }

  test("creates once and replays the same reply to identical same-client retries", async () => {
    let createCount = 0;
    WorkflowVariantService.prototype.createWorkflowVariant = async () => {
      createCount += 1;
      return { workflowKey: "created-workflow" as never, kind: "draft" };
    };
    const browserMessages: unknown[] = [];
    const otherClientMessages: unknown[] = [];
    const router = buildRouter(undefined, (reply) =>
      otherClientMessages.push(reply)
    );
    const message = variantMessage("duplicate-1");

    await Promise.all([
      router.route(message, {
        clientTag: "browser:one",
        postMessage: (reply) => browserMessages.push(reply),
      }),
      router.route(
        { ...message },
        {
          clientTag: "browser:one",
          postMessage: (reply) => browserMessages.push(reply),
        }
      ),
    ]);

    assert.strictEqual(createCount, 1);
    assert.strictEqual(browserMessages.length, 2);
    assert.deepStrictEqual(browserMessages[1], browserMessages[0]);
    assert.strictEqual(
      otherClientMessages.length,
      0,
      "variant replies must not be broadcast to another client"
    );
  });

  test("allows different request ids to create independently", async () => {
    let createCount = 0;
    WorkflowVariantService.prototype.createWorkflowVariant = async () => ({
      workflowKey: `created-${++createCount}` as never,
      kind: "draft",
    });
    const messages: unknown[] = [];
    const router = buildRouter(undefined);

    await router.route(variantMessage("duplicate-a"), {
      clientTag: "browser:one",
      postMessage: (reply) => messages.push(reply),
    });
    await router.route(variantMessage("duplicate-b"), {
      clientTag: "browser:one",
      postMessage: (reply) => messages.push(reply),
    });

    assert.strictEqual(createCount, 2);
    assert.notDeepStrictEqual(messages[0], messages[1]);
  });

  test("replays a failed result without retrying creation", async () => {
    let createCount = 0;
    WorkflowVariantService.prototype.createWorkflowVariant = async () => {
      createCount += 1;
      throw new Error("creation failed");
    };
    const messages: unknown[] = [];
    const router = buildRouter(undefined);
    const message = variantMessage("failed-1");

    await router.route(message, {
      clientTag: "browser:one",
      postMessage: (reply) => messages.push(reply),
    });
    await router.route(
      { ...message },
      {
        clientTag: "browser:one",
        postMessage: (reply) => messages.push(reply),
      }
    );

    assert.strictEqual(createCount, 1);
    assert.deepStrictEqual(messages[1], messages[0]);
    assert.strictEqual(
      (messages[0] as any).type,
      MESSAGE_TYPES.WORKFLOW_VARIANT_FAILED
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

suite("WebviewMessageRouter — execution preview transport", () => {
  test("redacts the preview immediately before emitting it", async () => {
    const emitted: any[] = [];
    const router = new WebviewMessageRouter(
      (message: unknown) => emitted.push(message),
      { sendWorkflowPropertiesToSettings: async () => {} } as any,
      {} as any,
      () =>
        ({
          buildExecutionPreviewForClient: async () => ({
            address: { workflowKey: "workflow-a", kind: "draft" },
            displayedDefinitionRevision: 7,
            preview: {
              workflow: {
                name: "Workflow A",
                stepCount: 1,
                harnessIds: [],
                totalByteCount: 0,
                totalTokenEstimate: 0,
                workspaceMutationCount: 0,
              },
              steps: [
                {
                  stepIndex: 0,
                  type: "prompt",
                  resolvedProperties: {
                    harnessId: "copilot-cli",
                    session: { present: false },
                    skills: [],
                    mcpServerIds: [],
                    hooks: [],
                    permissions: { allowedRules: [], deniedRules: [] },
                    limits: {},
                    conditions: { pre: [], end: [], retry: { maxAttempts: 1 } },
                    propertySources: {},
                  },
                  command: {
                    executable: "harness",
                    args: ["api_key=supersecret"],
                    displayCommand: "harness api_key=supersecret",
                    displayShell: "powershell",
                    requiresShellVerbatimArgs: false,
                    cwd: "C:\\workspace",
                    environmentKeys: [],
                  },
                  workspaceMutations: [],
                  variables: [],
                  conditions: { pre: [], end: [], retry: { maxAttempts: 1 } },
                  diagnostics: [],
                },
              ],
              diagnostics: [],
            },
          }),
        }) as any,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );

    await router.route({
      type: MESSAGE_TYPES.REQUEST_EXECUTION_PREVIEW,
      scope: { kind: "workflow" },
      requestToken: 12,
    });

    const result = emitted.find(
      (message) => message.type === MESSAGE_TYPES.EXECUTION_PREVIEW_RESULT
    );
    assert.ok(result);
    assert.strictEqual(result.requestToken, 12);
    assert.strictEqual(result.displayedDefinitionRevision, 7);
    assert.ok(!JSON.stringify(result.preview).includes("supersecret"));
  });
});
