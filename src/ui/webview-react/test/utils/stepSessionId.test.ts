import { describe, expect, it } from "vitest";
import type { CliOutput } from "@store/workflowStore";
import type { WorkflowStep } from "@store/workflowStore";
import type { HarnessId } from "@root/types/DashboardConstants";
import {
  getStepSessionDetails,
  getStepSessionId,
} from "@utils/stepMetadataClipboard";

const step = (sessionId?: string): WorkflowStep =>
  ({ prompt: "Question", _runtime: { sessionId } }) as WorkflowStep;

const output = (sessionId?: string): CliOutput => ({
  elapsed: 1,
  isStreaming: false,
  structured: {
    events: [],
    metadata: { sessionId },
  },
});

const outputWithHarness = (
  sessionId: string,
  harness: HarnessId
): CliOutput => ({
  ...output(sessionId),
  structured: {
    events: [],
    metadata: { sessionId, harness },
  },
});

describe("getStepSessionId", () => {
  it("prefers the latest output session ID", () => {
    expect(
      getStepSessionId(step("step-session"), output("output-session"), {
        sessionId: "runtime-session",
      })
    ).toBe("output-session");
  });

  it("keeps the harness paired with the output session ID", () => {
    expect(
      getStepSessionDetails(
        {
          prompt: "Question",
          _runtime: { sessionId: "old", harness: "copilot-cli" },
        },
        outputWithHarness("latest", "claude-cli"),
        { sessionId: "runtime", harness: "qwen-cli" }
      )
    ).toEqual({ sessionId: "latest", harness: "claude-cli" });
  });

  it("falls back to runtime metadata and then the step runtime", () => {
    expect(
      getStepSessionId(step("step-session"), undefined, {
        sessionId: "runtime-session",
      })
    ).toBe("runtime-session");
    expect(getStepSessionId(step("step-session"), null, undefined)).toBe(
      "step-session"
    );
  });

  it("skips empty IDs and returns undefined when none are available", () => {
    expect(
      getStepSessionId(step("step-session"), output(""), {
        sessionId: "",
      })
    ).toBe("step-session");
    expect(getStepSessionId(step(""), output(""), { sessionId: "" })).toBe(
      undefined
    );
  });
});
