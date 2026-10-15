import { afterEach, describe, expect, it, vi } from "vitest";
import { WebviewLog } from "@utils/logger";
import { LOG_LEVELS, MESSAGE_TYPES } from "@/types/messages";

describe("WebviewLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("includes Error details in the forwarded log message", () => {
    const postMessage = vi.fn();
    const api = window.vscodeApi as unknown as {
      postMessage: (message: unknown) => void;
    };
    vi.spyOn(api, "postMessage").mockImplementation(postMessage);

    WebviewLog.error("Request failed:", new Error("connection refused"));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MESSAGE_TYPES.LOG_MESSAGE,
        level: LOG_LEVELS.ERROR,
        message: expect.stringContaining("connection refused"),
      })
    );
  });

  it.each([
    [
      "circular",
      () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
    ],
    ["BigInt", () => 42n],
  ])("does not throw for %s arguments", (_label, makeArgument) => {
    const postMessage = vi.fn();
    const api = window.vscodeApi as unknown as {
      postMessage: (message: unknown) => void;
    };
    vi.spyOn(api, "postMessage").mockImplementation(postMessage);

    expect(() => WebviewLog.info("Value:", makeArgument())).not.toThrow();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.LOG_MESSAGE })
    );
  });
});
