import { afterEach, describe, expect, it } from "vitest";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  SearchQuery,
  getSearchQuery,
  openSearchPanel,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import {
  SEARCH_MATCH_COUNT_LIMIT,
  countSearchMatches,
  createSearchPanelExtension,
  formatSearchMatchCount,
} from "@utils/codemirrorSearchPanel";

const views: EditorView[] = [];

function createView(doc: string, readOnly = false): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc,
    extensions: [
      createSearchPanelExtension(),
      keymap.of(searchKeymap),
      EditorState.readOnly.of(readOnly),
    ],
  });
  views.push(view);
  return view;
}

function panel(view: EditorView): HTMLElement {
  const root = view.dom.querySelector<HTMLElement>(".cy-cm-find");
  if (!root) throw new Error("search panel is not open");
  return root;
}

function field(view: EditorView, label: string): HTMLInputElement {
  return panel(view).querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )!;
}

function button(view: EditorView, label: string): HTMLButtonElement {
  return panel(view).querySelector<HTMLButtonElement>(
    `button[aria-label^="${label}"]`
  )!;
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function count(view: EditorView): string {
  return panel(view).querySelector(".cy-find-widget-count")!.textContent ?? "";
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

describe("codemirror search panel", () => {
  it("opens the shared find widget as a top panel", () => {
    const view = createView("alpha beta alpha");
    openSearchPanel(view);

    const root = panel(view);
    expect(root).toHaveClass("cy-find-widget");
    expect(root).toHaveAttribute("role", "search");
    expect(root.parentElement).toHaveClass("cm-panels-top");
    expect(field(view, "Find")).toHaveClass("cy-find-widget-input");
  });

  it("counts matches and tracks the current one", () => {
    const view = createView("alpha beta alpha");
    openSearchPanel(view);

    type(field(view, "Find"), "alpha");
    expect(getSearchQuery(view.state).search).toBe("alpha");
    expect(count(view)).toBe("? of 2");

    button(view, "Next match").click();
    expect(count(view)).toBe("1 of 2");
    button(view, "Next match").click();
    expect(count(view)).toBe("2 of 2");

    type(field(view, "Find"), "gamma");
    expect(count(view)).toBe("0");
  });

  it("toggles query options and reflects them as pressed buttons", () => {
    const view = createView("Alpha alpha");
    openSearchPanel(view);
    type(field(view, "Find"), "alpha");
    expect(count(view)).toBe("? of 2");

    const caseToggle = button(view, "Match case");
    expect(caseToggle).toHaveAttribute("aria-pressed", "false");
    caseToggle.click();
    expect(caseToggle).toHaveAttribute("aria-pressed", "true");
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
    expect(count(view)).toBe("? of 1");

    button(view, "Use regular expression").click();
    type(field(view, "Find"), "(");
    expect(field(view, "Find")).toHaveAttribute("aria-invalid", "true");
  });

  it("follows a query set from outside the panel", () => {
    const view = createView("one two");
    openSearchPanel(view);
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: "two", wholeWord: true })
      ),
    });
    expect(field(view, "Find").value).toBe("two");
    expect(button(view, "Match whole word")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("collapses the replace row by default and remembers it per editor", () => {
    const view = createView("a a");
    openSearchPanel(view);
    expect(field(view, "Replace")).toHaveClass("hidden");

    button(view, "Toggle replace").click();
    expect(field(view, "Replace")).not.toHaveClass("hidden");
    expect(button(view, "Toggle replace")).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    type(field(view, "Find"), "a");
    type(field(view, "Replace"), "b");
    button(view, "Replace all").click();
    expect(view.state.doc.toString()).toBe("b b");

    button(view, "Close").click();
    expect(searchPanelOpen(view.state)).toBe(false);
    openSearchPanel(view);
    expect(field(view, "Replace")).not.toHaveClass("hidden");
  });

  it("omits replace from a read-only editor", () => {
    const view = createView("a a", true);
    openSearchPanel(view);
    expect(field(view, "Replace")).toBeNull();
    expect(
      panel(view).querySelector('button[aria-label="Toggle replace"]')
    ).toBeNull();
  });

  it("closes on Escape through searchKeymap's panel scope", () => {
    const view = createView("a");
    openSearchPanel(view);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    field(view, "Find").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(false);
  });
});

describe("search match counting", () => {
  it("caps the count so a tiny query in a huge document stays cheap", () => {
    const state = EditorState.create({
      doc: "x".repeat(SEARCH_MATCH_COUNT_LIMIT + 50),
    });
    const result = countSearchMatches(state, new SearchQuery({ search: "x" }));
    expect(result).toEqual({
      total: SEARCH_MATCH_COUNT_LIMIT,
      current: 0,
      capped: true,
    });
    expect(formatSearchMatchCount(result)).toBe(
      `? of ${SEARCH_MATCH_COUNT_LIMIT}+`
    );
  });
});
