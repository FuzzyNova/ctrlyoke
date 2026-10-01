import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PromptStepDetails } from "@components/prompts/PromptStepDetails";
import { STEP_STATUS } from "@/types/messages";

describe("PromptStepDetails retry label", () => {
  it("shows the unlimited retry denominator as infinity", () => {
    render(
      <PromptStepDetails
        status={STEP_STATUS.RUNNING}
        retryState={{ currentRetry: 1, maxRetries: -1 }}
      />
    );

    expect(screen.getByText("Retry 1 of ∞")).toBeInTheDocument();
  });
});
