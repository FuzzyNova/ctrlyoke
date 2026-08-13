import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AskUserQuestionOutput } from "@components/output/AskUserQuestionOutput";
import { OPERATION_STATUS } from "@/types/cliEvents";
import type { AskUserQuestionData } from "@/types/cliEvents";

describe("AskUserQuestionOutput", () => {
  it("renders a pending question with its options and no selection", () => {
    const data: AskUserQuestionData = {
      toolCallId: "ask-1",
      status: OPERATION_STATUS.INITIATED,
      questions: [
        {
          question: "Favorite animal?",
          options: [
            { label: "Cat", description: "Independent feline" },
            { label: "Dog", description: "Loyal companion" },
          ],
        },
      ],
    };

    render(<AskUserQuestionOutput data={data} />);

    expect(screen.getByText("Asked 1 question")).toBeInTheDocument();
    expect(screen.getByText("Favorite animal?")).toBeInTheDocument();
    expect(screen.getByText("Cat")).toBeInTheDocument();
    expect(screen.getByText("Dog")).toBeInTheDocument();
    expect(screen.queryByText("✓")).not.toBeInTheDocument();
  });

  it("highlights the selected option and its preview art once answered", () => {
    const data: AskUserQuestionData = {
      toolCallId: "ask-2",
      status: OPERATION_STATUS.COMPLETED,
      questions: [
        {
          question: "Favorite animal?",
          options: [
            { label: "Cat", description: "Independent feline", preview: "/\\_/\\" },
            { label: "Dog", description: "Loyal companion" },
          ],
          answer: "Cat",
        },
      ],
    };

    render(<AskUserQuestionOutput data={data} />);

    expect(screen.getByText("Answered 1 question")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("/\\_/\\")).toBeInTheDocument();
  });

  it("renders a freeform typed reply that doesn't match any option", () => {
    const data: AskUserQuestionData = {
      toolCallId: "ask-3",
      status: OPERATION_STATUS.COMPLETED,
      questions: [
        {
          question: "Ship it?",
          options: [{ label: "Yes" }, { label: "No" }],
          answer: "Not yet, let's wait for QA",
        },
      ],
    };

    render(<AskUserQuestionOutput data={data} />);

    expect(
      screen.getByText(/Not yet, let's wait for QA/)
    ).toBeInTheDocument();
  });

  it("renders a decline with the clarify feedback text", () => {
    const data: AskUserQuestionData = {
      toolCallId: "ask-4",
      status: OPERATION_STATUS.FAILED,
      questions: [
        { question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] },
      ],
      declined: {
        reason: "clarify",
        feedback: "hold on, what about a third option?",
      },
    };

    render(<AskUserQuestionOutput data={data} />);

    expect(screen.getByText("Asked to clarify")).toBeInTheDocument();
    expect(
      screen.getByText(/hold on, what about a third option\?/)
    ).toBeInTheDocument();
    // The original question set survives the decline so the user can see
    // what was actually asked.
    expect(screen.getByText("Pick a color")).toBeInTheDocument();
  });
});
