/**
 * Tests for SplitButton.
 *
 * Two shapes: the default chevron-trigger form, and the collapsed
 * `hideMenuButton` form used where footer/header width is scarce. Both must
 * reach the same menu, so most assertions run against both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SplitButton,
  type SplitButtonOption,
} from "@components/shared/SplitButton";

const DROPDOWN_LABEL = "Open the menu";

function buildOptions(
  overrides: Partial<SplitButtonOption>[] = []
): SplitButtonOption[] {
  const base: SplitButtonOption[] = [
    { label: "First option", value: "first", onClick: vi.fn() },
    { label: "Second option", value: "second", onClick: vi.fn() },
  ];
  return base.map((opt, i) => ({ ...opt, ...(overrides[i] ?? {}) }));
}

function renderSplitButton(
  props: Partial<React.ComponentProps<typeof SplitButton>> = {}
) {
  const mainAction = props.mainAction ?? vi.fn();
  const options = props.options ?? buildOptions();
  const utils = render(
    <SplitButton
      mainLabel="Run"
      mainTitle="Run the thing"
      dropdownAriaLabel={DROPDOWN_LABEL}
      {...props}
      mainAction={mainAction}
      options={options}
    />
  );
  return { ...utils, mainAction, options };
}

/** The main button, addressed by its visible label rather than its role name. */
const mainButton = () => screen.getByRole("button", { name: /^Run/ });
const buttonGroup = () => document.querySelector(".cy-button-group")!;
const queryChevron = () =>
  screen.queryByRole("button", { name: DROPDOWN_LABEL });

describe("SplitButton — chevron trigger visibility", () => {
  it("renders the chevron trigger by default", () => {
    renderSplitButton();
    expect(queryChevron()).toBeInTheDocument();
    expect(
      screen.queryByTestId("split-button-flyout-marker")
    ).not.toBeInTheDocument();
  });

  it("drops the chevron trigger and marks the main button as a flyout when hideMenuButton is set", () => {
    renderSplitButton({ hideMenuButton: true });
    expect(queryChevron()).not.toBeInTheDocument();
    expect(
      screen.getByTestId("split-button-flyout-marker")
    ).toBeInTheDocument();
    expect(mainButton()).toHaveAttribute("aria-haspopup", "listbox");
    expect(mainButton()).toHaveAttribute("aria-expanded", "false");
    // The hint has to survive somewhere, or the menu is invisible.
    expect(mainButton().getAttribute("title")).toContain("Right-click");
  });

  it("moves the badge onto the main button when the chevron is collapsed away", () => {
    renderSplitButton({ hideMenuButton: true, badge: "3" });
    expect(mainButton()).toHaveTextContent("3");
  });
});

describe("SplitButton — right-click opens the menu", () => {
  it.each([
    ["with the chevron visible", false],
    ["with the chevron collapsed", true],
  ])("%s", async (_name, hideMenuButton) => {
    const user = userEvent.setup();
    const { options } = renderSplitButton({ hideMenuButton });

    fireEvent.contextMenu(buttonGroup());

    await user.click(screen.getByRole("option", { name: "Second option" }));
    expect(options[1].onClick).toHaveBeenCalledTimes(1);
  });

  it("does not open when the menu is disabled", () => {
    renderSplitButton({ hideMenuButton: true, dropdownDisabled: true });
    fireEvent.contextMenu(buttonGroup());
    expect(mainButton()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("SplitButton — press and hold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the menu and swallows the click the browser synthesises on lift", () => {
    const { mainAction } = renderSplitButton({ hideMenuButton: true });
    const group = buttonGroup();

    fireEvent.touchStart(group, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(mainButton()).toHaveAttribute("aria-expanded", "true");

    fireEvent.touchEnd(group);
    fireEvent.click(mainButton());
    expect(mainAction).not.toHaveBeenCalled();
  });

  it("leaves a plain tap alone", () => {
    const { mainAction } = renderSplitButton({ hideMenuButton: true });
    const group = buttonGroup();

    fireEvent.touchStart(group, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.touchEnd(group);
    fireEvent.click(mainButton());
    expect(mainAction).toHaveBeenCalledTimes(1);
  });

  it("does not swallow the tap after an earlier long press", () => {
    const { mainAction } = renderSplitButton({ hideMenuButton: true });
    const group = buttonGroup();

    fireEvent.touchStart(group, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.touchEnd(group);
    fireEvent.click(mainButton());

    // Second gesture: an ordinary tap must reach the main action.
    fireEvent.touchStart(group, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchEnd(group);
    fireEvent.click(mainButton());
    expect(mainAction).toHaveBeenCalledTimes(1);
  });
});

describe("SplitButton — keyboard", () => {
  it("runs the main action on Enter rather than opening the menu", async () => {
    const user = userEvent.setup();
    const { mainAction } = renderSplitButton();
    mainButton().focus();
    await user.keyboard("{Enter}");
    expect(mainAction).toHaveBeenCalledTimes(1);
    expect(queryChevron()).toHaveAttribute("aria-expanded", "false");
  });

  it("runs the main action on Space rather than opening the menu", async () => {
    const user = userEvent.setup();
    const { mainAction } = renderSplitButton();
    mainButton().focus();
    await user.keyboard(" ");
    expect(mainAction).toHaveBeenCalledTimes(1);
    expect(queryChevron()).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the menu on Enter from the chevron trigger", async () => {
    const user = userEvent.setup();
    const { mainAction } = renderSplitButton();
    queryChevron()!.focus();
    await user.keyboard("{Enter}");
    expect(queryChevron()).toHaveAttribute("aria-expanded", "true");
    expect(mainAction).not.toHaveBeenCalled();
  });

  it("opens the menu on ArrowDown from the main button when collapsed, highlighting the first enabled option", async () => {
    const user = userEvent.setup();
    renderSplitButton({
      hideMenuButton: true,
      options: buildOptions([{ disabled: true }]),
    });
    mainButton().focus();
    await user.keyboard("{ArrowDown}");
    expect(mainButton()).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("option", { name: "Second option" })
    ).toHaveAttribute("aria-selected", "true");
  });

  it("returns focus to the main button on Escape when collapsed", async () => {
    const user = userEvent.setup();
    renderSplitButton({ hideMenuButton: true });
    mainButton().focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Escape}");
    expect(mainButton()).toHaveAttribute("aria-expanded", "false");
    expect(mainButton()).toHaveFocus();
  });
});

describe("SplitButton — option opener", () => {
  it("hands the collapsed main button to option callbacks as the focus-restoration opener", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderSplitButton({
      hideMenuButton: true,
      options: buildOptions([{ onClick }]),
    });

    fireEvent.contextMenu(buttonGroup());
    await user.click(screen.getByRole("option", { name: "First option" }));
    expect(onClick).toHaveBeenCalledWith(mainButton());
  });

  it("hands the chevron trigger to option callbacks in the default form", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderSplitButton({ options: buildOptions([{ onClick }]) });

    await user.click(queryChevron()!);
    await user.click(screen.getByRole("option", { name: "First option" }));
    expect(onClick).toHaveBeenCalledWith(queryChevron());
  });
});

describe("SplitButton — disabled main action while collapsed", () => {
  it("keeps the menu reachable and refuses the main action", async () => {
    const user = userEvent.setup();
    const { mainAction, options } = renderSplitButton({
      hideMenuButton: true,
      mainDisabled: true,
    });

    // Left enabled on purpose: browsers dispatch no pointer events on a
    // disabled control, which would take the menu down with the action.
    expect(mainButton()).toBeEnabled();
    expect(mainButton()).toHaveAttribute("aria-disabled", "true");

    await user.click(mainButton());
    expect(mainAction).not.toHaveBeenCalled();

    fireEvent.contextMenu(buttonGroup());
    await user.click(screen.getByRole("option", { name: "First option" }));
    expect(options[0].onClick).toHaveBeenCalledTimes(1);
  });

  it("disables the main button outright when the whole control is disabled", () => {
    renderSplitButton({ hideMenuButton: true, disabled: true });
    expect(mainButton()).toBeDisabled();
  });
});

describe("SplitButton — footer form", () => {
  it("renders a drop-up menu through the portal outside the button container", async () => {
    const user = userEvent.setup();
    const { container } = renderSplitButton({
      menuPlacement: "top",
      portal: true,
    });

    await user.click(queryChevron()!);
    const menu = await screen.findByRole("listbox");

    expect(menu).toBeInTheDocument();
    expect(container).not.toContainElement(menu);
    expect(menu.style.bottom).not.toBe("");
  });

  it("applies the compact editor button sizing", () => {
    renderSplitButton({ size: "compact" });

    expect(mainButton()).toHaveClass("px-3", "py-1", "text-xs");
    expect(queryChevron()).toHaveClass("text-xs");
  });

  it("uses mainAriaLabel as the primary button name", () => {
    renderSplitButton({ mainAriaLabel: "Run" });

    expect(screen.getByRole("button", { name: "Run" })).toBe(mainButton());
  });

  it("keeps click-outside and Escape closing a portaled menu", async () => {
    const user = userEvent.setup();
    renderSplitButton({ portal: true });

    await user.click(queryChevron()!);
    await screen.findByRole("option", { name: "First option" });
    fireEvent.mouseDown(document.body);
    expect(
      screen.queryByRole("option", { name: "First option" })
    ).not.toBeInTheDocument();

    await user.click(queryChevron()!);
    await screen.findByRole("option", { name: "First option" });
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("option", { name: "First option" })
    ).not.toBeInTheDocument();
  });

  it("supports keyboard navigation in a portaled menu", async () => {
    const user = userEvent.setup();
    renderSplitButton({ portal: true });

    await user.click(queryChevron()!);
    await screen.findByRole("option", { name: "First option" });
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("option", { name: "First option" })
    ).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("option", { name: "Second option" })
    ).toHaveAttribute("aria-selected", "true");
  });
});
