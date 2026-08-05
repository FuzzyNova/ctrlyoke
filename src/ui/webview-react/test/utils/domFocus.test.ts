import { afterEach, describe, expect, it } from "vitest";
import { isEditableElement, isEditableElementFocused } from "@utils/domFocus";

describe("isEditableElement", () => {
  it("returns true for input elements", () => {
    expect(isEditableElement(document.createElement("input"))).toBe(true);
  });

  it("returns true for textarea elements", () => {
    expect(isEditableElement(document.createElement("textarea"))).toBe(true);
  });

  it("returns true for contentEditable elements", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isEditableElement(div)).toBe(true);
  });

  it("returns false for non-editable elements", () => {
    expect(isEditableElement(document.createElement("button"))).toBe(false);
    expect(isEditableElement(document.createElement("div"))).toBe(false);
  });
});

describe("isEditableElementFocused", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("returns true when the active element is editable", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    expect(isEditableElementFocused()).toBe(true);
  });

  it("returns false when the active element is not editable", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    expect(isEditableElementFocused()).toBe(false);
  });

  it("returns false when nothing is focused", () => {
    expect(isEditableElementFocused()).toBe(false);
  });
});
