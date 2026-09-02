import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { useBatchApprovalStore } from "@store/batchApprovalStore";
import { BatchApprovalModal } from "@components/shared/BatchApprovalModal";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage }));

beforeEach(() => {
  sendMessage.mockClear();
  useBatchApprovalStore.setState({ pendingRequest: null });
});

function setRequest() {
  useBatchApprovalStore.getState().setPendingRequest({
    id: "req-1",
    title: "This workflow requests 2 secret grant(s)",
    description: "Uncheck a grant to keep it blocked.",
    items: [
      { value: "FIRST_TOKEN", label: "FIRST_TOKEN", checked: true },
      { value: "SECOND_TOKEN", label: "SECOND_TOKEN", checked: true },
    ],
  });
}

describe("BatchApprovalModal", () => {
  it("renders nothing when there is no pending request", () => {
    render(<BatchApprovalModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows every item checked by default and confirms with the full approve list", async () => {
    const user = userEvent.setup();
    setRequest();
    render(<BatchApprovalModal />);

    expect(screen.getByRole("checkbox", { name: /FIRST_TOKEN/ })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /SECOND_TOKEN/ })
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(sendMessage).toHaveBeenCalledWith(
      MESSAGE_TYPES.BATCH_APPROVAL_RESPONSE,
      {
        id: "req-1",
        result: {
          approvedValues: ["FIRST_TOKEN", "SECOND_TOKEN"],
          deniedValues: [],
        },
      }
    );
    expect(useBatchApprovalStore.getState().pendingRequest).toBeNull();
  });

  it("moves an unchecked item to deniedValues on confirm", async () => {
    const user = userEvent.setup();
    setRequest();
    render(<BatchApprovalModal />);

    await user.click(screen.getByRole("checkbox", { name: /SECOND_TOKEN/ }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(sendMessage).toHaveBeenCalledWith(
      MESSAGE_TYPES.BATCH_APPROVAL_RESPONSE,
      {
        id: "req-1",
        result: {
          approvedValues: ["FIRST_TOKEN"],
          deniedValues: ["SECOND_TOKEN"],
        },
      }
    );
  });

  it("sends a null result and clears the request when dismissed", async () => {
    const user = userEvent.setup();
    setRequest();
    render(<BatchApprovalModal />);

    await user.click(screen.getByRole("button", { name: "Ask me later" }));

    expect(sendMessage).toHaveBeenCalledWith(
      MESSAGE_TYPES.BATCH_APPROVAL_RESPONSE,
      { id: "req-1", result: null }
    );
    expect(useBatchApprovalStore.getState().pendingRequest).toBeNull();
  });
});
