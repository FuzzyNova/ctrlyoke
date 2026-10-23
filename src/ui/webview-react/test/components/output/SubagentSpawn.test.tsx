import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SubagentSpawnOutput } from "@components/output/SubagentSpawn";
import { SUBAGENT_SPAWN_STATES } from "@root/types/DashboardConstants";

describe("SubagentSpawnOutput", () => {
  it("uses child state after the spawn tool result arrives", () => {
    render(
      <SubagentSpawnOutput
        name="task"
        spawn={{
          description: "Inspect the workspace",
          agentType: "Explore",
          prompt: "Find the relevant implementation",
          statusLine: "Reading files",
          state: SUBAGENT_SPAWN_STATES.RUNNING,
        }}
        result={{ success: true, output: "Spawn accepted" }}
      />
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Reading files")).toBeInTheDocument();
    expect(screen.getByText("Spawn accepted")).toBeInTheDocument();
  });

  it("keeps the prompt collapsed until requested", async () => {
    render(
      <SubagentSpawnOutput
        name="task"
        spawn={{
          prompt: "Secret prompt",
          state: SUBAGENT_SPAWN_STATES.COMPLETED,
        }}
      />
    );

    expect(screen.queryByText("Secret prompt")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show prompt" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });
});
