import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BackgroundWorkAbandonedOutput } from "@components/output/BackgroundWorkAbandonedOutput";

describe("BackgroundWorkAbandonedOutput", () => {
  it("renders a warning row for stopped background tasks", () => {
    render(
      <BackgroundWorkAbandonedOutput
        data={{ pendingTasks: [{ taskId: "one" }, { taskId: "two" }] }}
      />
    );

    expect(screen.getByTestId("background-work-abandoned")).toHaveTextContent(
      "The step ended with 2 background tasks still running; they were stopped when the headless session ended."
    );
  });

  it("uses a generic background-work label when task details are unavailable", () => {
    render(<BackgroundWorkAbandonedOutput data={{ pendingTasks: [] }} />);

    expect(screen.getByTestId("background-work-abandoned")).toHaveTextContent(
      "The step ended with background work still running; it was stopped when the headless session ended."
    );
  });
});
