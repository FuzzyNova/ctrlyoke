import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BulkSelectionActionsBar,
  type BulkSelectionActionsBarProps,
} from "@components/shared/BulkSelectionActionsBar";
import {
  HARNESS_IDS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "@/types/messages";

function renderBar(overrides: Partial<BulkSelectionActionsBarProps> = {}) {
  const props: BulkSelectionActionsBarProps = {
    totalCount: 3,
    selectedCount: 2,
    selectAllState: "some",
    onToggleSelectAll: vi.fn(),
    availableActions: ["save", "delete", "setDefault"],
    getTargetsForScope: () => [
      HARNESS_IDS.CLAUDE_CLI,
      SPECIAL_TARGET_IDS.FLIGHTPATH,
    ],
    getTargetLabel: (id) =>
      id === SPECIAL_TARGET_IDS.FLIGHTPATH ? "FlightPath" : "Claude Code",
    getTargetDescription: (id, scope) => `${id}:${scope}`,
    defaultTargetId: HARNESS_IDS.CLAUDE_CLI,
    defaultScope: SETTING_SCOPES.WORKSPACE,
    activeScope: SETTING_SCOPES.WORKSPACE,
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onSetDefault: vi.fn(),
    ...overrides,
  };

  render(<BulkSelectionActionsBar {...props} />);
  return props;
}

describe("BulkSelectionActionsBar", () => {
  it("renders an indeterminate select-all checkbox for partial selection", () => {
    renderBar();

    const checkbox = screen.getByRole("checkbox", {
      name: "Select all rows",
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.indeterminate).toBe(true);
    expect(screen.getByText("Select all (2/3)")).toBeInTheDocument();
  });

  it("hides scope and target controls for set-default actions", async () => {
    const user = userEvent.setup();
    const props = renderBar();

    await user.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await user.click(screen.getByRole("button", { name: "Set Default" }));

    expect(screen.queryByText("to:")).toBeNull();
    expect(screen.getByText("defaults (Workspace)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set as Default" }));
    expect(props.onSetDefault).toHaveBeenCalledTimes(1);
  });
});
