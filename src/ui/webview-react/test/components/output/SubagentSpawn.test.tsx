import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("labels the card as a subagent", () => {
    render(
      <SubagentSpawnOutput
        name="Agent"
        spawn={{
          description: "Weather for 64113",
          state: SUBAGENT_SPAWN_STATES.RUNNING,
        }}
      />
    );

    expect(screen.getByText("Subagent: Weather for 64113")).toBeInTheDocument();
  });

  it("shows the prompt until it is hidden", () => {
    render(
      <SubagentSpawnOutput
        name="task"
        spawn={{
          prompt: "Find the weather",
          state: SUBAGENT_SPAWN_STATES.COMPLETED,
        }}
      />
    );

    expect(screen.getByText("Find the weather")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Hide prompt" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);

    expect(screen.queryByText("Find the weather")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show prompt" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("does not present a background launch acknowledgement as the result", () => {
    render(
      <SubagentSpawnOutput
        name="Agent"
        spawn={{ background: true, state: SUBAGENT_SPAWN_STATES.COMPLETED }}
        result={{ success: true, output: "Async agent launched successfully." }}
      />
    );

    expect(
      screen.queryByText("Async agent launched successfully.")
    ).not.toBeInTheDocument();
  });
});
