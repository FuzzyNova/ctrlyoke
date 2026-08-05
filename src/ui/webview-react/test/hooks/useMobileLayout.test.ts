import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMobileLayout } from "@hooks/useMobileLayout";
import { useUiStore } from "@store/uiStore";

function focusEditable(container: HTMLElement, tag: "input" | "textarea") {
  const el = document.createElement(tag);
  container.appendChild(el);
  el.focus();
  return el;
}

async function flushRaf() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

describe("useMobileLayout — keyboard-aware editor collapse", () => {
  let outputSection: HTMLElement;

  beforeEach(() => {
    // resetUi() doesn't touch outputCollapsed/editorCollapsed (that's
    // resetLayoutState(), which also clears persisted storage) — set the two
    // flags this suite cares about directly for tight test isolation.
    useUiStore.setState({ outputCollapsed: false, editorCollapsed: false });
    outputSection = document.createElement("section");
    outputSection.id = "output-section";
    document.body.appendChild(outputSection);
  });

  afterEach(() => {
    cleanup();
    outputSection.remove();
    document.body.replaceChildren();
  });

  function renderMobileLayout(overrides: Partial<Parameters<typeof useMobileLayout>[0]> = {}) {
    return renderHook(() =>
      useMobileLayout({
        isMobile: true,
        uiLayoutReady: true,
        outputCollapsed: useUiStore.getState().outputCollapsed,
        editorCollapsed: useUiStore.getState().editorCollapsed,
        ...overrides,
      })
    );
  }

  it("collapses the editor when an editable element inside #output-section is focused", () => {
    renderMobileLayout();

    const input = focusEditable(outputSection, "input");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(useUiStore.getState().editorCollapsed).toBe(true);
  });

  it("does nothing when the output panel is already collapsed", () => {
    useUiStore.setState({ outputCollapsed: true });
    renderMobileLayout();

    const input = focusEditable(outputSection, "input");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(useUiStore.getState().editorCollapsed).toBe(false);
  });

  it("does nothing when the editor panel is already collapsed", () => {
    useUiStore.setState({ editorCollapsed: true });
    renderMobileLayout();

    const input = focusEditable(outputSection, "input");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    // Stays collapsed (unchanged), and nothing was "forced" that would later
    // be incorrectly restored.
    expect(useUiStore.getState().editorCollapsed).toBe(true);
  });

  it("ignores focus on non-editable elements inside #output-section", () => {
    renderMobileLayout();

    const button = document.createElement("button");
    outputSection.appendChild(button);
    act(() => {
      button.focus();
      button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(useUiStore.getState().editorCollapsed).toBe(false);
  });

  it("ignores focus on editable elements outside #output-section", () => {
    renderMobileLayout();

    const outside = document.createElement("input");
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
      outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(useUiStore.getState().editorCollapsed).toBe(false);
  });

  it("restores the editor once focus leaves #output-section entirely", async () => {
    renderMobileLayout();

    const input = focusEditable(outputSection, "input");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(useUiStore.getState().editorCollapsed).toBe(true);

    act(() => {
      input.blur();
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flushRaf();

    expect(useUiStore.getState().editorCollapsed).toBe(false);
  });

  it("stays collapsed when focus moves between two editables inside #output-section", async () => {
    renderMobileLayout();

    const input = focusEditable(outputSection, "input");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(useUiStore.getState().editorCollapsed).toBe(true);

    const textarea = document.createElement("textarea");
    outputSection.appendChild(textarea);

    act(() => {
      input.blur();
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      textarea.focus();
    });
    await flushRaf();

    expect(useUiStore.getState().editorCollapsed).toBe(true);
  });

  it("restores the editor on unmount if still forced-collapsed", () => {
    const { unmount } = renderMobileLayout();

    const input = focusEditable(outputSection, "input");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    expect(useUiStore.getState().editorCollapsed).toBe(true);

    act(() => {
      unmount();
    });

    expect(useUiStore.getState().editorCollapsed).toBe(false);
  });

  it("does nothing on desktop (isMobile: false)", () => {
    renderMobileLayout({ isMobile: false });

    const input = focusEditable(outputSection, "input");
    act(() => {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(useUiStore.getState().editorCollapsed).toBe(false);
  });
});
