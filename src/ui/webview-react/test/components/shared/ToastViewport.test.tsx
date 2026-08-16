import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@components/shared/ToastViewport";
import { useUiStore } from "@store/uiStore";
import {
  TOAST_INFO_SUCCESS_TIMEOUT_MS,
  TOAST_WARNING_ERROR_TIMEOUT_MS,
} from "@/constants";
import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";

beforeEach(() => {
  useUiStore.getState().resetUi();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastViewport", () => {
  it("renders severity-specific live-region roles and accessible content", () => {
    useUiStore.getState().showToast("Saved", USER_FEEDBACK_SEVERITY.SUCCESS, {
      detail: "Saved to workspace/template.yaml",
    });
    useUiStore
      .getState()
      .showToast("Could not save", USER_FEEDBACK_SEVERITY.ERROR);

    render(<ToastViewport />);

    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
    expect(
      screen.getAllByRole("button", { name: "Dismiss notification" })
    ).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("Saved to workspace/template.yaml")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Hide details" })
    ).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(
      screen.getAllByRole("button", { name: "Dismiss notification" })[0]
    );
    expect(screen.getByText("Could not save")).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("uses the safe-area offset and shared elevated layer", () => {
    useUiStore.getState().showToast("Hello");

    render(<ToastViewport />);

    const viewport = screen.getByLabelText("Notifications");
    expect(viewport).toHaveClass("z-popover");
    expect(viewport).toHaveClass("left-2", "right-2");
    expect(viewport).toHaveStyle({
      bottom: "calc(var(--safe-area-bottom) + 3rem)",
    });
  });

  it("renders and dismisses an optional action", () => {
    const onClick = vi.fn();
    useUiStore.getState().showToast("Created", USER_FEEDBACK_SEVERITY.SUCCESS, {
      action: { label: "Open in New Tab", onClick },
    });

    render(<ToastViewport />);

    fireEvent.click(screen.getByRole("button", { name: "Open in New Tab" }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByText("Created")).not.toBeInTheDocument();
  });

  it("pauses timeout while hovered or focused", () => {
    useUiStore.getState().showToast("Transient");
    render(<ToastViewport />);
    const toast = screen.getByRole("status");

    act(() => {
      vi.advanceTimersByTime(TOAST_INFO_SUCCESS_TIMEOUT_MS - 1);
    });
    expect(screen.getByText("Transient")).toBeInTheDocument();

    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(TOAST_INFO_SUCCESS_TIMEOUT_MS);
    });
    expect(screen.getByText("Transient")).toBeInTheDocument();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Transient")).not.toBeInTheDocument();
  });

  it("gives warning and error toasts the longer timeout", () => {
    useUiStore.getState().showToast("Warning", USER_FEEDBACK_SEVERITY.WARNING);
    render(<ToastViewport />);

    act(() => {
      vi.advanceTimersByTime(TOAST_INFO_SUCCESS_TIMEOUT_MS);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(
        TOAST_WARNING_ERROR_TIMEOUT_MS - TOAST_INFO_SUCCESS_TIMEOUT_MS
      );
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
