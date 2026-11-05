// ctrlyoke OpenCode 2 plugin entry
//
// Source: src/scripts/ctrlyoke-opencode-plugin-v2/index.ts
// Loaded by OpenCode 2 from the extension installation through inline config
// (`plugins: ["<this directory>"]`). OpenCode 2 skips a configured local plugin
// path that names a file, so this entry is a directory.
//
// All behaviour lives in ../ctrlyoke-opencode-plugin.ts, the OpenCode 1
// plugin. This file only adapts the OpenCode 2 plugin API onto it:
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

type Data = Record<string, unknown>;

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

/** Translate OpenCode 2's event stream into OpenCode 1 handler events. */
class EventTranslator {
  private readonly parents = new Map<string, string>();
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  /** Sessions whose current execution already reported its end. */
  private readonly ended = new Set<string>();

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

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          for (const translated of translator.translate(
            event.type,
            event.data ?? {}
          )) {
            await handlers.event({ event: translated });
          }
        }
      } catch {
        // The subscription ends with an abort when the plugin unloads.
      }
    })();

    await ctx.tool.hook("execute.before", (event) =>
      handlers["tool.execute.before"](
        { tool: event.tool, sessionID: event.sessionID, callID: event.id },
        { args: event.input }
      )
    );
    await ctx.tool.hook("execute.after", (event) =>
      handlers["tool.execute.after"](
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
      )
    );

    return () => controller.abort();
  },
};
