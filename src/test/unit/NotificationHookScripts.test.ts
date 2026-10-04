import * as assert from "assert";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";

interface HookRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface NotificationCase {
  harness: "claude" | "copilot" | "qwen";
  hookArgs: string[];
  payload: Record<string, unknown>;
  expectedNativeEvent: string;
  expectedTitle: string;
  expectedMessage: string;
  expectedType: string;
}

const scriptPath = (name: string): string =>
  path.resolve(__dirname, `../../scripts/${name}`);

const HOOK_SCRIPTS: Record<NotificationCase["harness"], string> = {
  claude: scriptPath("ctrlyoke-claude-hook.js"),
  copilot: scriptPath("ctrlyoke-copilot-hook.js"),
  qwen: scriptPath("ctrlyoke-qwen-hook.js"),
};

function runHook(
  harness: NotificationCase["harness"],
  notifyDir: string,
  hookArgs: string[],
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): Promise<HookRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [HOOK_SCRIPTS[harness], notifyDir, ...hookArgs],
      {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

async function readJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).filter((file) =>
      file.endsWith(".json")
    );
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;
    if (typedError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readArtifact(
  notifyDir: string,
  fileName: string
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(notifyDir, fileName), "utf8")
  ) as Record<string, unknown>;
}

function hookEnvironment(
  runId: string,
  enabledEvents: string
): NodeJS.ProcessEnv {
  return {
    CTRLYOKE_RUN_ID: runId,
    CTRLYOKE_WORKFLOW_ID: "workflow-notification-test",
    CTRLYOKE_WORKFLOW_NAME: "Notification Hook Test",
    CTRLYOKE_PROMPT_INDEX: "2",
    CTRLYOKE_PROMPT_NAME: "notification prompt",
    CTRLYOKE_HARNESS_ID: "test-harness",
    CTRLYOKE_NOTIFY_HOOK_EVENTS: enabledEvents,
  };
}

function shellQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

suite("notification hook scripts", () => {
  let tempDirectory: string;

  setup(async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-notification-hooks-")
    );
  });

  teardown(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  test("writes one normalized artifact for enabled notifications", async () => {
    const cases: NotificationCase[] = [
      {
        harness: "claude",
        hookArgs: [],
        payload: {
          hook_event_name: "Notification",
          message: "Claude needs an answer",
          title: "Permission required",
          notification_type: "permission_prompt",
          transcript_path: "~/.claude/projects/example/session.jsonl",
        },
        expectedNativeEvent: "Notification",
        expectedTitle: "Permission required",
        expectedMessage: "Claude needs an answer",
        expectedType: "permission_prompt",
      },
      {
        harness: "copilot",
        hookArgs: ["notification"],
        payload: {
          hook_event_name: "Notification",
          message: "Copilot asks a question",
          title: "Your input is needed",
          notification_type: "elicitation_dialog",
          cwd: "C:/workspace",
        },
        expectedNativeEvent: "Notification",
        expectedTitle: "Your input is needed",
        expectedMessage: "Copilot asks a question",
        expectedType: "elicitation_dialog",
      },
      {
        harness: "qwen",
        hookArgs: [],
        payload: {
          hook_event_name: "Notification",
          message: "Qwen is waiting for input",
          title: "Qwen prompt",
          notification_type: "idle_prompt",
          cwd: "/workspace",
        },
        expectedNativeEvent: "Notification",
        expectedTitle: "Qwen prompt",
        expectedMessage: "Qwen is waiting for input",
        expectedType: "idle_prompt",
      },
    ];

    for (const notificationCase of cases) {
      const runId = `run-${notificationCase.harness}-notification`;
      const notifyDir = path.join(
        tempDirectory,
        `${notificationCase.harness}-enabled`
      );
      const result = await runHook(
        notificationCase.harness,
        notifyDir,
        notificationCase.hookArgs,
        notificationCase.payload,
        hookEnvironment(runId, "notification")
      );

      assert.strictEqual(result.code, 0, result.stderr);
      assert.strictEqual(result.stdout, "");

      const files = await readJsonFiles(notifyDir);
      assert.strictEqual(files.length, 1, `${notificationCase.harness} files`);
      assert.match(files[0], new RegExp(`^${runId}-hook-\\d+-\\d+\\.json$`));
      assert.strictEqual(
        files.some((file) => /-(start|stop|error)\.json$/.test(file)),
        false
      );

      const artifact = await readArtifact(notifyDir, files[0]);
      assert.strictEqual(artifact.hookEvent, "notification");
      assert.strictEqual(
        artifact.nativeHookEvent,
        notificationCase.expectedNativeEvent
      );
      assert.strictEqual(artifact.sessionId, undefined);
      assert.strictEqual(
        artifact.notificationTitle,
        notificationCase.expectedTitle
      );
      assert.strictEqual(
        artifact.notificationMessage,
        notificationCase.expectedMessage
      );
      assert.strictEqual(
        artifact.notificationType,
        notificationCase.expectedType
      );
      assert.deepStrictEqual(artifact.rawHookData, notificationCase.payload);
    }
  });

  test("does not write disabled notification artifacts", async () => {
    const cases: NotificationCase[] = [
      {
        harness: "claude",
        hookArgs: [],
        payload: { hook_event_name: "Notification", message: "ignored" },
        expectedNativeEvent: "Notification",
        expectedTitle: "",
        expectedMessage: "",
        expectedType: "",
      },
      {
        harness: "copilot",
        hookArgs: ["notification"],
        payload: { hook_event_name: "Notification", message: "ignored" },
        expectedNativeEvent: "Notification",
        expectedTitle: "",
        expectedMessage: "",
        expectedType: "",
      },
      {
        harness: "qwen",
        hookArgs: [],
        payload: { hook_event_name: "Notification", message: "ignored" },
        expectedNativeEvent: "Notification",
        expectedTitle: "",
        expectedMessage: "",
        expectedType: "",
      },
    ];

    for (const notificationCase of cases) {
      const notifyDir = path.join(
        tempDirectory,
        `${notificationCase.harness}-disabled`
      );
      const result = await runHook(
        notificationCase.harness,
        notifyDir,
        notificationCase.hookArgs,
        notificationCase.payload,
        hookEnvironment(
          `run-${notificationCase.harness}-disabled`,
          "permissionRequest"
        )
      );

      assert.strictEqual(result.code, 0, result.stderr);
      assert.deepStrictEqual(await readJsonFiles(notifyDir), []);
    }
  });

  test("preserves lifecycle files and permission decision stdout", async () => {
    const lifecycleCases = [
      {
        harness: "claude" as const,
        startArgs: [],
        stopArgs: [],
        startPayload: {
          hook_event_name: "SessionStart",
          session_id: "claude-session",
        },
        stopPayload: { hook_event_name: "Stop", session_id: "claude-session" },
        startFile: "run-claude-lifecycle-start.json",
        stopFile: "claude-session-stop.json",
      },
      {
        harness: "qwen" as const,
        startArgs: [],
        stopArgs: [],
        startPayload: {
          hook_event_name: "SessionStart",
          session_id: "qwen-session",
        },
        stopPayload: { hook_event_name: "Stop", session_id: "qwen-session" },
        startFile: "run-qwen-lifecycle-start.json",
        stopFile: "qwen-session-stop.json",
      },
      {
        harness: "copilot" as const,
        startArgs: ["sessionStart"],
        stopArgs: ["agentStop"],
        startPayload: { sessionId: "copilot-session", source: "new" },
        stopPayload: { sessionId: "copilot-session", reason: "complete" },
        startFile: "run-copilot-lifecycle-start.json",
        stopFile: "copilot-session-stop.json",
      },
    ];

    for (const lifecycleCase of lifecycleCases) {
      const notifyDir = path.join(
        tempDirectory,
        `${lifecycleCase.harness}-lifecycle`
      );
      const env = hookEnvironment(
        `run-${lifecycleCase.harness}-lifecycle`,
        "notification"
      );
      const startResult = await runHook(
        lifecycleCase.harness,
        notifyDir,
        lifecycleCase.startArgs,
        lifecycleCase.startPayload,
        env
      );
      const stopResult = await runHook(
        lifecycleCase.harness,
        notifyDir,
        lifecycleCase.stopArgs,
        lifecycleCase.stopPayload,
        env
      );

      assert.strictEqual(startResult.code, 0, startResult.stderr);
      assert.strictEqual(stopResult.code, 0, stopResult.stderr);
      assert.deepStrictEqual(
        (await readJsonFiles(notifyDir)).sort(),
        [lifecycleCase.startFile, lifecycleCase.stopFile].sort()
      );
      assert.strictEqual(
        (await readArtifact(notifyDir, lifecycleCase.stopFile)).runId,
        env.CTRLYOKE_RUN_ID
      );
    }

    const decisionScript = path.join(tempDirectory, "decision-hook.js");
    await fs.writeFile(
      decisionScript,
      'process.stdout.write(JSON.stringify({ decision: "allow" }));',
      "utf8"
    );
    const encodedDecisionHook = Buffer.from(
      `${shellQuote(process.execPath)} ${shellQuote(decisionScript)}`,
      "utf8"
    ).toString("base64");

    const permissionCases = [
      {
        harness: "claude" as const,
        hookArgs: [encodedDecisionHook],
        payload: {
          hook_event_name: "PermissionRequest",
          session_id: "claude-permission",
        },
      },
      {
        harness: "qwen" as const,
        hookArgs: [encodedDecisionHook],
        payload: {
          hook_event_name: "PermissionRequest",
          session_id: "qwen-permission",
        },
      },
      {
        harness: "copilot" as const,
        hookArgs: ["permissionRequest", encodedDecisionHook],
        payload: {
          hook_event_name: "PermissionRequest",
          sessionId: "copilot-permission",
        },
      },
    ];

    for (const permissionCase of permissionCases) {
      const notifyDir = path.join(
        tempDirectory,
        `${permissionCase.harness}-permission`
      );
      const result = await runHook(
        permissionCase.harness,
        notifyDir,
        permissionCase.hookArgs,
        permissionCase.payload,
        hookEnvironment(
          `run-${permissionCase.harness}-permission`,
          "notification"
        )
      );

      assert.strictEqual(result.code, 0, result.stderr);
      assert.strictEqual(result.stdout, '{"decision":"allow"}');
      assert.deepStrictEqual(await readJsonFiles(notifyDir), []);
    }
  });
});
