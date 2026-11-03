import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import * as vscode from "vscode";
import { CompositeUserFeedbackSink } from "../../core/CompositeUserFeedbackSink";
import {
  emitUserFeedback,
  notifyUserFeedback,
  type UserFeedback,
  type UserFeedbackSink,
} from "../../core/UserFeedbackSink";
import { ConsoleUserFeedbackSink } from "../../platform/ConsoleUserFeedbackSink";
import {
  showErrorMessageFor,
  showWarningMessage,
} from "../../platform/VsCodeMessages";
import { Log, LogLevel } from "../../utils/Log";
import { captureLog } from "../helpers/logCapture";
import { VsCodeUserFeedbackSink } from "../../platform/VsCodeUserFeedbackSink";
import { CtrlYokeHostedServer } from "../../server/CtrlYokeHostedServer";
import { HostedWebSocketUserFeedbackSink } from "../../server/HostedWebSocketUserFeedbackSink";
import {
  MESSAGE_TYPES,
  TOAST_LEVEL_MODES,
  USER_FEEDBACK_ACTIONS,
} from "../../types/DashboardConstants";
import type { UserFeedbackMessage } from "../../types/WebviewMessageTypes";

const feedback: UserFeedback = {
  severity: "warning",
  message: "The harness needs attention",
  detail: "Check the configured permissions.",
  dedupeKey: "harness-warning",
};

class RecordingSink implements UserFeedbackSink {
  readonly received: UserFeedback[] = [];
  notify(message: UserFeedback): void {
    this.received.push(message);
  }
}

suite("notifyUserFeedback logging survives hidden toasts and CLI mode", () => {
  test("logs every severity while toastLevel is none", () => {
    const log = captureLog();
    try {
      const shown: string[] = [];
      const sink = new VsCodeUserFeedbackSink(
        {
          showInformationMessage: () => shown.push("info"),
          showWarningMessage: () => shown.push("warning"),
          showErrorMessage: () => shown.push("error"),
        },
        () => TOAST_LEVEL_MODES.NONE
      );

      notifyUserFeedback(sink, "error", "Save failed");
      notifyUserFeedback(sink, "warning", "Harness slow");
      notifyUserFeedback(sink, "info", "Copied");

      assert.deepStrictEqual(shown, []);
      assert.deepStrictEqual(log.lines, [
        { level: LogLevel.ERROR, message: "[Toast] Save failed" },
        { level: LogLevel.WARN, message: "[Toast] Harness slow" },
        { level: LogLevel.INFO, message: "[Toast] Copied" },
      ]);
    } finally {
      log.restore();
    }
  });

  test("writes every severity to the CLI log file", () => {
    const internal = Log as unknown as {
      logLevel: LogLevel;
      cliMode: boolean;
      cliLogFilePath: string | undefined;
    };
    const saved = { ...internal };
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-toast-"));
    try {
      fs.mkdirSync(path.join(workspace, ".ctrlyoke"));
      // The CLI's default (non-verbose) level.
      Log.initializeCli(workspace, false);
      const consoleLines: string[] = [];
      const sink = new ConsoleUserFeedbackSink({
        log: (message) => consoleLines.push(message),
        warn: (message) => consoleLines.push(message),
        error: (message) => consoleLines.push(message),
      });

      notifyUserFeedback(
        sink,
        "error",
        "Parse failed",
        undefined,
        new Error("bad yaml")
      );
      notifyUserFeedback(sink, "warning", "Guardrail hit");
      notifyUserFeedback(sink, "info", "Session resumed");

      assert.strictEqual(consoleLines.length, 3);
      const cliLog = fs.readFileSync(internal.cliLogFilePath!, "utf8");
      assert.match(cliLog, /ERROR: \[Toast\] Parse failed: bad yaml/);
      assert.match(cliLog, /Stack trace: Error: bad yaml/);
      assert.match(cliLog, /WARN: \[Toast\] Guardrail hit/);
      assert.match(cliLog, /INFO: \[Toast\] Session resumed/);
    } finally {
      internal.logLevel = saved.logLevel;
      internal.cliMode = saved.cliMode;
      internal.cliLogFilePath = saved.cliLogFilePath;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

suite("notifyUserFeedback logging", () => {
  let log: ReturnType<typeof captureLog>;
  setup(() => {
    log = captureLog();
  });
  teardown(() => {
    log.restore();
  });

  test("logs every severity at its own level before notifying", () => {
    const sink = new RecordingSink();

    notifyUserFeedback(sink, "error", "Export failed", "No timeline.");
    notifyUserFeedback(sink, "warning", "Harness slow");
    notifyUserFeedback(sink, "info", "Copied");
    notifyUserFeedback(sink, "success", "Saved");

    assert.deepStrictEqual(log.lines, [
      { level: LogLevel.ERROR, message: "[Toast] Export failed\nNo timeline." },
      { level: LogLevel.WARN, message: "[Toast] Harness slow" },
      { level: LogLevel.INFO, message: "[Toast] Copied" },
      { level: LogLevel.INFO, message: "[Toast] Saved" },
    ]);
    assert.strictEqual(sink.received.length, 4);
  });

  test("keeps the error's message and stack without repeating it", () => {
    const error = new Error("disk full");

    notifyUserFeedback(undefined, "error", "Could not save", undefined, error);
    notifyUserFeedback(
      undefined,
      "error",
      "Could not save: disk full",
      undefined,
      error
    );

    assert.strictEqual(log.lines.length, 2);
    assert.ok(
      log.lines[0].message.startsWith(
        "[Toast] Could not save: disk full\nStack trace: Error: disk full"
      )
    );
    assert.ok(
      log.lines[1].message.startsWith(
        "[Toast] Could not save: disk full\nStack trace:"
      )
    );
  });

  test("logs even when the host has no feedback surface", () => {
    emitUserFeedback(undefined, {
      severity: "error",
      message: "Newer workflow format",
      action: USER_FEEDBACK_ACTIONS.UPDATE_EXTENSION,
    });

    assert.deepStrictEqual(log.lines, [
      { level: LogLevel.ERROR, message: "[Toast] Newer workflow format" },
    ]);
  });

  test("native message wrappers log before showing", async () => {
    const originalWarning = vscode.window.showWarningMessage;
    const originalError = vscode.window.showErrorMessage;
    const shown: unknown[][] = [];
    const replace = (name: string, value: unknown): void => {
      Object.defineProperty(vscode.window, name, { configurable: true, value });
    };
    replace("showWarningMessage", (...args: unknown[]) => {
      shown.push(["warning", ...args]);
      return Promise.resolve("Reload Window");
    });
    replace("showErrorMessage", (...args: unknown[]) => {
      shown.push(["error", ...args]);
      return Promise.resolve(undefined);
    });
    try {
      const choice = await showWarningMessage(
        "Root changed",
        { detail: "Reload to relocate." },
        "Reload Window"
      );
      await showErrorMessageFor(new Error("boom"), "Init failed");

      assert.strictEqual(choice, "Reload Window");
      assert.deepStrictEqual(shown, [
        [
          "warning",
          "Root changed",
          { detail: "Reload to relocate." },
          "Reload Window",
        ],
        ["error", "Init failed"],
      ]);
      assert.deepStrictEqual(log.lines[0], {
        level: LogLevel.WARN,
        message: "[Toast] Root changed\nReload to relocate.",
      });
      assert.strictEqual(log.lines[1].level, LogLevel.ERROR);
      assert.ok(log.lines[1].message.startsWith("[Toast] Init failed: boom\n"));
    } finally {
      replace("showWarningMessage", originalWarning);
      replace("showErrorMessage", originalError);
    }
  });
});

suite("VsCodeUserFeedbackSink", () => {
  test("maps info and success to showInformationMessage", () => {
    const calls: Array<[string, string]> = [];
    const sink = new VsCodeUserFeedbackSink({
      showInformationMessage: (message) => calls.push(["info", message]),
      showWarningMessage: (message) => calls.push(["warning", message]),
      showErrorMessage: (message) => calls.push(["error", message]),
    });

    sink.notify({ ...feedback, severity: "info" });
    sink.notify({ ...feedback, severity: "success" });

    assert.deepStrictEqual(calls, [
      [
        "info",
        "The harness needs attention\nCheck the configured permissions.",
      ],
      [
        "info",
        "The harness needs attention\nCheck the configured permissions.",
      ],
    ]);
  });

  test("maps warning and error to their matching native APIs", () => {
    const calls: string[] = [];
    const sink = new VsCodeUserFeedbackSink({
      showInformationMessage: () => calls.push("info"),
      showWarningMessage: () => calls.push("warning"),
      showErrorMessage: () => calls.push("error"),
    });

    sink.notify({ ...feedback, severity: "warning" });
    sink.notify({ ...feedback, severity: "error" });

    assert.deepStrictEqual(calls, ["warning", "error"]);
  });

  test("offers Update for a newer workflow format refusal", () => {
    const calls: string[][] = [];
    const sink = new VsCodeUserFeedbackSink({
      showInformationMessage: () => undefined,
      showWarningMessage: () => undefined,
      showErrorMessage: (message, ...items) => {
        calls.push([message, ...items]);
        return undefined;
      },
    });

    sink.notify({
      severity: "error",
      message: "workflow.ctrlyoke.yaml uses workflow format 2.",
      action: USER_FEEDBACK_ACTIONS.UPDATE_EXTENSION,
    });

    assert.deepStrictEqual(calls, [
      ["workflow.ctrlyoke.yaml uses workflow format 2.", "Update"],
    ]);
  });

  test("suppresses severities below the resolved toast level", () => {
    const calls: string[] = [];
    const sink = new VsCodeUserFeedbackSink(
      {
        showInformationMessage: () => calls.push("info"),
        showWarningMessage: () => calls.push("warning"),
        showErrorMessage: () => calls.push("error"),
      },
      () => TOAST_LEVEL_MODES.WARNING_AND_ERROR
    );

    sink.notify({ ...feedback, severity: "info" });
    sink.notify({ ...feedback, severity: "success" });
    sink.notify({ ...feedback, severity: "warning" });
    sink.notify({ ...feedback, severity: "error" });

    assert.deepStrictEqual(calls, ["warning", "error"]);
  });
});

suite("ConsoleUserFeedbackSink", () => {
  test("preserves severity without importing vscode", () => {
    const calls: Array<[string, string]> = [];
    const sink = new ConsoleUserFeedbackSink({
      log: (message) => calls.push(["info", message]),
      warn: (message) => calls.push(["warning", message]),
      error: (message) => calls.push(["error", message]),
    });
    sink.notify({ ...feedback, severity: "info" });
    sink.notify({ ...feedback, severity: "success" });
    sink.notify({ ...feedback, severity: "warning" });
    sink.notify({ ...feedback, severity: "error" });

    assert.deepStrictEqual(
      calls.map(([severity]) => severity),
      ["info", "info", "warning", "error"]
    );
    assert.strictEqual(
      calls[0][1],
      "The harness needs attention\nCheck the configured permissions."
    );
  });
});

suite("CompositeUserFeedbackSink", () => {
  test("notifies every configured sink", () => {
    const received: UserFeedback[][] = [[], []];
    const sinks: UserFeedbackSink[] = [
      { notify: (message) => received[0].push(message) },
      { notify: (message) => received[1].push(message) },
    ];

    new CompositeUserFeedbackSink(sinks).notify(feedback);

    assert.deepStrictEqual(received, [[feedback], [feedback]]);
  });
});

interface FakeHostedSocket {
  readyState: number;
  sent: string[];
  send(message: string): void;
}

interface HostedServerBroadcastInternals {
  connections: Set<FakeHostedSocket>;
  broadcastUserFeedback(message: UserFeedbackMessage): void;
}

suite("HostedWebSocketUserFeedbackSink", () => {
  test("reaches every browser socket but not the VS Code panel", () => {
    const browserSockets: FakeHostedSocket[] = [
      {
        readyState: 1,
        sent: [],
        send(message) {
          this.sent.push(message);
        },
      },
      {
        readyState: 1,
        sent: [],
        send(message) {
          this.sent.push(message);
        },
      },
    ];
    const panelMessages: unknown[] = [];
    const server = Object.create(
      CtrlYokeHostedServer.prototype
    ) as HostedServerBroadcastInternals;
    server.connections = new Set(browserSockets);

    const sink = new HostedWebSocketUserFeedbackSink((message) =>
      server.broadcastUserFeedback(message)
    );
    sink.notify({ ...feedback, severity: "error" });

    assert.strictEqual(browserSockets[0].sent.length, 1);
    assert.strictEqual(browserSockets[1].sent.length, 1);
    const firstMessage = JSON.parse(
      browserSockets[0].sent[0]
    ) as UserFeedbackMessage;
    assert.strictEqual(firstMessage.type, MESSAGE_TYPES.USER_FEEDBACK);
    assert.strictEqual(firstMessage.severity, "error");
    assert.strictEqual(firstMessage.message, feedback.message);
    assert.strictEqual(firstMessage.detail, feedback.detail);
    assert.strictEqual(firstMessage.dedupeKey, feedback.dedupeKey);
    assert.strictEqual(typeof firstMessage.id, "string");
    assert.deepStrictEqual(panelMessages, []);
  });
});
