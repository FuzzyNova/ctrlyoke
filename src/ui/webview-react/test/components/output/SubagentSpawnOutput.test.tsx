import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SubagentSpawnOutput } from "@components/output/SubagentSpawnOutput";
import {
  SUBAGENT_SPAWN_STATES,
  TOOL_CALL_EXPANSION_SECTIONS,
} from "@root/types/DashboardConstants";
import { DEFAULT_TOOL_CALL_EXPANSION_STATE } from "@utils/toolCallLayout";

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
    fireEvent.click(screen.getByRole("button", { name: "Show response" }));
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

  it("collapses the prompt and response by default", () => {
    render(
      <SubagentSpawnOutput
        name="task"
        spawn={{
          prompt: "Find the weather",
          state: SUBAGENT_SPAWN_STATES.COMPLETED,
        }}
        result={{ success: true, output: "It is sunny" }}
      />
    );

    expect(screen.queryByText("Find the weather")).not.toBeInTheDocument();
    expect(screen.queryByText("It is sunny")).not.toBeInTheDocument();

    const promptToggle = screen.getByRole("button", { name: "Show prompt" });
    expect(promptToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(promptToggle);
    expect(screen.getByText("Find the weather")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide prompt" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Show response" }));
    expect(screen.getByText("It is sunny")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide response" }));
    expect(screen.queryByText("It is sunny")).not.toBeInTheDocument();
  });

  it("reports toggles to a controlling row and renders its state", () => {
    const changes: Array<[string, boolean]> = [];
    render(
      <SubagentSpawnOutput
        name="task"
        spawn={{
          prompt: "Find the weather",
          state: SUBAGENT_SPAWN_STATES.FAILED,
        }}
        result={{ success: false, error: "Agent crashed" }}
        expansion={{
          ...DEFAULT_TOOL_CALL_EXPANSION_STATE,
          subagentPromptExpanded: true,
        }}
        onExpansionChange={(section, expanded) =>
          changes.push([section, expanded])
        }
      />
    );

    expect(screen.getByText("Find the weather")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Show error" }));

    expect(changes).toEqual([
      [TOOL_CALL_EXPANSION_SECTIONS.SUBAGENT_PROMPT, false],
      [TOOL_CALL_EXPANSION_SECTIONS.ERROR, true],
    ]);
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
