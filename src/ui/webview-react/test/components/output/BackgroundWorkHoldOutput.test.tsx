import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BackgroundWorkHoldOutput } from "@components/output/BackgroundWorkHoldOutput";
import type { BackgroundWorkHoldData } from "@/types/cliEvents";

describe("BackgroundWorkHoldOutput", () => {
  it("explains the absorbed Stop and names each pending background task", () => {
    const data: BackgroundWorkHoldData = {
      heldAt: Date.UTC(2026, 8, 24, 4, 20, 27),
      awaitingResumedTurn: false,
      pendingTasks: [
        {
          toolName: "Bash",
          description: "Run full real-harness test suite",
          command: "npm run test:harness",
          taskId: "b2gz1o2ty",
        },
        { toolName: "PowerShell", command: "npm test", taskId: "beul1f741" },
      ],
    };

    render(<BackgroundWorkHoldOutput data={data} />);

    expect(
      screen.getByText(
        /Stop hook received — step kept running until 2 background tasks finish/
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText("Run full real-harness test suite")
    ).toBeInTheDocument();
    expect(screen.getByText("Bash · b2gz1o2ty")).toBeInTheDocument();
    expect(screen.getByText("$ npm run test:harness")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("PowerShell · beul1f741")).toBeInTheDocument();
    expect(screen.queryByText("$ npm test")).not.toBeInTheDocument();
  });

  it("explains a hold on a resumed turn when every task has reported", () => {
    render(
      <BackgroundWorkHoldOutput
        data={{ heldAt: 0, awaitingResumedTurn: true, pendingTasks: [] }}
      />
    );

    expect(
      screen.getByText(
        "Stop hook received — step kept running until the harness finishes the turn its background task resumed"
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
