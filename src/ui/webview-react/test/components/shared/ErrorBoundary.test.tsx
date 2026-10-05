import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "@components/shared/ErrorBoundary";
import { WebviewLog } from "@utils/logger";

const ThrowingEvent = (): React.ReactNode => {
  throw new Error("malformed persisted event");
};

describe("ErrorBoundary", () => {
  it("contains a bad output row with its compact fallback", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(WebviewLog, "error").mockImplementation(() => {});

    try {
      render(
        <ErrorBoundary fallback={<div>could not render this event</div>}>
          <ThrowingEvent />
        </ErrorBoundary>
      );

      expect(screen.getByText("could not render this event")).toBeTruthy();
      expect(screen.queryByText("ctrlyoke encountered an error.")).toBeNull();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[ErrorBoundary] Caught error: malformed persisted event"
        )
      );
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
