import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorFooter } from "@components/editor/EditorFooter";
import { useEditorStore } from "@store/editorStore";
import { STEP_TYPES } from "@root/types/DashboardConstants";

const layout = vi.hoisted(() => ({ medium: false, small: false }));

vi.mock("../../../hooks/useElementNarrow", () => ({
  useElementNarrow: (threshold: number) => [
    vi.fn(),
    threshold === 768 ? layout.medium : layout.small,
  ],
}));

vi.mock("@components/editor/HarnessQuickPicker", () => ({
  HarnessQuickPicker: () => null,
}));
vi.mock("@components/editor/ModelQuickPicker", () => ({
  ModelQuickPicker: () => null,
}));
vi.mock("@components/editor/AgentQuickPicker", () => ({
  AgentQuickPicker: () => null,
}));
vi.mock("@components/editor/SkillsQuickPicker", () => ({
  SkillsQuickPicker: () => null,
}));
vi.mock("@components/editor/PermissionsQuickPicker", () => ({
  PermissionsQuickPicker: () => null,
}));
vi.mock("@components/editor/ContextQuickPicker", () => ({
  ContextQuickPicker: () => null,
}));
vi.mock("@components/shared/DrawerTabBar", () => ({
  DrawerTabBar: () => null,
}));

const defaultProps: React.ComponentProps<typeof EditorFooter> = {
  isEditMode: false,
  isPromptCompleted: false,
  isPromptBeingSent: false,
  isPromptActivelyRunning: false,
  hasContent: true,
  hasPendingPrompts: false,
  runButtonText: "Run",
  runButtonTooltip: "Run this prompt",
  queueButtonTooltip: "Queue this prompt",
  onRun: vi.fn(),
  onRunInNewWorkflow: vi.fn(),
  onQueue: vi.fn(),
  onUpdate: vi.fn(),
  onDelete: vi.fn(),
  onCancel: vi.fn(),
  onToggleProperties: vi.fn(),
  propertiesOpen: false,
  drawerActivePage: "harness",
  onDrawerTabChange: vi.fn(),
  drawerHarnessId: "codex-cli",
};

beforeEach(() => {
  layout.medium = false;
  layout.small = false;
  useEditorStore.setState({ stepType: STEP_TYPES.PROMPT });
  vi.clearAllMocks();
});

function renderFooter(
  props: Partial<React.ComponentProps<typeof EditorFooter>> = {}
) {
  return render(<EditorFooter {...defaultProps} {...props} />);
}

describe("EditorFooter run menu", () => {
  it("keeps the menu items in order and shows disabled reasons", async () => {
    const user = userEvent.setup();
    renderFooter();

    await user.click(screen.getByRole("button", { name: "More options" }));

    expect(
      screen.getAllByRole("option").map((option) => option.textContent)
    ).toEqual(["Send Steer Message", "Run in Parallel", "Run in New Workflow"]);
    expect(
      screen.getByRole("option", { name: "Send Steer Message" })
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Run in Parallel" })
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Send Steer Message" })
    ).toHaveAttribute("title", "No live harness session for this workflow");
    expect(
      screen.getByRole("option", { name: "Run in Parallel" })
    ).toHaveAttribute("title", "No step is running");
    expect(
      screen.getByRole("option", { name: "Run in New Workflow" })
    ).toHaveAttribute(
      "title",
      "Starts a separate workflow with default settings and this prompt"
    );
  });

  it.each([
    ["with content", true, false, true],
    ["without content", false, false, false],
    ["in external mode", true, true, false],
  ])(
    "enables Run in New Workflow %s exactly when Run is enabled",
    async (_label, hasContent, externallyManaged, enabled) => {
      const user = userEvent.setup();
      renderFooter({ hasContent, isExternallyManaged: externallyManaged });
      await user.click(screen.getByRole("button", { name: "More options" }));

      const run = document.querySelector<HTMLButtonElement>(".btn-editor-run");
      const newWorkflow = screen.getByRole("option", {
        name: "Run in New Workflow",
      });
      expect(run).toHaveProperty("disabled", !enabled);
      expect(newWorkflow).toHaveProperty("disabled", !enabled);
    }
  );

  it.each([
    ["wide", false],
    ["medium", true],
  ])(
    "keeps the primary Run action and accessible name at %s width",
    async (_label, medium) => {
      const user = userEvent.setup();
      layout.medium = medium;
      renderFooter();

      const run = screen.getByRole("button", { name: "Run" });
      await user.click(run);

      expect(defaultProps.onRun).toHaveBeenCalledTimes(1);
      expect(run).toHaveClass("btn-editor-run");
    }
  );

  it("renders the run menu as a portaled drop-up", async () => {
    const user = userEvent.setup();
    const { container } = renderFooter();
    await user.click(screen.getByRole("button", { name: "More options" }));

    const menu = await screen.findByRole("listbox");
    expect(container).not.toContainElement(menu);
    expect(menu.style.bottom).not.toBe("");
  });

  it("supports keyboard navigation into the enabled menu action", async () => {
    const user = userEvent.setup();
    renderFooter();

    const trigger = screen.getByRole("button", { name: "More options" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}");

    expect(
      screen.getByRole("option", { name: "Run in New Workflow" })
    ).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(defaultProps.onRunInNewWorkflow).toHaveBeenCalledTimes(1);
  });
});
