import * as assert from "assert";
import { OpenCodeLogParser } from "../../../core/harness/opencode/OpenCodeLogParser";
import {
  mapOpenCodeDurableEventToBaseCliEvent,
  mapOpenCodeDurableEventsToBaseCliEvents,
  type OpenCodeDurableEvent,
} from "../../../core/harness/opencode/OpenCodeEventMapper";
import {
  OPENCODE_DURABLE_EVENT_TYPES,
  OPENCODE_EVENT_TYPES,
} from "../../../core/harness/opencode/OpenCodeProtocolConstants";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../../types/DashboardConstants";

const LIVE_STEP_ENDED_FIXTURE = {
  id: "evt_...",
  type: "session.next.step.ended",
  durable: { aggregateID: "ses_...", seq: 6, version: 2 },
  data: {
    timestamp: 1788214171834,
    sessionID: "ses_...",
    assistantMessageID: "msg_...",
    finish: "stop",
    cost: 0,
    tokens: {
      input: 3396,
      output: 76,
      reasoning: 138,
      cache: { read: 0, write: 0 },
    },
  },
} as unknown as OpenCodeDurableEvent;

const LIVE_EVENT_TYPE_SEQUENCE = [
  "session.next.prompt.admitted",
  "session.next.prompted",
  "session.next.step.started",
  "session.next.text.started",
  "session.next.text.ended",
  "session.next.step.ended",
] as const;

function makeDurableEvent(
  type: string,
  data: Record<string, unknown>,
  seq = 1
): OpenCodeDurableEvent {
  return {
    id: `evt_test_${seq}`,
    type,
    durable: { aggregateID: "ses_test", seq, version: 1 },
    data,
  } as unknown as OpenCodeDurableEvent;
}

function baseData(timestamp = 1000): Record<string, unknown> {
  return { timestamp, sessionID: "ses_test" };
}

suite("OpenCode durable event mapper", () => {
  test("maps the live step-ended payload and derives its missing total", () => {
    const mapped = mapOpenCodeDurableEventToBaseCliEvent(
      LIVE_STEP_ENDED_FIXTURE
    );

    assert.ok(mapped);
    assert.strictEqual(mapped.type, OPENCODE_EVENT_TYPES.STEP_FINISH);
    assert.strictEqual((mapped.part as any).reason, "stop");
    assert.strictEqual((mapped.part as any).tokens.total, 3610);

    const parser = new OpenCodeLogParser();
    assert.strictEqual(parser.isComplete(mapped), true);
    assert.strictEqual(
      parser.extractResponse([mapped]).metadata.usage?.contextWindowUsedTokens,
      3610
    );
  });

  test("maps the live six-event type sequence to replayable boundaries", () => {
    const liveEvents = [
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.PROMPT_ADMITTED,
        {
          ...baseData(1788214171800),
          messageID: "msg_user",
          prompt: { text: "Inspect the workspace." },
          delivery: "steer",
        },
        1
      ),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.PROMPTED,
        {
          ...baseData(1788214171801),
          messageID: "msg_user",
          prompt: { text: "Inspect the workspace." },
          delivery: "steer",
        },
        2
      ),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.STEP_STARTED,
        {
          ...baseData(1788214171802),
          assistantMessageID: "msg_assistant",
          agent: "build",
          model: { id: "ling-3.0-flash-fin-free", providerID: "opencode" },
        },
        3
      ),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.TEXT_STARTED,
        {
          ...baseData(1788214171803),
          assistantMessageID: "msg_assistant",
          textID: "text_1",
        },
        4
      ),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.TEXT_ENDED,
        {
          ...baseData(1788214171804),
          assistantMessageID: "msg_assistant",
          textID: "text_1",
          text: "Done.",
        },
        5
      ),
      LIVE_STEP_ENDED_FIXTURE,
    ];

    assert.deepStrictEqual(
      liveEvents.map((event) => event.type),
      LIVE_EVENT_TYPE_SEQUENCE
    );

    const mapped = mapOpenCodeDurableEventsToBaseCliEvents(liveEvents);
    assert.deepStrictEqual(
      mapped.map((event) => event.type),
      [
        OPENCODE_EVENT_TYPES.USER_TEXT,
        OPENCODE_EVENT_TYPES.STEP_START,
        OPENCODE_EVENT_TYPES.TEXT,
        OPENCODE_EVENT_TYPES.STEP_FINISH,
      ]
    );
    assert.strictEqual(
      (mapped[1].part as any).model,
      "opencode/ling-3.0-flash-fin-free"
    );
    assert.strictEqual((mapped[2].part as any).text, "Done.");
  });

  test("correlates constructed tool lifecycle events before existing tool mapping", () => {
    const called = makeDurableEvent(OPENCODE_DURABLE_EVENT_TYPES.TOOL_CALLED, {
      ...baseData(),
      assistantMessageID: "msg_assistant",
      callID: "call_question",
      tool: "question",
      input: {
        questions: [
          {
            question: "Continue?",
            header: "Next",
            options: [{ label: "Yes", description: "Proceed." }],
          },
        ],
      },
      provider: { executed: true },
    });
    const progress = makeDurableEvent(
      OPENCODE_DURABLE_EVENT_TYPES.TOOL_PROGRESS,
      {
        ...baseData(1001),
        assistantMessageID: "msg_assistant",
        callID: "call_question",
        structured: { phase: "waiting" },
        content: [{ type: "text", text: "Waiting for an answer." }],
      },
      2
    );
    const success = makeDurableEvent(
      OPENCODE_DURABLE_EVENT_TYPES.TOOL_SUCCESS,
      {
        ...baseData(1002),
        assistantMessageID: "msg_assistant",
        callID: "call_question",
        structured: { phase: "done" },
        content: [
          {
            type: "text",
            text: 'User answered your questions: "Continue?"="Yes".',
          },
        ],
        provider: { executed: true },
      },
      3
    );

    const mapped = mapOpenCodeDurableEventsToBaseCliEvents([
      called,
      progress,
      success,
    ]);
    assert.deepStrictEqual(
      mapped.map((event) => (event.part as any).state.status),
      ["pending", "pending", "completed"]
    );
    assert.deepStrictEqual(
      mapped.map((event) => (event.part as any).tool),
      ["question", "question", "question"]
    );

    const output = new OpenCodeLogParser().extractResponse(mapped);
    assert.deepStrictEqual(
      output.events.map((event) => event.type),
      [
        CLI_EVENT_TYPES.ASK_USER_QUESTION,
        CLI_EVENT_TYPES.ASK_USER_QUESTION,
        CLI_EVENT_TYPES.ASK_USER_QUESTION,
      ]
    );
    assert.strictEqual(
      (output.events[2].data as any).status,
      OPERATION_STATUS.COMPLETED
    );
    assert.strictEqual(
      (output.events[2].data as any).questions[0].answer,
      "Yes"
    );
  });

  test("maps constructed reasoning, retry, compaction, and failed-tool variants", () => {
    const events = [
      makeDurableEvent(OPENCODE_DURABLE_EVENT_TYPES.REASONING_STARTED, {
        ...baseData(),
        assistantMessageID: "msg_assistant",
        reasoningID: "reason_1",
      }),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.REASONING_ENDED,
        {
          ...baseData(1001),
          assistantMessageID: "msg_assistant",
          reasoningID: "reason_1",
          text: "I should inspect the project first.",
        },
        2
      ),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.COMPACTION_STARTED,
        {
          ...baseData(1002),
          messageID: "msg_assistant",
          reason: "auto",
        },
        3
      ),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.COMPACTION_ENDED,
        {
          ...baseData(1003),
          messageID: "msg_assistant",
          reason: "auto",
          text: "Summary",
          recent: "Recent context",
        },
        4
      ),
      makeDurableEvent(
        OPENCODE_DURABLE_EVENT_TYPES.RETRIED,
        {
          ...baseData(1004),
          attempt: 2,
          error: { message: "temporary failure" },
        },
        5
      ),
    ];

    const mapped = mapOpenCodeDurableEventsToBaseCliEvents(events);
    assert.deepStrictEqual(
      mapped.map((event) => event.type),
      [
        OPENCODE_EVENT_TYPES.THINKING,
        OPENCODE_EVENT_TYPES.COMPACTION,
        OPENCODE_EVENT_TYPES.COMPACTION,
        OPENCODE_EVENT_TYPES.RETRY,
      ]
    );
    assert.strictEqual(
      (mapped[0].part as any).text,
      "I should inspect the project first."
    );
    assert.strictEqual((mapped[1].part as any).auto, true);
    assert.strictEqual((mapped[2].part as any).summary, "Summary");
    assert.strictEqual((mapped[3].part as any).error, "temporary failure");
  });

  test("maps a constructed failed tool as a completed unsuccessful result", () => {
    const called = makeDurableEvent(OPENCODE_DURABLE_EVENT_TYPES.TOOL_CALLED, {
      ...baseData(),
      assistantMessageID: "msg_assistant",
      callID: "call_failed",
      tool: "custom_tool",
      input: { value: 1 },
      provider: { executed: true },
    });
    const failed = makeDurableEvent(
      OPENCODE_DURABLE_EVENT_TYPES.TOOL_FAILED,
      {
        ...baseData(1001),
        assistantMessageID: "msg_assistant",
        callID: "call_failed",
        error: { message: "permission denied" },
        provider: { executed: true },
      },
      2
    );

    const output = new OpenCodeLogParser().extractResponse(
      mapOpenCodeDurableEventsToBaseCliEvents([called, failed])
    );
    const failedEvent = output.events[1].data as any;
    assert.strictEqual(failedEvent.result.success, false);
    assert.strictEqual(failedEvent.result.error, "permission denied");
  });

  test("keeps durable edit data compatible with the shared structured-patch mapper", () => {
    const called = makeDurableEvent(OPENCODE_DURABLE_EVENT_TYPES.TOOL_CALLED, {
      ...baseData(),
      assistantMessageID: "msg_assistant",
      callID: "call_edit",
      tool: "edit",
      input: {
        filePath: "src/example.ts",
        oldString: "const oldValue = 1;",
        newString: "const newValue = 2;",
      },
      provider: { executed: true },
    });
    const success = makeDurableEvent(
      OPENCODE_DURABLE_EVENT_TYPES.TOOL_SUCCESS,
      {
        ...baseData(1001),
        assistantMessageID: "msg_assistant",
        callID: "call_edit",
        structured: {
          filediff: {
            before: "const oldValue = 1;\n",
            after: "const newValue = 2;\n",
          },
        },
        content: [{ type: "text", text: "Edited the file." }],
        provider: { executed: true },
      },
      2
    );

    const output = new OpenCodeLogParser().extractResponse(
      mapOpenCodeDurableEventsToBaseCliEvents([called, success])
    );
    const edit = output.events[1].data as any;
    assert.strictEqual(edit.path, "src/example.ts");
    assert.strictEqual(edit.success, true);
    assert.ok(edit.structuredPatch?.[0].lines.includes("-const oldValue = 1;"));
    assert.ok(edit.structuredPatch?.[0].lines.includes("+const newValue = 2;"));
  });

  test("returns undefined for non-displayable lifecycle starts", () => {
    const event = makeDurableEvent(OPENCODE_DURABLE_EVENT_TYPES.TEXT_STARTED, {
      ...baseData(),
      assistantMessageID: "msg_assistant",
      textID: "text_1",
    });
    assert.strictEqual(mapOpenCodeDurableEventToBaseCliEvent(event), undefined);
  });
});
