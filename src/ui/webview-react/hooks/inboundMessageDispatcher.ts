import {
  MESSAGE_TYPES,
  WINDOW_LISTENER_REPLY_TYPES,
  type MessageType,
} from "@root/types/DashboardConstants";
import type {
  BatchedDashboardMessage,
  MessageBatchMessage,
} from "@root/types/WebviewMessageTypes";
import { WebviewLog } from "@utils/logger";

/**
 * Coalesces inbound extension → webview messages so a burst costs one React
 * render instead of one per message.
 *
 * Each `MessageEvent` is its own browser task, and React (automatic batching)
 * renders once per task in which a store changed. The output pane's row model
 * is rebuilt on every `workflowStore` write, which costs seconds on a large
 * run, so a burst of N messages used to cost N full rebuilds while later
 * messages — `EXECUTION_STATE_CHANGED` included — waited behind them.
 *
 * Two mechanisms, both strictly order-preserving:
 *
 * 1. A `MESSAGE_BATCH` envelope's members are routed one after another in the
 *    same task, each isolated so one failing handler cannot drop the rest.
 * 2. Separate events are coalesced. A message that arrives while nothing is
 *    queued and no burst is in progress is routed immediately (zero added
 *    latency). That opens a short burst window lasting until the next task
 *    tick; messages arriving in later tasks inside that window are queued and
 *    routed together on the tick, in one task, so they render once. The
 *    window stays open while ticks keep finding work and closes on the first
 *    idle tick. Messages delivered synchronously in the same task as an
 *    immediate one are routed immediately too — React cannot render between
 *    them anyway, so queueing them would only add latency.
 *
 * The tick never depends on `requestAnimationFrame`, which does not fire while
 * the webview is hidden; it uses a macrotask (`setImmediate`, else a
 * `MessageChannel`, else `setTimeout`).
 *
 * Request-scoped replies (`WINDOW_LISTENER_REPLY_TYPES`) are owned by their
 * own window listeners and never pass through here. When one arrives inside a
 * batch it is re-dispatched as a window `MessageEvent` so those listeners
 * still see it.
 */
export interface InboundMessageDispatcher {
  /** The window `message` listener. */
  readonly handleEvent: (event: MessageEvent) => void;
  /**
   * Routes one message now, isolating a failure to that message. Used for the
   * startup buffer drain, which must stay synchronous.
   */
  dispatchIsolated(message: unknown): void;
  /** Routes everything still queued, in order. */
  flush(): void;
  /** Flushes the queue and stops scheduling ticks. */
  dispose(): void;
}

/** Routes one ordinary (non-batch) message to its handler. */
export type InboundMessageRoute = (message: BatchedDashboardMessage) => void;

type ScheduledTask = () => void;

interface TaskScheduler {
  schedule(task: ScheduledTask): void;
  dispose(): void;
}

function messageTypeOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function isWindowListenerReply(message: unknown): boolean {
  const type = messageTypeOf(message);
  return (
    type !== undefined && WINDOW_LISTENER_REPLY_TYPES.has(type as MessageType)
  );
}

function isMessageBatch(message: unknown): message is MessageBatchMessage {
  return (
    messageTypeOf(message) === MESSAGE_TYPES.MESSAGE_BATCH &&
    Array.isArray((message as MessageBatchMessage).messages)
  );
}

/** Macrotask scheduler that keeps running while the webview is hidden. */
function createTaskScheduler(): TaskScheduler {
  if (typeof setImmediate === "function") {
    const handles = new Set<ReturnType<typeof setImmediate>>();
    return {
      schedule(task) {
        const handle = setImmediate(() => {
          handles.delete(handle);
          task();
        });
        handles.add(handle);
      },
      dispose() {
        for (const handle of handles) clearImmediate(handle);
        handles.clear();
      },
    };
  }
  if (typeof MessageChannel === "function") {
    const channel = new MessageChannel();
    const tasks: ScheduledTask[] = [];
    channel.port1.onmessage = () => tasks.shift()?.();
    return {
      schedule(task) {
        tasks.push(task);
        channel.port2.postMessage(null);
      },
      dispose() {
        tasks.length = 0;
        channel.port1.close();
      },
    };
  }
  const timers = new Set<ReturnType<typeof setTimeout>>();
  return {
    schedule(task) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        task();
      }, 0);
      timers.add(timer);
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createInboundMessageDispatcher(
  route: InboundMessageRoute
): InboundMessageDispatcher {
  const scheduler = createTaskScheduler();
  let queue: unknown[] = [];
  let tickScheduled = false;
  let inImmediateTask = false;
  let disposed = false;

  const markCurrentTask = (): void => {
    if (inImmediateTask) return;
    inImmediateTask = true;
    queueMicrotask(() => {
      inImmediateTask = false;
    });
  };

  const routeIsolated = (message: unknown, label: string): void => {
    try {
      deliver(message);
    } catch (error) {
      WebviewLog.error(
        `[MessageHandler] ${label} ${String(messageTypeOf(message))} failed: ${describeError(error)}`
      );
    }
  };

  function deliver(message: unknown): void {
    if (isMessageBatch(message)) {
      for (const member of message.messages) {
        if (isWindowListenerReply(member)) {
          window.dispatchEvent(new MessageEvent("message", { data: member }));
          continue;
        }
        routeIsolated(member, "Batched");
      }
      return;
    }
    route(message as BatchedDashboardMessage);
  }

  const flush = (): void => {
    if (queue.length === 0) return;
    const pending = queue;
    queue = [];
    markCurrentTask();
    for (const message of pending) routeIsolated(message, "Queued");
  };

  const onTick = (): void => {
    tickScheduled = false;
    if (disposed || queue.length === 0) return;
    flush();
    // Keep the window open while the burst lasts.
    scheduleTick();
  };

  function scheduleTick(): void {
    if (tickScheduled || disposed) return;
    tickScheduled = true;
    scheduler.schedule(onTick);
  }

  const handleEvent = (event: MessageEvent): void => {
    const message: unknown = event.data;
    if (isWindowListenerReply(message)) return;
    if (disposed) return;
    if (queue.length === 0 && (!tickScheduled || inImmediateTask)) {
      markCurrentTask();
      scheduleTick();
      deliver(message);
      return;
    }
    queue.push(message);
    scheduleTick();
  };

  return {
    handleEvent,
    dispatchIsolated(message) {
      if (isWindowListenerReply(message)) return;
      markCurrentTask();
      routeIsolated(message, "Buffered");
    },
    flush,
    dispose() {
      flush();
      disposed = true;
      scheduler.dispose();
    },
  };
}
