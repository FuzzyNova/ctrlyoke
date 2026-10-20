/**
 * Tests for useScopedSelectAll — confining Ctrl/Cmd+A to the dashboard region
 * the user last pressed or focused, by intercepting the `selectstart` that
 * both VS Code's webview Select All and the browser's native select-all
 * dispatch at the document root.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useScopedSelectAll } from "@hooks/useScopedSelectAll";
import {
  SELECT_ALL_SCOPE_ATTRIBUTE,
  SELECT_ALL_SCOPES,
  type SelectAllScope,
} from "@root/types/DashboardConstants";

function addRegion(scope: SelectAllScope | null, text: string): HTMLElement {
  const region = document.createElement("div");
  if (scope) region.setAttribute(SELECT_ALL_SCOPE_ATTRIBUTE, scope);
  const child = document.createElement("span");
  child.textContent = text;
  region.appendChild(child);
  document.body.appendChild(region);
  return child;
}

function press(target: Element) {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

/** Dispatches a select-all `selectstart`; returns whether it was cancelled. */
function selectAll(target: Node = document.body): boolean {
  const event = new Event("selectstart", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("useScopedSelectAll", () => {
  beforeEach(() => {
    renderHook(() => useScopedSelectAll());
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  it("selects only the contents of the pressed CONTENTS region", () => {
    const output = addRegion(SELECT_ALL_SCOPES.CONTENTS, "output text");
    addRegion(null, "properties chrome");

    press(output);

    expect(selectAll()).toBe(true);
    expect(window.getSelection()?.toString()).toBe("output text");
  });

  it("suppresses the text selection in a HANDLED region", () => {
    const steps = addRegion(SELECT_ALL_SCOPES.HANDLED, "step 1");

    press(steps);

    expect(selectAll()).toBe(true);
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("suppresses select-all outside any scope", () => {
    const chrome = addRegion(null, "tab bar");

    press(chrome);

    expect(selectAll()).toBe(true);
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("follows focus moved by keyboard", () => {
    const steps = addRegion(SELECT_ALL_SCOPES.HANDLED, "step 1");
    const output = addRegion(SELECT_ALL_SCOPES.CONTENTS, "output text");
    press(steps);

    output.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(selectAll()).toBe(true);
    expect(window.getSelection()?.toString()).toBe("output text");
  });

  it("leaves drag selections alone", () => {
    const chrome = addRegion(null, "tab bar");

    expect(selectAll(chrome)).toBe(false);
  });

  it("leaves select-all inside a focused text field alone", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    expect(selectAll()).toBe(false);
  });
});
