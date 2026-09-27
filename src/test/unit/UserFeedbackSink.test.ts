import * as assert from "assert";
import { suite, test } from "mocha";
import { CompositeUserFeedbackSink } from "../../core/CompositeUserFeedbackSink";
import type {
  UserFeedback,
  UserFeedbackSink,
} from "../../core/UserFeedbackSink";
import { ConsoleUserFeedbackSink } from "../../platform/ConsoleUserFeedbackSink";
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
