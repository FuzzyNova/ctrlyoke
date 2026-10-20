import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FooterQuickPicker } from "@components/editor/FooterQuickPicker";
import { useUiStore } from "@store/uiStore";
import { PICKER_SHORTCUT_TARGETS } from "@root/types/DashboardConstants";

describe("FooterQuickPicker", () => {
  it("names the trigger while retaining its title tooltip", () => {
    render(
      <FooterQuickPicker
        isNarrow={true}
        showLabel={false}
        icon={<span>i</span>}
        valueLabel="Value"
        isOverride={false}
        isOpen={false}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        title="Model override"
      >
        <div>Picker content</div>
      </FooterQuickPicker>
    );

    const trigger = screen.getByRole("button", { name: "Model override" });
    expect(trigger).toHaveAttribute("title", "Model override");
  });

  it("renders the popup heading above the inline picker content", async () => {
    render(
      <FooterQuickPicker
        isNarrow={false}
        showLabel={true}
        icon={<span>i</span>}
        valueLabel="Value"
        isOverride={false}
        isOpen={true}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        title="Picker"
        heading="Harness"
      >
        <div>Picker content</div>
      </FooterQuickPicker>
    );

    expect(screen.getByText("Harness")).toBeInTheDocument();
    expect(screen.getByText("Picker content")).toBeInTheDocument();
  });
});

describe("FooterQuickPicker — picker shortcut", () => {
  beforeEach(() => {
    useUiStore.setState({ pickerShortcutRequest: null });
  });

  function renderPicker(props: { isOpen: boolean; disabled?: boolean }) {
    const onToggle = vi.fn();
    render(
      <FooterQuickPicker
        isNarrow={false}
        showLabel={true}
        icon={<span>i</span>}
        valueLabel="Value"
        isOverride={false}
        onToggle={onToggle}
        onClose={vi.fn()}
        title="Model override"
        shortcutTarget={PICKER_SHORTCUT_TARGETS.STEP_MODEL}
        {...props}
      >
        <div>Picker content</div>
      </FooterQuickPicker>
    );
    return onToggle;
  }

  function press() {
    act(() => {
      useUiStore
        .getState()
        .requestPickerShortcut(PICKER_SHORTCUT_TARGETS.STEP_MODEL, {
          mobile: false,
        });
    });
  }

  it("opens on its shortcut and leaves the request for the list inside", () => {
    const onToggle = renderPicker({ isOpen: false });

    press();

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().pickerShortcutRequest).not.toBeNull();
  });

  it("does not toggle an already-open popup closed", () => {
    const onToggle = renderPicker({ isOpen: true });

    press();

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("swallows the request while disabled", () => {
    const onToggle = renderPicker({ isOpen: false, disabled: true });

    press();

    expect(onToggle).not.toHaveBeenCalled();
    expect(useUiStore.getState().pickerShortcutRequest).toBeNull();
  });

  it("names the shortcut in the trigger tooltip", () => {
    renderPicker({ isOpen: false });

    expect(
      screen.getByRole("button", { name: "Model override" })
    ).toHaveAttribute("title", "Model override\n\nShortcut: Alt+Shift+M");
  });
});
