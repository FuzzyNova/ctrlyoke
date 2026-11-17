import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { CodexLogParser } from "../../core/harness/codex/CodexLogParser";
import {
  CODEX_COLLABORATION_NAMESPACES,
  CODEX_EVENT_TYPES,
  CODEX_PAYLOAD_TYPES,
  CODEX_ROLLOUT_FILE_PREFIX,
  CODEX_ROLLOUT_FILE_SUFFIX,
  CODEX_ITEM_TYPES,
  CODEX_SUBAGENT_ACTIVITY_KINDS,
  CODEX_TOOL_NAMES,
} from "../../core/harness/codex/CodexProtocolConstants";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { HARNESS_HOME_ENV_VARS } from "../../utils/HarnessHome";
import type { BaseCliEvent } from "../../core/harness/shared/interfaces/ILogParser";

function writeRollout(
  directory: string,
  sessionId: string,
  events: unknown[]
): void {
  fs.writeFileSync(
    path.join(
      directory,
      `${CODEX_ROLLOUT_FILE_PREFIX}2026-11-16T00-00-00-${sessionId}${CODEX_ROLLOUT_FILE_SUFFIX}`
    ),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
}

suite("CodexLogParser", () => {
  test("inline prompt echoes match the user's prompt section", () => {
    const parser = new CodexLogParser();
    const dispatchedPromptText =
      "<ctrlyokePrompt>\n<agentInstructions>generated rules</agentInstructions>\n<userPrompt>\nPlease inspect the workflow parser\n</userPrompt>\n</ctrlyokePrompt>";
    const event = {
      type: CODEX_EVENT_TYPES.EVENT_MSG,
      line: "user_message",
      payload: {
        type: CODEX_PAYLOAD_TYPES.USER_MESSAGE,
        message: dispatchedPromptText,
      },
    };

    assert.strictEqual(
      parser.classifyUserEvent(event, { dispatchedPromptText }),
      "injected-prompt"
    );
    assert.strictEqual(
      parser.classifyUserEvent(
        {
          ...event,
          payload: {
            ...event.payload,
            message: dispatchedPromptText.replace(
              "Please inspect the workflow parser",
              "Please inspect another workflow"
            ),
          },
        },
        { dispatchedPromptText }
      ),
      "human-steer"
    );
  });

  test("registers app-server subagents and follows their rollout logs", async () => {
    const home = makeTempDir("codex-app-server-subagent-");
    const previousCodexHome = process.env[HARNESS_HOME_ENV_VARS.CODEX_HOME];
    process.env[HARNESS_HOME_ENV_VARS.CODEX_HOME] = home;
    try {
      const directory = path.join(home, "sessions", "2026", "11", "16");
      fs.mkdirSync(directory, { recursive: true });

      const parentThreadId = "parent-thread";
      const childThreadId = "child-thread";
      const parentToolCallId = "spawn-call";
      writeRollout(directory, parentThreadId, [
        {
          type: CODEX_EVENT_TYPES.SESSION_META,
          payload: {
            id: parentThreadId,
            model: "test-model",
            cli_version: "0.169.0",
          },
        },
      ]);
      writeRollout(directory, childThreadId, [
        {
          type: CODEX_EVENT_TYPES.SESSION_META,
          payload: {
            id: childThreadId,
            parent_thread_id: parentThreadId,
            agent_path: "/root/alpha",
            source: {
              subagent: {
                thread_spawn: { agent_nickname: "Alpha" },
              },
            },
          },
        },
        {
          type: CODEX_EVENT_TYPES.EVENT_MSG,
          payload: {
            type: CODEX_PAYLOAD_TYPES.TASK_STARTED,
            turn_attribution: { initiating_agent_path: null },
          },
        },
        {
          type: CODEX_EVENT_TYPES.EVENT_MSG,
          payload: {
            type: CODEX_PAYLOAD_TYPES.TASK_STARTED,
            turn_attribution: { initiating_agent_path: "/root" },
          },
        },
        {
          type: CODEX_EVENT_TYPES.RESPONSE_ITEM,
          payload: {
            type: CODEX_PAYLOAD_TYPES.CUSTOM_TOOL_CALL,
            name: CODEX_TOOL_NAMES.EXEC,
            call_id: "child-exec",
            input:
              'const r = await tools.exec_command({cmd:"echo codex-app-server-child"}); text(r.output);',
          },
        },
        {
          type: CODEX_EVENT_TYPES.EVENT_MSG,
          payload: { type: CODEX_PAYLOAD_TYPES.TASK_COMPLETE },
        },
      ]);

      const parser = new CodexLogParser();
      const parentEvents: BaseCliEvent[] = [
        {
          type: CODEX_EVENT_TYPES.SESSION_META,
          payload: { id: parentThreadId },
        },
        {
          type: CODEX_EVENT_TYPES.RESPONSE_ITEM,
          payload: {
            type: CODEX_PAYLOAD_TYPES.FUNCTION_CALL,
            name: CODEX_TOOL_NAMES.SPAWN_AGENT,
            namespace: CODEX_COLLABORATION_NAMESPACES.COLLABORATION,
            call_id: parentToolCallId,
            arguments: { task_name: "alpha" },
          },
        },
        {
          type: CODEX_EVENT_TYPES.EVENT_MSG,
          payload: {
            type: CODEX_PAYLOAD_TYPES.ITEM_COMPLETED,
            item: {
              type: CODEX_ITEM_TYPES.SUBAGENT_ACTIVITY,
              id: parentToolCallId,
              kind: CODEX_SUBAGENT_ACTIVITY_KINDS.STARTED,
              agent_thread_id: childThreadId,
              agent_path: "/root/alpha",
            },
          },
        },
      ];
      for (const event of parentEvents) {
        parser.extractStructuredEventsFromEvent(event);
      }

      const drained = await parser.getSubagentFollower().drainToEof(1_000);
      const command = drained.events.find(
        (event) =>
          event.type === CLI_EVENT_TYPES.BASH_COMMAND &&
          JSON.stringify(event.data).includes("codex-app-server-child")
      );
      assert.ok(command, "the child rollout's command was not mapped");
      assert.strictEqual(command.subagent?.parentToolCallId, parentToolCallId);
      assert.strictEqual(command.subagent?.agentId, "/root/alpha");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env[HARNESS_HOME_ENV_VARS.CODEX_HOME];
      } else {
        process.env[HARNESS_HOME_ENV_VARS.CODEX_HOME] = previousCodexHome;
      }
      removeTempDir(home);
    }
  });
});
