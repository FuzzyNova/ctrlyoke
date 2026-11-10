import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NavHistoryControls } from "@components/shared/NavHistoryControls";
import { useRouteHistoryStore } from "@/navigation/routeHistoryStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import type { Route } from "@/navigation/route";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "@root/types/DashboardConstants";

const A: Route = {
  workflow: {
    workflowKey: "a" as never,
    kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
  },
};
const B: Route = { viewer: "explorer", file: "src/a.ts" };

beforeEach(() => {
  useRouteHistoryStore.getState().reset();
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
    useRouteHistoryStore.getState().record(A);
    useRouteHistoryStore.getState().record(B);
    render(<NavHistoryControls />);
    expect(backButton()).toBeEnabled();
    expect(forwardButton()).toBeDisabled();
  });

  it("walks the stack on back and forward clicks", () => {
    useRouteHistoryStore.getState().record(A);
    useRouteHistoryStore.getState().record(B);
    render(<NavHistoryControls />);

    fireEvent.click(backButton());
    expect(useRouteHistoryStore.getState().current).toEqual(A);
    expect(forwardButton()).toBeEnabled();

    fireEvent.click(forwardButton());
    expect(useRouteHistoryStore.getState().current).toEqual(B);
    expect(forwardButton()).toBeDisabled();
  });
});
