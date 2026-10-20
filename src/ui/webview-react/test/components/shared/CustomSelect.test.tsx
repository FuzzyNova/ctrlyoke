import type React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CustomSelect,
  type SelectOption,
} from "@components/shared/CustomSelect";
import { useUiStore } from "@store/uiStore";
import {
  PICKER_SHORTCUT_REQUEST_TTL_MS,
  PICKER_SHORTCUT_TARGETS,
  type PickerShortcutTarget,
} from "@root/types/DashboardConstants";

const OPTIONS: SelectOption[] = [
  { value: "a", label: "Option A" },
  { value: "b", label: "Option B" },
  { value: "c", label: "Option C" },
];

/**
 * The CustomSelect trigger is always the first button rendered.
 * Option buttons live inside the dropdown (always in DOM but CSS-hidden when
 * closed, though jsdom doesn't compute class-based CSS).
 * Using getAllByRole("button")[0] reliably targets the trigger.
 */
function getTrigger() {
  return screen.getAllByRole("button")[0];
}

describe("CustomSelect — basic behavior", () => {
  it("exposes a named listbox trigger and its controlled listbox", async () => {
    const user = userEvent.setup();
    render(
      <CustomSelect
        id="model"
        triggerAriaLabel="Model"
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
      />
    );

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", "model-listbox");

    await user.click(trigger);

    expect(screen.getByRole("listbox")).toHaveAttribute("id", "model-listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("shows selected option label on trigger button", () => {
    render(<CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} />);
    expect(getTrigger().textContent).toContain("Option A");
  });

  it("opens dropdown on click — option buttons become discoverable", async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} />);
    await user.click(getTrigger());
    // After open, option buttons are visible/interactive
    // Option B and C should be findable by their text
    const btns = screen.getAllByRole("button");
    const labels = btns.map((b) => b.textContent ?? "");
    expect(labels).toEqual(expect.arrayContaining(["Option B", "Option C"]));
  });

  it("calls onChange with selected value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CustomSelect value="a" onChange={onChange} options={OPTIONS} />);
    await user.click(getTrigger());
    // Option B button — last matching text "Option B" is inside the option div
    const optionBBtn = screen.getByRole("button", { name: "Option B" });
    await user.click(optionBBtn);
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("renders a muted, length-truncated option description", async () => {
    const user = userEvent.setup();
    const description = "A".repeat(130);
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={[
          ...OPTIONS,
          { value: "described", label: "Described", description },
        ]}
      />
    );

    await user.click(getTrigger());

    expect(screen.getByText(`${"A".repeat(117)}...`)).toHaveClass(
      "text-description-fg"
    );
    expect(screen.getByRole("button", { name: /^Described/ })).toHaveAttribute(
      "title",
      `Described\n\n${description}`
    );
  });

  it("provides each option's full label as the row's hover text", async () => {
    const user = userEvent.setup();
    const longLabel = "opencode/very-long-model-name-that-overflows-the-menu";
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={[...OPTIONS, { value: "long", label: longLabel }]}
      />
    );

    await user.click(getTrigger());

    expect(screen.getByTitle(longLabel)).toHaveAttribute("type", "button");
  });

  it("adds schema property names to trigger and option tooltip and accessible names", async () => {
    const user = userEvent.setup();
    render(
      <CustomSelect
        triggerAriaLabel="Tool Permission Mode"
        schemaPath="toolPermissions.mode"
        value="none"
        onChange={vi.fn()}
        options={[
          { value: "none", label: "None" },
          {
            value: "inherit",
            label: "Inherit (Allow All)",
            pseudo: { writes: "omit toolPermissions" },
          },
        ]}
      />
    );

    const trigger = screen.getByRole("button", {
      name: "Tool Permission Mode, property toolPermissions.mode",
    });
    expect(trigger).toHaveAttribute(
      "title",
      expect.stringContaining("property: toolPermissions.mode")
    );

    await user.click(trigger);

    const noneOption = screen.getByRole("button", {
      name: "None, toolPermissions.mode: none",
    });
    expect(noneOption).toHaveAttribute(
      "title",
      "None\n\nproperty: toolPermissions.mode = none"
    );

    const inheritOption = screen.getByRole("button", {
      name: "Inherit (Allow All), omit toolPermissions",
    });
    expect(inheritOption).toBeInTheDocument();
    expect(inheritOption).toHaveAttribute(
      "title",
      "Inherit (Allow All)\n\nomit toolPermissions\n\nproperty: toolPermissions.mode"
    );
  });

  it("describes pseudo-option writes and omission in the schema path", async () => {
    const user = userEvent.setup();
    render(
      <CustomSelect
        schemaPath="agent"
        value="none"
        onChange={vi.fn()}
        options={[
          {
            value: "none",
            label: "None",
            pseudo: { writes: 'agent: ""' },
          },
          {
            value: "default",
            label: "Inherit (None)",
            pseudo: { omit: true },
          },
        ]}
      />
    );

    await user.click(getTrigger());

    expect(
      screen.getByRole("button", { name: 'None, agent: ""' })
    ).toHaveAttribute("title", 'None\n\nagent: ""\n\nproperty: agent');
    expect(
      screen.getByRole("button", { name: "Inherit (None), omit agent" })
    ).toHaveAttribute("title", "Inherit (None)\n\nomit agent");
  });

  it("dropdown options are not rendered when closed", () => {
    render(<CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} />);
    // The dropdown is portal-based and not in the DOM when closed
    expect(screen.queryByText("Option B")).toBeNull();
    expect(screen.queryByText("Option C")).toBeNull();
  });

  it("dropdown removes invisible class when opened", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} />
    );
    await user.click(getTrigger());
    // After opening, the invisible class should be gone from dropdown
    const invisibles = container.querySelectorAll(".invisible");
    // The main dropdown panel should not be invisible
    expect(invisibles.length).toBe(0);
  });

  it("trigger button is disabled when disabled prop passed", () => {
    render(
      <CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} disabled />
    );
    expect(getTrigger()).toBeDisabled();
  });

  it("does not call onChange for disabled options", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const opts: SelectOption[] = [
      { value: "a", label: "A" },
      { value: "b", label: "B (disabled)", disabled: true },
    ];
    render(<CustomSelect value="a" onChange={onChange} options={opts} />);
    await user.click(getTrigger());
    const disabledBtn = screen.getByRole("button", { name: "B (disabled)" });
    await user.click(disabledBtn);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes dropdown when clicking outside", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} />
        <div data-testid="outside">outside</div>
      </div>
    );
    await user.click(getTrigger());
    // Verify it opened — Option B should be discoverable via portal
    expect(screen.queryByText("Option B")).not.toBeNull();
    await user.click(screen.getByTestId("outside"));
    // Should close again — portal unmounted, options gone from DOM
    expect(screen.queryByText("Option B")).toBeNull();
  });

  it("applies custom className to container", () => {
    const { container } = render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        className="my-custom"
      />
    );
    expect(container.firstChild).toHaveClass("my-custom");
  });

  it("renders a warning below the trigger and applies the warning border", () => {
    render(
      <CustomSelect
        value="missing"
        onChange={vi.fn()}
        options={OPTIONS}
        warning={'Agent "missing" is not available in this workspace.'}
      />
    );

    expect(getTrigger()).toHaveClass("border-warning-fg");
    expect(
      screen.getByText('Agent "missing" is not available in this workspace.')
    ).toHaveClass("text-warning-fg");
  });
});

describe("CustomSelect — hide/unhide feature", () => {
  const HIDDEN = ["b"];

  it("shows 'Show hidden' footer when namespace is provided", async () => {
    const user = userEvent.setup();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        namespace="models"
        hiddenValues={HIDDEN}
      />
    );
    await user.click(getTrigger());
    expect(screen.getByText(/Show hidden/i)).toBeInTheDocument();
  });

  it("hidden option not in visible option buttons before Show hidden", async () => {
    const user = userEvent.setup();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        namespace="models"
        hiddenValues={HIDDEN}
      />
    );
    await user.click(getTrigger());
    // Option B is hidden — should not appear in visible option buttons
    // (the trigger may show "Option A" but Option B should not be in visible list)
    const allBtns = screen.getAllByRole("button");
    const visibleOptionBtns = allBtns.filter(
      (b) => b.textContent === "Option B"
    );
    expect(visibleOptionBtns.length).toBe(0);
  });

  it("calls onHideOption when eye-closed button clicked", async () => {
    const user = userEvent.setup();
    const onHideOption = vi.fn();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        namespace="models"
        hiddenValues={[]}
        onHideOption={onHideOption}
      />
    );
    await user.click(getTrigger());
    const hideButtons = screen.getAllByRole("button", {
      name: "Hide this option",
    });
    expect(hideButtons.length).toBeGreaterThan(0);
    await user.click(hideButtons[0]);
    expect(onHideOption).toHaveBeenCalled();
  });

  it("reveals hidden options when Show hidden clicked", async () => {
    const user = userEvent.setup();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        namespace="models"
        hiddenValues={HIDDEN}
        onUnhideOption={vi.fn()}
      />
    );
    await user.click(getTrigger());
    await user.click(screen.getByRole("button", { name: /Show hidden/i }));
    // Option B should now appear in the hidden section
    expect(screen.getAllByText("Option B").length).toBeGreaterThan(0);
  });

  it("provides hover text for options shown from the hidden section", async () => {
    const user = userEvent.setup();
    const longLabel = "opencode/very-long-model-name-that-overflows-the-menu";
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={[
          { value: "a", label: "Option A" },
          { value: "long", label: longLabel },
        ]}
        namespace="models"
        hiddenValues={["long"]}
      />
    );

    await user.click(getTrigger());
    await user.click(screen.getByRole("button", { name: /Show hidden/i }));

    expect(screen.getByTitle(longLabel)).toHaveAttribute("type", "button");
  });

  it("calls onUnhideOption when unhide button clicked on hidden row", async () => {
    const user = userEvent.setup();
    const onUnhideOption = vi.fn();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        namespace="models"
        hiddenValues={HIDDEN}
        onUnhideOption={onUnhideOption}
      />
    );
    await user.click(getTrigger());
    await user.click(screen.getByRole("button", { name: /Show hidden/i }));
    await user.click(
      screen.getByRole("button", { name: "Unhide this option" })
    );
    expect(onUnhideOption).toHaveBeenCalledWith("b");
  });

  it("does not show hide button for currently selected value", async () => {
    const user = userEvent.setup();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        namespace="models"
        hiddenValues={[]}
        onHideOption={vi.fn()}
      />
    );
    await user.click(getTrigger());
    // Options B and C have hide buttons, not A (selected)
    const hideButtons = screen.queryAllByRole("button", {
      name: "Hide this option",
    });
    expect(hideButtons.length).toBe(2);
  });

  it("renders the hidden toggle after inline options", () => {
    const { container } = render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        namespace="models"
        hiddenValues={HIDDEN}
        inline
      />
    );

    const wrapper = container.firstElementChild;
    expect(wrapper?.lastElementChild?.textContent).toContain("Show hidden");
  });
});

describe("CustomSelect — picker shortcut and keyboard navigation", () => {
  const GREEK: SelectOption[] = [
    { value: "alpha", label: "Alpha" },
    { value: "beta", label: "Beta" },
    { value: "off", label: "Unavailable", disabled: true },
    { value: "gamma", label: "Gamma" },
  ];

  function renderWithEditor(
    props: Partial<React.ComponentProps<typeof CustomSelect>> = {}
  ) {
    const onChange = vi.fn();
    render(
      <>
        <textarea aria-label="Prompt editor" />
        <CustomSelect
          id="shortcut-select"
          triggerAriaLabel="Model"
          value="alpha"
          onChange={onChange}
          options={GREEK}
          shortcutTarget={PICKER_SHORTCUT_TARGETS.WORKFLOW_MODEL}
          {...props}
        />
      </>
    );
    const editor = screen.getByRole("textbox", { name: "Prompt editor" });
    editor.focus();
    return { onChange, editor };
  }

  function press(
    target: PickerShortcutTarget = PICKER_SHORTCUT_TARGETS.WORKFLOW_MODEL
  ) {
    act(() => {
      useUiStore.getState().requestPickerShortcut(target, { mobile: false });
    });
  }

  function activeValue() {
    return document
      .querySelector(".cy-dropdown-row-active")
      ?.getAttribute("data-listbox-value");
  }

  beforeEach(() => {
    useUiStore.setState({ pickerShortcutRequest: null });
  });

  it("opens on the shortcut and focuses the list on the current value", async () => {
    renderWithEditor();

    press();

    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());
    expect(activeValue()).toBe("alpha");
    expect(useUiStore.getState().pickerShortcutRequest).toBeNull();
  });

  it("moves with the arrow keys, skips disabled options, and commits on Enter", async () => {
    const { onChange, editor } = renderWithEditor();
    press();
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(activeValue()).toBe("gamma");

    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("gamma");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(editor).toHaveFocus();
  });

  it("advances to the next option, wrapping, on a repeat press", async () => {
    renderWithEditor({ value: "gamma" });
    press();
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());
    expect(activeValue()).toBe("gamma");

    press();

    expect(activeValue()).toBe("alpha");
  });

  it("jumps to a typed label, preferring a prefix match", async () => {
    renderWithEditor();
    press();
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());

    fireEvent.keyDown(listbox, { key: "g" });
    expect(activeValue()).toBe("gamma");

    // "et" matches no label's start, so it falls back to a substring match.
    fireEvent.keyDown(listbox, { key: "Home" });
    fireEvent.keyDown(listbox, { key: "Escape" });
    press();
    await waitFor(() => expect(screen.getByRole("listbox")).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "e" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "t" });
    expect(activeValue()).toBe("beta");
  });

  it("closes on Escape without changing the value and returns focus", async () => {
    const { onChange, editor } = renderWithEditor();
    press();
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(editor).toHaveFocus();
  });

  it("ignores a shortcut aimed at another picker", () => {
    renderWithEditor();

    press(PICKER_SHORTCUT_TARGETS.WORKFLOW_HARNESS);

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(useUiStore.getState().pickerShortcutRequest?.target).toBe(
      PICKER_SHORTCUT_TARGETS.WORKFLOW_HARNESS
    );
  });

  it("consumes but ignores the shortcut while disabled", () => {
    renderWithEditor({ disabled: true });

    press();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(useUiStore.getState().pickerShortcutRequest).toBeNull();
  });

  it("keeps mouse opening as it was: focus stays on the trigger", async () => {
    const user = userEvent.setup();
    renderWithEditor();

    const trigger = screen.getByRole("button", { name: /Model/ });
    await user.click(trigger);

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.querySelector(".cy-dropdown-row-active")).toBeNull();
  });

  it("names the shortcut in the trigger tooltip", () => {
    renderWithEditor();

    expect(screen.getByRole("button", { name: /Model/ })).toHaveAttribute(
      "title",
      expect.stringMatching(/Shortcut: Alt\+M$/)
    );
  });

  it("closes an inline list through onRequestClose on Escape", async () => {
    const onRequestClose = vi.fn();
    render(
      <CustomSelect
        value="alpha"
        onChange={vi.fn()}
        options={GREEK}
        inline
        shortcutTarget={PICKER_SHORTCUT_TARGETS.STEP_MODEL}
        onRequestClose={onRequestClose}
      />
    );

    press(PICKER_SHORTCUT_TARGETS.STEP_MODEL);
    const listbox = screen.getByRole("listbox");
    await waitFor(() => expect(listbox).toHaveFocus());
    fireEvent.keyDown(listbox, { key: "Escape" });

    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("drops a request that has outlived its window", () => {
    useUiStore.setState({
      pickerShortcutRequest: {
        target: PICKER_SHORTCUT_TARGETS.WORKFLOW_MODEL,
        nonce: 1,
        issuedAt: Date.now() - PICKER_SHORTCUT_REQUEST_TTL_MS - 1,
      },
    });

    renderWithEditor();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(useUiStore.getState().pickerShortcutRequest).toBeNull();
  });
});
