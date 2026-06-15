import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NavHistoryControls } from "@components/shared/NavHistoryControls";
import { useNavHistoryStore } from "@/navigation/navHistoryStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type { Route } from "@/navigation/route";

const A: Route = { workflow: "a.yaml" };
const B: Route = { viewer: "explorer", file: "src/a.ts" };

beforeEach(() => {
  useNavHistoryStore.getState().reset();
  useWorkspaceViewerStore.getState().reset();
});

const backButton = () => screen.getByLabelText("Go back");
const forwardButton = () => screen.getByLabelText("Go forward");

describe("NavHistoryControls", () => {
  it("disables both buttons with an empty history", () => {
    render(<NavHistoryControls />);
    expect(backButton()).toBeDisabled();
    expect(forwardButton()).toBeDisabled();
  });

  it("enables back once there is a previous entry", () => {
    useNavHistoryStore.getState().record(A);
    useNavHistoryStore.getState().record(B);
    render(<NavHistoryControls />);
    expect(backButton()).toBeEnabled();
    expect(forwardButton()).toBeDisabled();
  });

  it("walks the stack on back and forward clicks", () => {
    useNavHistoryStore.getState().record(A);
    useNavHistoryStore.getState().record(B);
    render(<NavHistoryControls />);

    fireEvent.click(backButton());
    expect(useNavHistoryStore.getState().current).toEqual(A);
    expect(forwardButton()).toBeEnabled();

    fireEvent.click(forwardButton());
    expect(useNavHistoryStore.getState().current).toEqual(B);
    expect(forwardButton()).toBeDisabled();
  });
});
