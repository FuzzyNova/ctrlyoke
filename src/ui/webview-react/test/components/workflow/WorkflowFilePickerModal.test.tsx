import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowFilePickerModal } from "@components/workflow/WorkflowFilePickerModal";
import { hostedFetch } from "@utils/hostedApi";
import { useSettingsStore } from "@store/settingsStore";

vi.mock("@utils/hostedApi", () => ({
  hostedFetch: vi.fn(),
}));

const hostedFetchMock = vi.mocked(hostedFetch);
let originalHideGitIgnoredFiles = false;

describe("WorkflowFilePickerModal", () => {
  beforeEach(() => {
    hostedFetchMock.mockReset();
    originalHideGitIgnoredFiles =
      useSettingsStore.getState().globalSettings.hideGitIgnoredFiles;
  });

  afterEach(() => {
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        hideGitIgnoredFiles: originalHideGitIgnoredFiles,
      },
    }));
  });

  it("loads workflow files through the hosted API and displays portable paths", async () => {
    hostedFetchMock.mockResolvedValueOnce({
      files: [
        {
          path: "C:\\dev\\ctrlyoke\\flows\\example.ctrlyoke.yaml",
          relativePath: "flows\\example.ctrlyoke.yaml",
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
      await screen.findByText("flows/example.ctrlyoke.yaml")
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
      "path/to/workflow.ctrlyoke.yaml"
    );
    await user.type(pathInput, "flows\\nested\\example.ctrlyoke.yaml");
    await user.click(screen.getByRole("button", { name: "Load File" }));

    expect(onSelect).toHaveBeenCalledWith("flows/nested/example.ctrlyoke.yaml");
  });

  it("submits the first visible file when the first file is git-ignored", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    useSettingsStore.setState((state) => ({
      globalSettings: { ...state.globalSettings, hideGitIgnoredFiles: true },
    }));
    hostedFetchMock.mockResolvedValueOnce({
      files: [
        {
          path: ".scratch/a.ctrlyoke.yaml",
          relativePath: ".scratch/a.ctrlyoke.yaml",
          gitIgnored: true,
        },
        {
          path: "workflows/b.ctrlyoke.yaml",
          relativePath: "workflows/b.ctrlyoke.yaml",
          gitIgnored: false,
        },
      ],
      isGitRepo: true,
    });

    render(
      <WorkflowFilePickerModal
        isOpen
        title="Load Workflow File"
        actionLabel="Load File"
        onClose={() => {}}
        onSelect={onSelect}
      />
    );

    expect(await screen.findByText("workflows/b.ctrlyoke.yaml")).toBeVisible();
    expect(
      screen.queryByText(".scratch/a.ctrlyoke.yaml")
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load File" }));

    expect(onSelect).toHaveBeenCalledWith("workflows/b.ctrlyoke.yaml");
  });

  it("submits the first file matching the search query", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    hostedFetchMock.mockResolvedValueOnce({
      files: [
        {
          path: "alpha.ctrlyoke.yaml",
          relativePath: "alpha.ctrlyoke.yaml",
        },
        {
          path: "workflows/beta.ctrlyoke.yaml",
          relativePath: "workflows/beta.ctrlyoke.yaml",
        },
      ],
    });

    render(
      <WorkflowFilePickerModal
        isOpen
        title="Load Workflow File"
        actionLabel="Load File"
        onClose={() => {}}
        onSelect={onSelect}
      />
    );

    await screen.findByText("alpha.ctrlyoke.yaml");
    await user.type(screen.getByLabelText("Search workspace files"), "beta");
    expect(screen.getByText("workflows/beta.ctrlyoke.yaml")).toBeVisible();
    expect(screen.queryByText("alpha.ctrlyoke.yaml")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load File" }));

    expect(onSelect).toHaveBeenCalledWith("workflows/beta.ctrlyoke.yaml");
  });
});
