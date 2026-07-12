import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CustomSelect,
  type SelectOption,
} from "@components/shared/CustomSelect";

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
    const optionBBtn = screen.getAllByText("Option B")[0].closest("button")!;
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
    expect(screen.getByTitle(description)).toBeInTheDocument();
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
    const disabledBtn = screen
      .getAllByText("B (disabled)")[0]
      .closest("button")!;
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
    const hideButtons = screen.getAllByTitle("Hide this option");
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
    await user.click(screen.getByText(/Show hidden/i));
    // Option B should now appear in the hidden section
    expect(screen.getAllByText("Option B").length).toBeGreaterThan(0);
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
    await user.click(screen.getByText(/Show hidden/i));
    await user.click(screen.getByTitle("Unhide this option"));
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
    const hideButtons = screen.queryAllByTitle("Hide this option");
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
