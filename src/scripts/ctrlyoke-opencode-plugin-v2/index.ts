// ctrlyoke OpenCode 2 plugin entry
//
// Source: src/scripts/ctrlyoke-opencode-plugin-v2/index.ts
// Loaded by OpenCode 2 from the extension installation through inline config
// (`plugins: ["<this directory>"]`). OpenCode 2 skips a configured local plugin
// path that names a file, so this entry is a directory.
//
// Completion and notification behaviour lives in ../ctrlyoke-opencode-plugin.ts,
// the OpenCode 1 plugin. This file adapts the OpenCode 2 plugin API onto it and
// owns the OpenCode 2.3+ headless control bridge:
//  - OpenCode 2 events are `{ type, data }`; OpenCode 1 handlers read
//    `{ type, properties }` and a different vocabulary, translated below.
//  - OpenCode 2 tool hooks receive one mutable event; OpenCode 1 hooks take
//    separate input/output objects.
//
// The import is extensionless because tsc compiles src/scripts; OpenCode
// resolves it to the copied .ts source, which both its Bun and Node runtimes
// try before the compiled .js beside it.
//
// This file must remain TypeScript with ESM import/export syntax.

import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { CtrlYokeHook } from "../ctrlyoke-opencode-plugin";

type V1Handlers = Awaited<ReturnType<typeof CtrlYokeHook>>;
type V1Event = Parameters<V1Handlers["event"]>[0]["event"];

/** The slice of the OpenCode 2 plugin context this entry uses. */
interface OpenCodeV2PluginContext {
  event: {
    subscribe(options: {
      signal: AbortSignal;
    }): AsyncIterable<{ type: string; data?: Record<string, unknown> }>;
  };
  tool: {
    hook(
      name: "execute.before" | "execute.after",
      callback: (event: OpenCodeV2ToolHookEvent) => unknown
    ): Promise<unknown>;
  };
  permission: {
    hook(
      name: "evaluate",
      callback: (event: OpenCodeV2PermissionHookEvent) => Promise<void>
    ): Promise<unknown>;
  };
  session: {
    prompt(options: {
      sessionID: string;
      text: string;
      delivery: "steer";
    }): Promise<unknown>;
  };
}

interface OpenCodeV2PermissionHookEvent {
  sessionID: string;
  agent: string;
  action: string;
  resources: unknown;
  source: string;
  effect: "allow" | "deny" | "ask";
  message?: string;
}

interface OpenCodeV2ToolHookEvent {
  tool: string;
  sessionID: string;
  id: string;
  input?: unknown;
  status?: string;
  result?: { content?: unknown; metadata?: unknown };
}

/** OpenCode 2 event types this entry translates. */
const V2_EVENTS = {
  SESSION_CREATED: "session.created",
  SESSION_DELETED: "session.deleted",
  EXECUTION_STARTED: "session.execution.started",
  EXECUTION_SUCCEEDED: "session.execution.succeeded",
  EXECUTION_FAILED: "session.execution.failed",
  EXECUTION_INTERRUPTED: "session.execution.interrupted",
  PERMISSION_ASKED: "permission.asked",
  TOOL_INPUT_STARTED: "session.tool.input.started",
  TOOL_CALLED: "session.tool.called",
  TOOL_PROGRESS: "session.tool.progress",
  TOOL_SUCCESS: "session.tool.success",
  TOOL_FAILED: "session.tool.failed",
  TEXT_ENDED: "session.text.ended",
  REASONING_ENDED: "session.reasoning.ended",
  STEP_ENDED: "session.step.ended",
} as const;

/** OpenCode 1 event types the shared handlers understand. */
const V1_EVENTS = {
  SESSION_CREATED: "session.created",
  SESSION_UPDATED: "session.updated",
  SESSION_DELETED: "session.deleted",
  SESSION_STATUS: "session.status",
  SESSION_ERROR: "session.error",
  PERMISSION_ASKED: "permission.asked",
  PART_UPDATED: "message.part.updated",
} as const;

const SESSION_STATUS = { BUSY: "busy", IDLE: "idle" } as const;
const TOOL_STATUS = {
  RUNNING: "running",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

const SUBAGENT_RECORD = {
  FILE_SUFFIX: "-subagents.jsonl",
  KIND_PART: "part",
  PART_TOOL: "tool",
} as const;

// Keep these bridge names and route paths aligned with
// OpenCodeProtocolConstants.ts. The script is copied verbatim, not bundled.
const CONTROL_ENV = {
  URL: "CTRLYOKE_OPENCODE_CONTROL_URL",
  TOKEN: "CTRLYOKE_OPENCODE_CONTROL_TOKEN",
} as const;

const CONTROL_ROUTES = {
  PERMISSION: "/permission",
  SESSION_EVENT: "/session-event",
  STEER: "/steer",
} as const;

const CONTROL_DECISIONS = {
  ONCE: "once",
  REJECT: "reject",
} as const;

const CONTROL_PERMISSION_EFFECTS = {
  ALLOW: "allow",
  DENY: "deny",
  ASK: "ask",
} as const;

const OPENCODE_BOOLEAN_TRUE = "true" as const;

const CONTROL_FAILURE_MESSAGE =
  "ctrlyoke: the OpenCode approval bridge could not be reached; the tool was denied.";
const DIAGNOSTIC_LOG_PATH = (() => {
  if (process.env.CTRLYOKE_DIAGNOSTIC_LOGS !== OPENCODE_BOOLEAN_TRUE) {
    return undefined;
  }
  const workspaceRoot = process.env.CTRLYOKE_WORKSPACE_ROOT ?? process.cwd();
  const logDirectory = path.join(workspaceRoot, ".ctrlyoke", "logs");
  try {
    mkdirSync(logDirectory, { recursive: true });
    return path.join(logDirectory, "ctrlyoke-opencode-plugin-debug.log");
  } catch {
    return undefined;
  }
})();

type Data = Record<string, unknown>;

interface OpenCodeControlBridge {
  url: string;
  token: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Data | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Data)
    : undefined;
}

/** Text of an OpenCode 2 tool result's `content` array. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((item) => str(record(item)?.text) ?? "").join("");
}

function appendChildToolPart(
  translator: EventTranslator,
  event: OpenCodeV2ToolHookEvent
): void {
  const notifyDir = process.env.CTRLYOKE_NOTIFY_DIR;
  const runId = process.env.CTRLYOKE_RUN_ID;
  if (!notifyDir || !runId || !translator.isChildSession(event.sessionID))
    return;

  // execute.after runs only once the call has ended. OpenCode 2.3's hook
  // payload does not consistently include `status`, so infer success unless
  // the hook explicitly reports an error.
  const status =
    event.status === TOOL_STATUS.ERROR
      ? TOOL_STATUS.ERROR
      : TOOL_STATUS.COMPLETED;

  const result = event.result;
  const record = {
    kind: SUBAGENT_RECORD.KIND_PART,
    childSessionId: event.sessionID,
    part: {
      type: SUBAGENT_RECORD.PART_TOOL,
      id: `tool:${event.id}`,
      sessionID: event.sessionID,
      messageID: "",
      callID: event.id,
      tool: event.tool,
      state: {
        status,
        input: event.input ?? {},
        output: contentText(result?.content),
        ...(result?.metadata !== undefined
          ? { metadata: result.metadata }
          : {}),
      },
    },
  };

  try {
    mkdirSync(notifyDir, { recursive: true });
    appendFileSync(
      path.join(notifyDir, `${runId}${SUBAGENT_RECORD.FILE_SUFFIX}`),
      `${JSON.stringify(record)}\n`
    );
  } catch (error) {
    logControlFailure(
      "Could not append child tool to the subagent sidecar",
      error
    );
  }
}

/**
 * OpenCode 1 reported a subagent's child as `metadata.sessionId`; OpenCode 2
 * calls it `sessionID`. Add the V1 key so the shared handlers find it.
 */
function v1Metadata(metadata: unknown): Data {
  const value = record(metadata) ?? {};
  const child = str(value.sessionID);
  return child && value.sessionId === undefined
    ? { ...value, sessionId: child }
    : value;
}

function controlBridgeFromEnvironment(): OpenCodeControlBridge | undefined {
  const url = process.env[CONTROL_ENV.URL];
  const token = process.env[CONTROL_ENV.TOKEN];
  delete process.env[CONTROL_ENV.URL];
  delete process.env[CONTROL_ENV.TOKEN];
  return url && token ? { url, token } : undefined;
}

function controlHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function postControlJson(
  bridge: OpenCodeControlBridge,
  route: string,
  body: Data,
  signal: AbortSignal
): Promise<Response> {
  return fetch(new URL(route, bridge.url), {
    method: "POST",
    headers: {
      ...controlHeaders(bridge.token),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logControlFailure(message: string, error: unknown): void {
  if (!DIAGNOSTIC_LOG_PATH) return;
  try {
    appendFileSync(
      DIAGNOSTIC_LOG_PATH,
      `[${new Date().toISOString()}] ${message}: ${describeError(error)}\n`
    );
  } catch {
    // Diagnostics are best-effort and must not break plugin control handling.
  }
}

function isPermissionReply(
  value: unknown
): value is { decision: string; message?: string } {
  return (
    record(value) !== undefined &&
    typeof record(value)?.decision === "string" &&
    (record(value)?.message === undefined ||
      typeof record(value)?.message === "string")
  );
}

async function applyPermissionDecision(
  bridge: OpenCodeControlBridge,
  event: OpenCodeV2PermissionHookEvent,
  signal: AbortSignal
): Promise<void> {
  if (event.effect !== CONTROL_PERMISSION_EFFECTS.ASK) return;
  try {
    const response = await postControlJson(
      bridge,
      CONTROL_ROUTES.PERMISSION,
      {
        sessionID: event.sessionID,
        agent: event.agent,
        action: event.action,
        resources: event.resources,
        source: event.source,
        effect: event.effect,
      },
      signal
    );
    if (!response.ok) {
      throw new Error(
        `OpenCode approval bridge returned HTTP ${response.status}`
      );
    }
    const reply: unknown = await response.json();
    if (!isPermissionReply(reply)) {
      throw new Error("OpenCode approval bridge returned an invalid decision");
    }
    event.effect =
      reply.decision === CONTROL_DECISIONS.ONCE
        ? CONTROL_PERMISSION_EFFECTS.ALLOW
        : CONTROL_PERMISSION_EFFECTS.DENY;
    if (reply.message !== undefined) event.message = reply.message;
  } catch (error) {
    if (signal.aborted) return;
    event.effect = CONTROL_PERMISSION_EFFECTS.DENY;
    event.message = CONTROL_FAILURE_MESSAGE;
    logControlFailure("OpenCode approval bridge failed", error);
  }
}

function startSteerPolling(
  bridge: OpenCodeControlBridge,
  session: OpenCodeV2PluginContext["session"],
  sessionID: string,
  signal: AbortSignal
): void {
  void (async () => {
    while (!signal.aborted) {
      try {
        const url = new URL(CONTROL_ROUTES.STEER, bridge.url);
        url.searchParams.set("sessionID", sessionID);
        const response = await fetch(url, {
          headers: controlHeaders(bridge.token),
          signal,
        });
        if (response.status === 204 || response.status === 410) return;
        if (!response.ok) {
          throw new Error(
            `OpenCode steer bridge returned HTTP ${response.status}`
          );
        }
        const delivery: unknown = await response.json();
        const value = record(delivery);
        const text = str(value?.text);
        if (!text) continue;
        await session.prompt({ sessionID, text, delivery: "steer" });
      } catch (error) {
        if (!signal.aborted) {
          logControlFailure("OpenCode steer delivery failed", error);
        }
        return;
      }
    }
  })();
}

/** Translate OpenCode 2's event stream into OpenCode 1 handler events. */
class EventTranslator {
  private readonly parents = new Map<string, string>();
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  /** Sessions whose current execution already reported its end. */
  private readonly ended = new Set<string>();

  isChildSession(sessionID: string): boolean {
    return this.parents.has(sessionID);
  }

  translate(type: string, data: Data): V1Event[] {
    const sessionID = str(data.sessionID);
    switch (type) {
      case V2_EVENTS.SESSION_CREATED: {
        const parentID = str(data.parentID);
        if (sessionID && parentID) this.parents.set(sessionID, parentID);
        return sessionID
          ? [
              this.v1(V1_EVENTS.SESSION_CREATED, {
                info: { ...data, id: sessionID, parentID },
              }),
            ]
          : [];
      }
      case V2_EVENTS.SESSION_DELETED:
        if (sessionID) this.parents.delete(sessionID);
        return sessionID
          ? [this.v1(V1_EVENTS.SESSION_DELETED, { info: { id: sessionID } })]
          : [];
      case V2_EVENTS.EXECUTION_STARTED:
        if (!sessionID) return [];
        this.ended.delete(sessionID);
        // The main session's session.created is published before this
        // plugin subscribes (as in OpenCode 1, #14808), so session.updated is
        // what records the main session and writes the start file.
        return [
          this.v1(V1_EVENTS.SESSION_UPDATED, {
            info: { id: sessionID, parentID: this.parents.get(sessionID) },
          }),
          this.status(sessionID, SESSION_STATUS.BUSY),
        ];
      case V2_EVENTS.EXECUTION_SUCCEEDED:
      case V2_EVENTS.EXECUTION_INTERRUPTED:
        return sessionID ? this.end(sessionID) : [];
      case V2_EVENTS.EXECUTION_FAILED:
        if (!sessionID) return [];
        return [
          this.v1(V1_EVENTS.SESSION_ERROR, {
            sessionID,
            error: data.error,
          }),
          ...this.end(sessionID),
        ];
      case V2_EVENTS.PERMISSION_ASKED:
        return [
          this.v1(V1_EVENTS.PERMISSION_ASKED, { ...data, type: data.action }),
        ];
      case V2_EVENTS.TOOL_INPUT_STARTED:
        this.rememberTool(data, str(data.name));
        return [];
      case V2_EVENTS.TOOL_CALLED:
        this.rememberTool(data, undefined, data.input);
        return [];
      case V2_EVENTS.TOOL_PROGRESS:
        return this.toolPart(data, TOOL_STATUS.RUNNING);
      case V2_EVENTS.TOOL_SUCCESS:
        return this.toolPart(data, TOOL_STATUS.COMPLETED);
      case V2_EVENTS.TOOL_FAILED:
        return this.toolPart(data, TOOL_STATUS.ERROR);
      case V2_EVENTS.TEXT_ENDED:
      case V2_EVENTS.REASONING_ENDED:
        return this.childTextPart(
          data,
          type === V2_EVENTS.TEXT_ENDED ? "text" : "reasoning"
        );
      case V2_EVENTS.STEP_ENDED:
        return this.childStepPart(data);
      default:
        return [];
    }
  }

  private v1(type: string, properties: Data): V1Event {
    return { type, properties };
  }

  private status(sessionID: string, status: string): V1Event {
    return this.v1(V1_EVENTS.SESSION_STATUS, {
      sessionID,
      status: { type: status },
    });
  }

  /** One idle per execution, whichever terminal event arrives first. */
  private end(sessionID: string): V1Event[] {
    if (this.ended.has(sessionID)) return [];
    this.ended.add(sessionID);
    return [this.status(sessionID, SESSION_STATUS.IDLE)];
  }

  private toolKey(data: Data): string {
    return `${str(data.sessionID)}\u0000${str(data.id)}`;
  }

  private rememberTool(data: Data, name?: string, input?: unknown): void {
    const key = this.toolKey(data);
    const current = this.tools.get(key);
    this.tools.set(key, {
      name: name ?? current?.name ?? "tool",
      input: input ?? current?.input ?? {},
    });
  }

  /**
   * A tool part in the OpenCode 1 `message.part.updated` shape. The shared
   * handlers use these for child-session (subagent) activity and for a
   * parent's running subagent call; any other part is ignored there.
   */
  private toolPart(data: Data, status: string): V1Event[] {
    const sessionID = str(data.sessionID);
    const callID = str(data.id);
    if (!sessionID || !callID) return [];
    const tool = this.tools.get(this.toolKey(data));
    if (status !== TOOL_STATUS.RUNNING) this.tools.delete(this.toolKey(data));
    const error = str(record(data.error)?.message);
    return [
      this.v1(V1_EVENTS.PART_UPDATED, {
        part: {
          type: "tool",
          id: `tool:${callID}`,
          sessionID,
          messageID: str(data.assistantMessageID) ?? "",
          callID,
          tool: tool?.name ?? "tool",
          state: {
            status,
            input: tool?.input ?? {},
            output: contentText(data.content),
            ...(error !== undefined ? { error } : {}),
            metadata: v1Metadata(data.metadata),
          },
        },
      }),
    ];
  }

  private childTextPart(data: Data, partType: string): V1Event[] {
    const sessionID = str(data.sessionID);
    if (!sessionID || !this.parents.has(sessionID)) return [];
    const messageID = str(data.assistantMessageID) ?? "";
    return [
      this.v1(V1_EVENTS.PART_UPDATED, {
        part: {
          type: partType,
          id: `${messageID}:${partType}:${String(data.ordinal)}`,
          sessionID,
          messageID,
          text: str(data.text) ?? "",
        },
      }),
    ];
  }

  private childStepPart(data: Data): V1Event[] {
    const sessionID = str(data.sessionID);
    if (!sessionID || !this.parents.has(sessionID)) return [];
    const messageID = str(data.assistantMessageID) ?? "";
    return [
      this.v1(V1_EVENTS.PART_UPDATED, {
        part: {
          type: "step-finish",
          id: `${messageID}:step-finish`,
          sessionID,
          messageID,
          reason: data.finish,
          tokens: data.tokens,
          cost: data.cost,
        },
      }),
    ];
  }
}

export default {
  id: "ctrlyoke",
  async setup(ctx: OpenCodeV2PluginContext) {
    const handlers = await CtrlYokeHook({});
    const translator = new EventTranslator();
    const controller = new AbortController();
    const controlBridge = controlBridgeFromEnvironment();
    let controlSessionID: string | undefined;
    let steeringController: AbortController | undefined;

    if (controlBridge) {
      await ctx.permission.hook("evaluate", async (event) => {
        if (event.effect === CONTROL_PERMISSION_EFFECTS.ASK) {
          for (const translated of translator.translate(
            V2_EVENTS.PERMISSION_ASKED,
            { ...event }
          )) {
            await handlers.event({ event: translated });
          }
        }
        await applyPermissionDecision(controlBridge, event, controller.signal);
      });
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          const eventData = event.data ?? {};
          const sessionID = str(eventData.sessionID);
          if (
            controlBridge &&
            sessionID &&
            event.type === V2_EVENTS.EXECUTION_STARTED &&
            !translator.isChildSession(sessionID) &&
            !str(eventData.parentID) &&
            !controlSessionID
          ) {
            controlSessionID = sessionID;
            steeringController = new AbortController();
            controller.signal.addEventListener(
              "abort",
              () => steeringController?.abort(),
              { once: true }
            );
            const response = await postControlJson(
              controlBridge,
              CONTROL_ROUTES.SESSION_EVENT,
              {
                type: event.type,
                sessionID,
                parentID: str(eventData.parentID),
              },
              controller.signal
            );
            if (!response.ok) {
              throw new Error(
                `OpenCode session bridge returned HTTP ${response.status}`
              );
            }
            startSteerPolling(
              controlBridge,
              ctx.session,
              sessionID,
              steeringController.signal
            );
          } else if (
            controlBridge &&
            sessionID === controlSessionID &&
            (event.type === V2_EVENTS.EXECUTION_SUCCEEDED ||
              event.type === V2_EVENTS.EXECUTION_FAILED ||
              event.type === V2_EVENTS.EXECUTION_INTERRUPTED)
          ) {
            const response = await postControlJson(
              controlBridge,
              CONTROL_ROUTES.SESSION_EVENT,
              { type: event.type, sessionID },
              controller.signal
            );
            if (!response.ok) {
              throw new Error(
                `OpenCode session bridge returned HTTP ${response.status}`
              );
            }
            steeringController?.abort();
          }
          for (const translated of translator.translate(
            event.type,
            eventData
          )) {
            await handlers.event({ event: translated });
          }
        }
      } catch (error) {
        steeringController?.abort();
        if (!controller.signal.aborted) {
          logControlFailure("OpenCode event handling failed", error);
        }
      }
    })();

    await ctx.tool.hook("execute.before", (event) =>
      handlers["tool.execute.before"](
        { tool: event.tool, sessionID: event.sessionID, callID: event.id },
        { args: event.input }
      )
    );
    await ctx.tool.hook("execute.after", (event) => {
      appendChildToolPart(translator, event);
      return handlers["tool.execute.after"](
        {
          tool: event.tool,
          sessionID: event.sessionID,
          callID: event.id,
          args: event.input,
        },
        {
          title: event.tool,
          output: contentText(event.result?.content),
          metadata: event.result?.metadata,
        }
      );
    });

    return () => {
      controller.abort();
      steeringController?.abort();
    };
  },
};
