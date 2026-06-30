import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowFilePickerModal } from "@components/workflow/WorkflowFilePickerModal";
import { hostedFetch } from "@utils/hostedApi";

vi.mock("@utils/hostedApi", () => ({
  hostedFetch: vi.fn(),
}));

const hostedFetchMock = vi.mocked(hostedFetch);

describe("WorkflowFilePickerModal", () => {
  beforeEach(() => {
    hostedFetchMock.mockReset();
  });

  it("loads workflow files through the hosted API and displays portable paths", async () => {
    hostedFetchMock.mockResolvedValueOnce({
      files: [
        {
          path: "C:\\dev\\ctrlyoke\\flows\\example.flightpath.yaml",
          relativePath: "flows\\example.flightpath.yaml",
        },
      ],
    });

    render(
      <WorkflowFilePickerModal
        isOpen
        title="Load Workflow File"
        actionLabel="Load File"
        onClose={() => {}}
        onSelect={() => {}}
      />
    );

    await waitFor(() =>
      expect(hostedFetchMock).toHaveBeenCalledWith("/api/workflow-files")
    );
    expect(
      await screen.findByText("flows/example.flightpath.yaml")
    ).toBeInTheDocument();
  });

  it("normalizes manual paths to forward slashes before submitting", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    hostedFetchMock.mockResolvedValueOnce({ files: [] });

    render(
      <WorkflowFilePickerModal
        isOpen
        title="Load Workflow File"
        actionLabel="Load File"
        onClose={() => {}}
        onSelect={onSelect}
      />
    );

    const pathInput = screen.getByPlaceholderText(
      "path/to/workflow.flightpath.yaml"
    );
    await user.type(pathInput, "flows\\nested\\example.flightpath.yaml");
    await user.click(screen.getByRole("button", { name: "Load File" }));

    expect(onSelect).toHaveBeenCalledWith(
      "flows/nested/example.flightpath.yaml"
    );
  });
});
