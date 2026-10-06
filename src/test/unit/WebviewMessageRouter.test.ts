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
  LICENSE_ACTIONS,
  MESSAGE_TYPES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  END_CONDITION_SCRIPT_TYPES,
  USER_FEEDBACK_SEVERITY,
  SEARCH_HISTORY_ERROR_CODES,
  VSCODE_COMMANDS,
  WORKFLOW_VIEW_ADDRESS_KIND,
  DASHBOARD_HOST_ACTIONS,
  DASHBOARD_ACTION_RESULT_STATUSES,
  PATH_SELECTION_KINDS,
  PATH_SELECTION_TITLES,
} from "../../types/DashboardConstants";
import type { DashboardHostActions, NamedRoot } from "../../core/HostPorts";
import { getVsCodeNamedWorkspaceRoots } from "../../platform/VsCodeWorkspaceRoot";
import { WorkflowVariantService } from "../../core/orchestration/WorkflowVariantService";
import {
  HistorySearchRegexTimeoutError,
  InvalidHistorySearchPatternError,
} from "../../core/orchestration/HistorySearchMatcher";
import { VsCodeUserFeedbackSink } from "../../platform/VsCodeUserFeedbackSink";
import {
  LicenseActivationLimitError,
  type Entitlement,
  type LicenseMachineSummary,
} from "../../license/LicenseService";
import type { LicenseActionService } from "../../ui/LicenseSettingsHandlers";

function buildRouter(
  orchestrator: unknown,
  defaultPostMessage: (message: unknown) => void = () => {},
  licenseService?: LicenseActionService,
  actions: DashboardHostActions = {
    openWorkspaceTarget: async () => ({ status: "unsupported" }),
  },
  getNamedRoots: () => NamedRoot[] = getVsCodeNamedWorkspaceRoots
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
    { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} },
    undefined,
    licenseService,
    { actions, getNamedRoots }
  );
}

class FakeLicenseActionService implements LicenseActionService {
  readonly calls: string[] = [];
  readonly machines: LicenseMachineSummary[] = [
    {
      id: "machine-1",
      name: "Desktop",
      platform: "win32",
      createdAt: "2026-08-28T12:00:00.000Z",
      isThisMachine: true,
    },
  ];
  storedKey = "license-key";
  activationError: Error | undefined;

  getStoredLicenseKey(): Promise<string | undefined> {
    return Promise.resolve(this.storedKey);
  }

  activateWithKey(key: string): Promise<Entitlement> {
    this.calls.push(`activate:${key}`);
    if (this.activationError) {
      return Promise.reject(this.activationError);
    }
    return Promise.resolve({} as Entitlement);
  }

  importLicenseFile(blob: string): Promise<Entitlement> {
    this.calls.push(`import:${blob}`);
    return Promise.resolve({} as Entitlement);
  }

  deactivate(): Promise<void> {
    this.calls.push("deactivate");
    return Promise.resolve();
  }

  listMachines(key: string): Promise<LicenseMachineSummary[]> {
    this.calls.push(`list:${key}`);
    return Promise.resolve(this.machines);
  }

  deactivateMachine(key: string, machineId: string): Promise<void> {
    this.calls.push(`deactivateMachine:${key}:${machineId}`);
    return Promise.resolve();
  }
}

suite("WebviewMessageRouter — dashboard host actions", () => {
  test("replies with a typed unsupported result for every missing native capability", async () => {
    const panelReplies: unknown[] = [];
    const clientReplies: unknown[] = [];
    const router = buildRouter(
      undefined,
      (message) => panelReplies.push(message),
      undefined,
      { openWorkspaceTarget: async () => ({ status: "unsupported" }) }
    );
    const messages = [
      { type: MESSAGE_TYPES.SELECT_FILE },
      { type: MESSAGE_TYPES.APPEND_FILE },
      { type: MESSAGE_TYPES.EDIT_FILE },
      { type: MESSAGE_TYPES.SHOW_OUTPUT },
      { type: MESSAGE_TYPES.OPEN_GIT_CHANGE, ref: "HEAD" },
      { type: MESSAGE_TYPES.OPEN_WORKTREE, worktreePath: "worktree" },
      {
        type: MESSAGE_TYPES.VIEW_WORKTREE_DIFF,
        sourceCheckoutRoot: "root",
        baseCommit: "base",
        branchName: "branch",
      },
      {
        type: MESSAGE_TYPES.EXPORT_CONTENT_PREVIEW,
        content: "diff",
        language: "diff",
      },
      { type: MESSAGE_TYPES.OPEN_VSCODE_MCP_BROWSER },
      {
        type: MESSAGE_TYPES.EXECUTE_VSCODE_COMMAND,
        command: VSCODE_COMMANDS.ACTIVATE_OFFLINE_PRO,
      },
      { type: MESSAGE_TYPES.RELOAD_WINDOW },
      { type: MESSAGE_TYPES.OPEN_WORKTREE_OWNER, stateRoot: "owner" },
    ];

    for (const message of messages) {
      await router.route(message, {
        clientTag: "browser:7",
        postMessage: (reply) => clientReplies.push(reply),
      });
    }

    assert.deepStrictEqual(
      clientReplies,
      [
        DASHBOARD_HOST_ACTIONS.SELECT_FILE,
        DASHBOARD_HOST_ACTIONS.APPEND_FILE,
        DASHBOARD_HOST_ACTIONS.EDIT_FILE,
        DASHBOARD_HOST_ACTIONS.SHOW_OUTPUT,
        DASHBOARD_HOST_ACTIONS.OPEN_GIT_CHANGE,
        DASHBOARD_HOST_ACTIONS.OPEN_WORKTREE,
        DASHBOARD_HOST_ACTIONS.VIEW_WORKTREE_DIFF,
        DASHBOARD_HOST_ACTIONS.EXPORT_CONTENT_PREVIEW,
        DASHBOARD_HOST_ACTIONS.OPEN_VSCODE_MCP_BROWSER,
        DASHBOARD_HOST_ACTIONS.ACTIVATE_OFFLINE_PRO,
        DASHBOARD_HOST_ACTIONS.RELOAD_WINDOW,
        DASHBOARD_HOST_ACTIONS.OPEN_WORKTREE_OWNER,
      ].map((action) => ({
        type: MESSAGE_TYPES.DASHBOARD_HOST_ACTION_RESULT,
        action,
        status: DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED,
        message: undefined,
      }))
    );
    assert.deepStrictEqual(panelReplies, []);
  });

  test("forwards native messages to the matching host actions", async () => {
    const calls: unknown[][] = [];
    const actions: DashboardHostActions = {
      openWorkspaceTarget: async (target) => {
        calls.push(["openWorkspaceTarget", target]);
        return { status: "opened" };
      },
      openContentPreview: async (content) => {
        calls.push(["openContentPreview", content]);
        return { status: "opened" };
      },
      selectWorkspacePath: async (request) => {
        calls.push(["selectWorkspacePath", request]);
        return undefined;
      },
      revealOutput: async () => {
        calls.push(["revealOutput"]);
      },
      openFolderWindow: async (path) => {
        calls.push(["openFolderWindow", path]);
        return { status: "opened" };
      },
      openGitDiff: async (request) => {
        calls.push(["openGitDiff", request]);
        return { status: "opened" };
      },
      browseMcpGallery: async () => {
        calls.push(["browseMcpGallery"]);
      },
      reloadHost: async () => {
        calls.push(["reloadHost"]);
      },
    };
    const router = buildRouter(
      { getCurrentPromptFilePathForClient: () => "current.yaml" },
      () => {},
      undefined,
      actions,
      () => [{ name: "root", fsPath: process.cwd() }]
    );
    await router.route({ type: MESSAGE_TYPES.SELECT_FILE });
    await router.route({ type: MESSAGE_TYPES.APPEND_FILE });
    await router.route({ type: MESSAGE_TYPES.EDIT_FILE });
    await router.route({ type: MESSAGE_TYPES.SHOW_OUTPUT });
    await router.route({ type: MESSAGE_TYPES.OPEN_GIT_CHANGE, ref: "HEAD" });
    await router.route({
      type: MESSAGE_TYPES.OPEN_WORKTREE,
      worktreePath: "wt",
    });
    await router.route({
      type: MESSAGE_TYPES.VIEW_WORKTREE_DIFF,
      sourceCheckoutRoot: "root",
      baseCommit: "base",
      branchName: "branch",
    });
    await router.route({
      type: MESSAGE_TYPES.EXPORT_CONTENT_PREVIEW,
      content: "text",
      language: "markdown",
    });
    await router.route({ type: MESSAGE_TYPES.OPEN_VSCODE_MCP_BROWSER });
    await router.route({
      type: MESSAGE_TYPES.EXECUTE_VSCODE_COMMAND,
      command: VSCODE_COMMANDS.ACTIVATE_OFFLINE_PRO,
    });
    await router.route({ type: MESSAGE_TYPES.RELOAD_WINDOW });
    await router.route({
      type: MESSAGE_TYPES.OPEN_WORKTREE_OWNER,
      stateRoot: "owner",
    });

    assert.deepStrictEqual(calls, [
      [
        "selectWorkspacePath",
        {
          kind: PATH_SELECTION_KINDS.FILE,
          title: PATH_SELECTION_TITLES.LOAD_WORKFLOW,
        },
      ],
      [
        "selectWorkspacePath",
        {
          kind: PATH_SELECTION_KINDS.FILE,
          title: PATH_SELECTION_TITLES.APPEND_WORKFLOW,
        },
      ],
      ["openWorkspaceTarget", { path: "current.yaml" }],
      ["revealOutput"],
      [
        "openGitDiff",
        { kind: "change", workspaceRoot: process.cwd(), ref: "HEAD" },
      ],
      ["openFolderWindow", "wt"],
      [
        "openGitDiff",
        {
          kind: "worktree",
          sourceCheckoutRoot: "root",
          baseCommit: "base",
          branchName: "branch",
        },
      ],
      ["openContentPreview", { content: "text", language: "markdown" }],
      ["browseMcpGallery"],
      [
        "selectWorkspacePath",
        {
          kind: PATH_SELECTION_KINDS.FILE,
          title: PATH_SELECTION_TITLES.IMPORT_OFFLINE_LICENSE,
          openLabel: PATH_SELECTION_TITLES.IMPORT_OFFLINE_LICENSE,
          fileExtensions: ["license", "txt", "json", "lic", "*"],
        },
      ],
      ["reloadHost"],
      ["openFolderWindow", "owner"],
    ]);
  });
});

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

  test("RELOAD_WINDOW delegates to the injected host action", async () => {
    let reloaded = false;
    await buildRouter(undefined, undefined, undefined, {
      openWorkspaceTarget: async () => ({ status: "unsupported" }),
      reloadHost: async () => {
        reloaded = true;
      },
    }).route({ type: MESSAGE_TYPES.RELOAD_WINDOW });

    assert.strictEqual(reloaded, true);
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

suite("WebviewMessageRouter — new workflow failure feedback", () => {
  test("restores the draft and emits a warning when starting a new workflow fails", async () => {
    const messages: unknown[] = [];
    const router = buildRouter(
      {
        runInNewWorkflowForClient: async () => {
          throw new Error("harness unavailable");
        },
      },
      (message) => messages.push(message)
    );

    await router.route({
      type: MESSAGE_TYPES.RUN_IN_NEW_WORKFLOW,
      text: "new workflow draft",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(messages, [
      {
        type: MESSAGE_TYPES.EXECUTE_PROMPT_ERROR,
        text: "new workflow draft",
      },
      {
        type: MESSAGE_TYPES.USER_FEEDBACK,
        id: messages[1] && (messages[1] as { id: string }).id,
        severity: USER_FEEDBACK_SEVERITY.WARNING,
        message: "harness unavailable",
      },
    ]);
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

suite("WebviewMessageRouter — statusline tracking", () => {
  test("forwards the typed disable request for both supported harnesses", async () => {
    const received: Array<{
      harnessId: string;
      restoreCustomCommand: boolean;
      postMessage: (message: unknown) => void;
    }> = [];
    const sentinelPostMessage = () => {};
    const settingsSync = {
      sendWorkflowPropertiesToSettings: async () => {},
      handleDisableStatusLineTracking: async (
        request: {
          harnessId: string;
          restoreCustomCommand: boolean;
        },
        postMessage: (message: unknown) => void
      ) => {
        received.push({ ...request, postMessage });
      },
    } as any;
    const router = new WebviewMessageRouter(
      () => {},
      settingsSync,
      {} as any,
      () => undefined,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );

    for (const harnessId of [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
    ]) {
      await router.route(
        {
          type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
          harnessId,
          restoreCustomCommand: true,
        },
        { postMessage: sentinelPostMessage }
      );
    }

    assert.deepStrictEqual(
      received.map(({ harnessId, restoreCustomCommand, postMessage }) => ({
        harnessId,
        restoreCustomCommand,
        postMessage,
      })),
      [
        {
          harnessId: HARNESS_IDS.CLAUDE_CLI,
          restoreCustomCommand: true,
          postMessage: sentinelPostMessage,
        },
        {
          harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
          restoreCustomCommand: true,
          postMessage: sentinelPostMessage,
        },
      ]
    );
  });

  test("rejects unsupported harness ids before dispatch", async () => {
    let calls = 0;
    const router = new WebviewMessageRouter(
      () => {},
      {
        sendWorkflowPropertiesToSettings: async () => {},
        handleDisableStatusLineTracking: async () => {
          calls++;
        },
      } as any,
      {} as any,
      () => undefined,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} }
    );

    await router.route({
      type: MESSAGE_TYPES.DISABLE_STATUS_LINE_TRACKING,
      harnessId: HARNESS_IDS.CODEX_CLI,
      restoreCustomCommand: false,
    });

    assert.strictEqual(calls, 0);
  });
});

suite("WebviewMessageRouter — end-condition script creation", () => {
  test("delegates to the evaluator and replies only to the initiating client", async () => {
    const created: string[] = [];
    const panelMessages: unknown[] = [];
    const browserMessages: unknown[] = [];
    const router = buildRouter(
      {
        createSampleScript: async (scriptType: string, scriptName: string) => {
          created.push(`${scriptType}:${scriptName}`);
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
        scriptName: "custom-check.js",
      },
      {
        clientTag: "browser:1",
        postMessage: (message: unknown) => browserMessages.push(message),
      }
    );

    assert.deepStrictEqual(created, [
      `${END_CONDITION_SCRIPT_TYPES.JAVASCRIPT}:custom-check.js`,
    ]);
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
      return {
        workflowKey: "created-workflow" as never,
        kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
      };
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
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
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
        address: {
          workflowKey: "workflow-a",
          kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
        },
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
          kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
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
            address: {
              workflowKey: "workflow-a",
              kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
            },
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

suite("WebviewMessageRouter — workspace snapshot content", () => {
  test("routes an addressed file request and returns the correlated content", async () => {
    const emitted: any[] = [];
    let call: unknown;
    const router = buildRouter(
      {
        getWorkspaceSnapshotFileContent: async (...args: unknown[]) => {
          call = args;
          return { beforeContent: "before", contentCaptureSkipped: false };
        },
      },
      (message) => emitted.push(message)
    );

    const request = {
      workflowKey: "workflow-a",
      runRef: "run-2026-01-01T00-00-00-000Z",
    };
    const target = { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 3 };
    await router.route({
      type: MESSAGE_TYPES.REQUEST_WORKSPACE_SNAPSHOT_CONTENT,
      requestId: "snapshot-7",
      address: request,
      target,
      path: "src/example.ts",
    });

    assert.deepStrictEqual(call, [request, target, "src/example.ts"]);
    assert.deepStrictEqual(emitted[0], {
      type: MESSAGE_TYPES.WORKSPACE_SNAPSHOT_CONTENT,
      requestId: "snapshot-7",
      address: request,
      target,
      path: "src/example.ts",
      beforeContent: "before",
      contentCaptureSkipped: false,
    });
  });

  test("answers with request-correlated missing content", async () => {
    const emitted: any[] = [];
    let called = false;
    const router = buildRouter(
      {
        getWorkspaceSnapshotFileContent: async () => {
          called = true;
          return undefined;
        },
      },
      (message) => emitted.push(message)
    );

    await router.route({
      type: MESSAGE_TYPES.REQUEST_WORKSPACE_SNAPSHOT_CONTENT,
      requestId: "snapshot-missing",
      address: {
        workflowKey: "workflow-a",
        runRef: "run-2026-01-01T00-00-00-000Z",
      },
      target: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
      path: "../../secret.txt",
    });

    assert.strictEqual(called, true);
    assert.strictEqual(emitted[0].requestId, "snapshot-missing");
    assert.strictEqual(emitted[0].beforeContent, undefined);
  });
});

suite("WebviewMessageRouter — license actions", () => {
  test("delegates license actions and refreshes machines after deactivation", async () => {
    const messages: any[] = [];
    const service = new FakeLicenseActionService();
    const router = buildRouter(
      undefined,
      (message) => messages.push(message),
      service
    );

    await router.route({
      type: MESSAGE_TYPES.ACTIVATE_LICENSE_KEY,
      key: " online-key ",
    });
    await router.route({
      type: MESSAGE_TYPES.IMPORT_LICENSE_FILE,
      blob: "license-blob",
    });
    await router.route({ type: MESSAGE_TYPES.DEACTIVATE_LICENSE });
    await router.route({ type: MESSAGE_TYPES.REQUEST_LICENSE_MACHINES });
    await router.route({
      type: MESSAGE_TYPES.DEACTIVATE_LICENSE_MACHINE,
      machineId: "machine-2",
    });

    assert.deepStrictEqual(service.calls, [
      "activate: online-key ",
      "import:license-blob",
      "deactivate",
      "list:license-key",
      "deactivateMachine:license-key:machine-2",
      "list:license-key",
    ]);
    assert.strictEqual(
      messages.filter(
        (message) => message.type === MESSAGE_TYPES.LICENSE_ACTION_RESULT
      ).length,
      5
    );
    assert.strictEqual(
      messages.filter(
        (message) => message.type === MESSAGE_TYPES.LICENSE_MACHINES_UPDATED
      ).length,
      2
    );
  });

  test("uses a distinct action for activation machine-limit errors", async () => {
    const messages: any[] = [];
    const service = new FakeLicenseActionService();
    service.activationError = new LicenseActivationLimitError("license-123");
    const router = buildRouter(
      undefined,
      (message) => messages.push(message),
      service
    );

    await router.route({
      type: MESSAGE_TYPES.ACTIVATE_LICENSE_KEY,
      key: "online-key",
    });

    assert.deepStrictEqual(messages, [
      {
        type: MESSAGE_TYPES.LICENSE_ACTION_RESULT,
        action: LICENSE_ACTIONS.ACTIVATION_LIMIT,
        status: "error",
        message:
          "This Pro license has reached its machine limit. Deactivate another machine and try again.",
      },
    ]);
  });

  test("keeps action and machine replies isolated between browser clients", async () => {
    const firstClient: any[] = [];
    const secondClient: any[] = [];
    const panelMessages: any[] = [];
    const service = new FakeLicenseActionService();
    const router = buildRouter(
      undefined,
      (message) => panelMessages.push(message),
      service
    );

    await router.route(
      { type: MESSAGE_TYPES.REQUEST_LICENSE_MACHINES },
      {
        clientTag: "browser:1",
        postMessage: (message) => firstClient.push(message),
      }
    );
    await router.route(
      { type: MESSAGE_TYPES.ACTIVATE_LICENSE_KEY, key: "other-key" },
      {
        clientTag: "browser:2",
        postMessage: (message) => secondClient.push(message),
      }
    );

    assert.ok(
      firstClient.some(
        (message) => message.type === MESSAGE_TYPES.LICENSE_MACHINES_UPDATED
      )
    );
    assert.ok(
      firstClient.some(
        (message) => message.type === MESSAGE_TYPES.LICENSE_ACTION_RESULT
      )
    );
    assert.deepStrictEqual(
      secondClient.map((message) => message.type),
      [MESSAGE_TYPES.LICENSE_ACTION_RESULT]
    );
    assert.deepStrictEqual(panelMessages, []);
  });

  suite("history search supersession", () => {
    /**
     * Scrolling a result set issues one SEARCH_HISTORY per page, all for the
     * same query and filters. Aborting the previous one on every arrival (the
     * original per-client rule) killed those page requests, and a page that
     * never answers leaves its rows stuck as placeholders: the drawer asks
     * for each offset exactly once.
     */
    interface RecordedSearch {
      offset?: number;
      query: string;
      deep?: boolean;
      regex?: boolean;
      signal?: AbortSignal;
      resolve: () => void;
    }

    function buildSearchRouter(recorded: RecordedSearch[]): {
      router: WebviewMessageRouter;
      restore: () => void;
      emitted: any[];
    } {
      const emitted: any[] = [];
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: [{ uri: vscode.Uri.file(path.join(__dirname, "workspace")) }],
        configurable: true,
      });
      const historySearchService = {
        search: (
          request: {
            query: string;
            offset?: number;
            deep?: boolean;
            regex?: boolean;
          },
          _workspacePath: string,
          _onProgress: unknown,
          signal?: AbortSignal
        ) =>
          new Promise((resolve) => {
            recorded.push({
              query: request.query,
              offset: request.offset,
              deep: request.deep,
              regex: request.regex,
              signal,
              resolve: () =>
                resolve({
                  query: request.query,
                  offset: request.offset ?? 0,
                  results: [],
                  totalCount: 0,
                  countState: "exact",
                  hasMore: false,
                  indexState: "ready",
                }),
            });
          }),
      };
      const router = new WebviewMessageRouter(
        (message) => emitted.push(message),
        { sendWorkflowPropertiesToSettings: async () => {} } as any,
        {} as any,
        () => undefined as any,
        historySearchService as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} },
        undefined,
        undefined,
        {
          actions: {
            openWorkspaceTarget: async () => ({ status: "unsupported" }),
          },
          getNamedRoots: getVsCodeNamedWorkspaceRoots,
        }
      );
      return {
        router,
        emitted,
        restore: () =>
          Object.defineProperty(vscode.workspace, "workspaceFolders", {
            value: originalWorkspaceFolders,
            configurable: true,
          }),
      };
    }

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
    };

    test("a page request does not cancel an in-flight search for the same listing", async () => {
      const recorded: RecordedSearch[] = [];
      const { router, restore, emitted } = buildSearchRouter(recorded);
      try {
        const first = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          listingId: "listing-a",
          limit: 50,
        });
        await settle();
        assert.strictEqual(recorded.length, 1);

        const second = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          listingId: "listing-a",
          limit: 50,
          offset: 50,
        });
        await settle();
        assert.strictEqual(
          recorded[0].signal?.aborted,
          false,
          "a later page of the same listing must not abort the page still running"
        );

        recorded[0].resolve();
        await first;
        assert.strictEqual(emitted[0].listingId, "listing-a");
        await settle();
        assert.strictEqual(recorded.length, 2);
        recorded[1].resolve();
        await second;
        assert.strictEqual(recorded[1].signal?.aborted, false);
      } finally {
        restore();
      }
    });

    test("a different query cancels the in-flight search", async () => {
      const recorded: RecordedSearch[] = [];
      const { router, restore } = buildSearchRouter(recorded);
      try {
        const first = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
        });
        await settle();
        assert.strictEqual(recorded.length, 1);

        const second = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "something-else",
          limit: 50,
        });
        await settle();
        assert.strictEqual(recorded[0].signal?.aborted, true);

        recorded[0].resolve();
        await first;
        await settle();
        recorded[1].resolve();
        await second;
      } finally {
        restore();
      }
    });

    test("deep and shallow listings supersede each other for the same query", async () => {
      const recorded: RecordedSearch[] = [];
      const { router, restore } = buildSearchRouter(recorded);
      try {
        const shallow = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
        });
        await settle();
        assert.strictEqual(recorded.length, 1);
        assert.strictEqual(recorded[0].deep, false);

        const deep = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
          deep: true,
        });
        await settle();
        assert.strictEqual(recorded[0].signal?.aborted, true);

        recorded[0].resolve();
        await shallow;
        await settle();
        assert.strictEqual(recorded.length, 2);
        assert.strictEqual(recorded[1].deep, true);

        const shallowAgain = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
        });
        await settle();
        assert.strictEqual(recorded[1].signal?.aborted, true);

        recorded[1].resolve();
        await deep;
        await settle();
        assert.strictEqual(recorded.length, 3);
        assert.strictEqual(recorded[2].deep, false);
        recorded[2].resolve();
        await shallowAgain;
      } finally {
        restore();
      }
    });

    test("regex and substring listings supersede each other for the same query", async () => {
      const recorded: RecordedSearch[] = [];
      const { router, restore } = buildSearchRouter(recorded);
      try {
        const substring = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
        });
        await settle();
        assert.strictEqual(recorded.length, 1);
        assert.strictEqual(recorded[0].regex, false);

        const regex = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
          regex: true,
        });
        await settle();
        assert.strictEqual(recorded[0].signal?.aborted, true);

        recorded[0].resolve();
        await substring;
        await settle();
        assert.strictEqual(recorded.length, 2);
        assert.strictEqual(recorded[1].regex, true);
        recorded[1].resolve();
        await regex;
      } finally {
        restore();
      }
    });

    test("case-significant regex queries supersede each other", async () => {
      const recorded: RecordedSearch[] = [];
      const { router, restore } = buildSearchRouter(recorded);
      try {
        const digits = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "\\d{3}",
          limit: 50,
          regex: true,
        });
        await settle();
        const nonDigits = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "\\D{3}",
          limit: 50,
          regex: true,
        });
        await settle();

        assert.strictEqual(recorded[0].signal?.aborted, true);
        recorded[0].resolve();
        await digits;
        await settle();
        assert.strictEqual(recorded.length, 2);
        recorded[1].resolve();
        await nonDigits;
      } finally {
        restore();
      }
    });

    test("returns invalid regex patterns as typed webview errors", async () => {
      const emitted: any[] = [];
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: [{ uri: vscode.Uri.file(path.join(__dirname, "workspace")) }],
        configurable: true,
      });
      const historySearchService = {
        search: () =>
          Promise.reject(
            new InvalidHistorySearchPatternError(
              "[a",
              "Unterminated character class"
            )
          ),
      };
      const router = new WebviewMessageRouter(
        (message) => emitted.push(message),
        { sendWorkflowPropertiesToSettings: async () => {} } as any,
        {} as any,
        () => undefined as any,
        historySearchService as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} },
        undefined,
        undefined,
        {
          actions: {
            openWorkspaceTarget: async () => ({ status: "unsupported" }),
          },
          getNamedRoots: getVsCodeNamedWorkspaceRoots,
        }
      );
      try {
        await router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "[a",
          limit: 50,
          regex: true,
        });
        assert.deepStrictEqual(emitted, [
          {
            type: MESSAGE_TYPES.SEARCH_HISTORY_ERROR,
            query: "[a",
            regex: true,
            code: "invalidPattern",
            pattern: "[a",
            message:
              'Invalid history search pattern "[a": Unterminated character class',
          },
        ]);
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
      }
    });

    test("returns regex timeouts as a typed webview error", async () => {
      const emitted: any[] = [];
      const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        value: [{ uri: vscode.Uri.file(path.join(__dirname, "workspace")) }],
        configurable: true,
      });
      const historySearchService = {
        search: () =>
          Promise.reject(new HistorySearchRegexTimeoutError("(a+)+$")),
      };
      const router = new WebviewMessageRouter(
        (message) => emitted.push(message),
        { sendWorkflowPropertiesToSettings: async () => {} } as any,
        {} as any,
        () => undefined as any,
        historySearchService as any,
        { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} },
        undefined,
        undefined,
        {
          actions: {
            openWorkspaceTarget: async () => ({ status: "unsupported" }),
          },
          getNamedRoots: getVsCodeNamedWorkspaceRoots,
        }
      );
      try {
        await router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "(a+)+$",
          limit: 50,
          regex: true,
        });
        assert.deepStrictEqual(emitted, [
          {
            type: MESSAGE_TYPES.SEARCH_HISTORY_ERROR,
            query: "(a+)+$",
            regex: true,
            code: SEARCH_HISTORY_ERROR_CODES.REGEX_TIMEOUT,
            pattern: "(a+)+$",
            message: new HistorySearchRegexTimeoutError("(a+)+$").message,
          },
        ]);
      } finally {
        Object.defineProperty(vscode.workspace, "workspaceFolders", {
          value: originalWorkspaceFolders,
          configurable: true,
        });
      }
    });

    test("a changed filter cancels the in-flight search for the old listing", async () => {
      const recorded: RecordedSearch[] = [];
      const { router, restore } = buildSearchRouter(recorded);
      try {
        const first = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
          filters: { harnesses: [HARNESS_IDS.CLAUDE_CLI] },
        });
        await settle();
        const second = router.route({
          type: MESSAGE_TYPES.SEARCH_HISTORY,
          query: "codemirroreditor",
          limit: 50,
          filters: { harnesses: [HARNESS_IDS.CODEX_CLI] },
        });
        await settle();
        assert.strictEqual(recorded[0].signal?.aborted, true);

        recorded[0].resolve();
        await first;
        await settle();
        recorded[1].resolve();
        await second;
      } finally {
        restore();
      }
    });
  });
});
