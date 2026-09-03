import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EXTERNAL_FILE_TRUST_SCOPES,
  MESSAGE_TYPES,
} from "@root/types/DashboardConstants";
import { useChoiceStore } from "@store/choiceStore";
import { ChoiceModal } from "@components/shared/ChoiceModal";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage }));

beforeEach(() => {
  sendMessage.mockClear();
  useChoiceStore.setState({ pendingRequest: null });
});

describe("ChoiceModal", () => {
  it("renders the supplied options and returns the selected value", async () => {
    const user = userEvent.setup();
    useChoiceStore.getState().setPendingRequest({
      id: "choice-1",
      title: "Trust Parent Folder",
      detail: "Choose a scope",
      choices: [
        {
          value: EXTERNAL_FILE_TRUST_SCOPES.USER,
          label: "Trust for me (all workspaces)",
        },
        {
          value: EXTERNAL_FILE_TRUST_SCOPES.WORKSPACE,
          label: "Trust for this workspace",
        },
        {
          value: EXTERNAL_FILE_TRUST_SCOPES.WORKFLOW,
          label: "Trust for this workflow",
        },
      ],
    });

    render(<ChoiceModal />);
    await user.click(
      screen.getByRole("radio", { name: "Trust for this workflow" })
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(sendMessage).toHaveBeenCalledWith(MESSAGE_TYPES.CHOICE_RESPONSE, {
      id: "choice-1",
      value: EXTERNAL_FILE_TRUST_SCOPES.WORKFLOW,
    });
    expect(useChoiceStore.getState().pendingRequest).toBeNull();
  });

  it("dismisses without selecting a scope", async () => {
    const user = userEvent.setup();
    useChoiceStore.getState().setPendingRequest({
      id: "choice-2",
      title: "Trust Parent Folder",
      detail: "Choose a scope",
      choices: [
        {
          value: EXTERNAL_FILE_TRUST_SCOPES.USER,
          label: "Trust for me (all workspaces)",
        },
      ],
    });

    render(<ChoiceModal />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(sendMessage).toHaveBeenCalledWith(MESSAGE_TYPES.CHOICE_RESPONSE, {
      id: "choice-2",
      value: null,
    });
  });
});
