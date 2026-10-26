/**
 * Tests for the inbound message dispatcher: MESSAGE_BATCH expansion, burst
 * coalescing across separate message events, failure isolation, and the
 * one-render-per-burst claim (checked against a real React root, not assumed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "zustand";
import {
  MESSAGE_TYPES,
  WINDOW_LISTENER_REPLY_TYPES,
} from "@root/types/DashboardConstants";
import type {
  BatchedDashboardMessage,
  MessageBatchMessage,
} from "@root/types/WebviewMessageTypes";

const { webviewErrorMock } = vi.hoisted(() => ({
  webviewErrorMock: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  WebviewLog: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: webviewErrorMock,
  },
}));

import {
  createInboundMessageDispatcher,
  type InboundMessageDispatcher,
} from "@hooks/inboundMessageDispatcher";

const REPLY_TYPE = [...WINDOW_LISTENER_REPLY_TYPES][0];

function message(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra } as BatchedDashboardMessage;
}

function batch(...messages: BatchedDashboardMessage[]): MessageBatchMessage {
  return { type: MESSAGE_TYPES.MESSAGE_BATCH, messages };
}

function post(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

/** Lets pending microtasks run, ending the "same task" of an immediate route. */
async function endCurrentTask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Waits past the dispatcher's next tick (and the render microtask after it). */
async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await endCurrentTask();
}

let dispatcher: InboundMessageDispatcher | undefined;
let routed: string[];

function attach(
  route: (m: BatchedDashboardMessage) => void = (m) => {
    routed.push(String(m.seq ?? m.type));
  }
): InboundMessageDispatcher {
  dispatcher = createInboundMessageDispatcher(route);
  window.addEventListener("message", dispatcher.handleEvent);
  return dispatcher;
}

beforeEach(() => {
  routed = [];
  webviewErrorMock.mockReset();
});

afterEach(() => {
  if (dispatcher) {
    window.removeEventListener("message", dispatcher.handleEvent);
    dispatcher.dispose();
    dispatcher = undefined;
  }
});

describe("MESSAGE_BATCH", () => {
  it("routes members in order, each as an ordinary message", () => {
    attach();
    post(
      batch(
        message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }),
        message(MESSAGE_TYPES.EXECUTION_STATE_CHANGED, { seq: "b" }),
        message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "c" })
      )
    );
    expect(routed).toEqual(["a", "b", "c"]);
  });

  it("isolates a failing member so the rest are still routed", () => {
    attach((m) => {
      if (m.seq === "b") throw new Error("boom");
      routed.push(String(m.seq));
    });
    post(
      batch(
        message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }),
        message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "b" }),
        message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "c" })
      )
    );
    expect(routed).toEqual(["a", "c"]);
    expect(webviewErrorMock).toHaveBeenCalledTimes(1);
    expect(String(webviewErrorMock.mock.calls[0][0])).toContain("boom");
  });

  it("hands request-scoped reply members to their own window listeners", () => {
    attach();
    const replies: unknown[] = [];
    const replyListener = (event: MessageEvent) => {
      if (event.data?.type === REPLY_TYPE) replies.push(event.data);
    };
    window.addEventListener("message", replyListener);
    try {
      const reply = message(REPLY_TYPE, { requestId: "r1" });
      post(
        batch(
          message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }),
          reply,
          message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "b" })
        )
      );
      expect(replies).toEqual([reply]);
      expect(routed).toEqual(["a", "b"]);
    } finally {
      window.removeEventListener("message", replyListener);
    }
  });
});

describe("burst coalescing", () => {
  it("routes a lone message immediately", () => {
    attach();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }));
    expect(routed).toEqual(["a"]);
  });

  it("never routes a request-scoped reply itself", () => {
    attach();
    post(message(REPLY_TYPE));
    expect(routed).toEqual([]);
  });

  it("routes messages delivered in the same task immediately", () => {
    attach();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }));
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "b" }));
    expect(routed).toEqual(["a", "b"]);
  });

  it("queues later-task arrivals inside the burst and routes them together, in order", async () => {
    attach();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }));
    await endCurrentTask();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "b" }));
    await endCurrentTask();
    post(message(MESSAGE_TYPES.EXECUTION_STATE_CHANGED, { seq: "pausing" }));
    await endCurrentTask();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "c" }));
    expect(routed).toEqual(["a"]);

    await nextTick();
    expect(routed).toEqual(["a", "b", "pausing", "c"]);
  });

  it("closes the burst window once a tick finds nothing queued", async () => {
    attach();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }));
    await nextTick();
    await nextTick();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "b" }));
    expect(routed).toEqual(["a", "b"]);
  });

  it("isolates a failing queued message", async () => {
    attach((m) => {
      if (m.seq === "b") throw new Error("queued boom");
      routed.push(String(m.seq));
    });
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }));
    await endCurrentTask();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "b" }));
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "c" }));
    await nextTick();
    expect(routed).toEqual(["a", "c"]);
    expect(webviewErrorMock).toHaveBeenCalledTimes(1);
  });

  it("routes whatever is still queued on dispose", async () => {
    const d = attach();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "a" }));
    await endCurrentTask();
    post(message(MESSAGE_TYPES.CLI_OUTPUT, { seq: "b" }));
    window.removeEventListener("message", d.handleEvent);
    d.dispose();
    dispatcher = undefined;
    expect(routed).toEqual(["a", "b"]);
  });

  it("dispatchIsolated routes synchronously and contains failures", () => {
    const d = attach((m) => {
      if (m.seq === "a") throw new Error("startup boom");
      routed.push(String(m.seq));
    });
    d.dispatchIsolated(message(MESSAGE_TYPES.INIT, { seq: "a" }));
    d.dispatchIsolated(message(MESSAGE_TYPES.INIT, { seq: "b" }));
    d.dispatchIsolated(message(REPLY_TYPE, { seq: "reply" }));
    expect(routed).toEqual(["b"]);
    expect(webviewErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("render count", () => {
  const useCounterStore = create<{ count: number }>(() => ({ count: 0 }));
  let root: Root | undefined;
  let container: HTMLElement | undefined;
  let renders = 0;
  let previousActEnvironment: unknown;
  const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown };

  function Counter() {
    const count = useCounterStore((state) => state.count);
    renders += 1;
    return createElement("span", null, String(count));
  }

  const increment = () =>
    useCounterStore.setState((state) => ({ count: state.count + 1 }));

  beforeEach(async () => {
    // Real scheduling, not act(): act() batches everything inside it and
    // would make the assertion below vacuous.
    previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    useCounterStore.setState({ count: 0 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(createElement(Counter));
    await nextTick();
    renders = 0;
  });

  afterEach(() => {
    root?.unmount();
    container?.remove();
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it("renders a batch of store writes once", async () => {
    attach(increment);
    post(
      batch(
        message(MESSAGE_TYPES.CLI_OUTPUT),
        message(MESSAGE_TYPES.CLI_OUTPUT),
        message(MESSAGE_TYPES.STATUS_MESSAGE),
        message(MESSAGE_TYPES.CLI_OUTPUT)
      )
    );
    await nextTick();
    expect(useCounterStore.getState().count).toBe(4);
    expect(container?.textContent).toBe("4");
    expect(renders).toBe(1);
  });

  it("renders a burst of separate message events twice instead of once each", async () => {
    attach(increment);
    post(message(MESSAGE_TYPES.CLI_OUTPUT));
    // The immediate message's render lands at this task boundary.
    await endCurrentTask();
    for (let i = 0; i < 5; i++) {
      post(message(MESSAGE_TYPES.CLI_OUTPUT));
      await endCurrentTask();
    }
    await nextTick();
    expect(container?.textContent).toBe("6");
    // One render for the immediate message, one for the coalesced rest —
    // routing each separately would have rendered six times.
    expect(renders).toBe(2);
  });

  it("control: uncoalesced writes at the same boundaries render once each", async () => {
    // Same spacing as the burst test, without the dispatcher: proves that
    // each boundary there would otherwise have cost its own render.
    increment();
    await endCurrentTask();
    for (let i = 0; i < 5; i++) {
      increment();
      await endCurrentTask();
    }
    await nextTick();
    expect(container?.textContent).toBe("6");
    expect(renders).toBe(6);
  });
});
