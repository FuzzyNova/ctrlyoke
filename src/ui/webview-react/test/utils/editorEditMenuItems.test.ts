import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type {
  StepContextMenuEntry,
  StepContextMenuItem,
} from "@components/shared/StepContextMenu";
import {
  buildEditorEditMenuItems,
  findWordRangeAt,
} from "@utils/editorEditMenuItems";

const views: EditorView[] = [];

function createView(doc: string, anchor: number, head = anchor): EditorView {
  const view = new EditorView({
    parent: document.body,
    doc,
    selection: { anchor, head },
  });
  views.push(view);
  return view;
}

function item(
  items: StepContextMenuEntry[],
  label: string
): StepContextMenuItem {
  const found = items.find(
    (entry): entry is StepContextMenuItem =>
      "label" in entry && entry.label === label
  );
  if (!found) throw new Error(`No menu item "${label}"`);
  return found;
}

function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

beforeAll(() => {
  // jsdom has no Range layout; CodeMirror measures after a scrollIntoView.
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
});

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.unstubAllGlobals();
});

describe("findWordRangeAt", () => {
  const state = EditorState.create({ doc: "see @src/a/b.ts now" });

  it("spans a whole reference on either side of the caret", () => {
    expect(findWordRangeAt(state, 15)).toEqual({ from: 4, to: 15 });
    expect(findWordRangeAt(state, 4)).toEqual({ from: 4, to: 15 });
    expect(findWordRangeAt(state, 9)).toEqual({ from: 4, to: 15 });
  });

  it("finds nothing between two spaces", () => {
    const spaced = EditorState.create({ doc: "a  b" });
    expect(findWordRangeAt(spaced, 2)).toBeNull();
  });
});

describe("buildEditorEditMenuItems", () => {
  it("orders the clipboard group before the selection group", () => {
    const items = buildEditorEditMenuItems(createView("text", 0), false);
    expect(
      items.map((entry) => ("label" in entry ? entry.label : "|"))
    ).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "|",
      "Select Word",
      "Select Line",
      "Select All",
    ]);
  });

  it("selects the word, line and document around the caret", () => {
    const doc = "first line\nsee @src/a/b.ts\nlast";
    const view = createView(doc, doc.indexOf("@src") + 3);

    item(buildEditorEditMenuItems(view, false), "Select Word").onClick();
    expect(selectedText(view)).toBe("@src/a/b.ts");

    item(buildEditorEditMenuItems(view, false), "Select Line").onClick();
    expect(selectedText(view)).toBe("see @src/a/b.ts\n");

    item(buildEditorEditMenuItems(view, false), "Select All").onClick();
    expect(selectedText(view)).toBe(doc);
  });

  it("cuts the selection to the clipboard and pastes clipboard text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("pasted");
    vi.stubGlobal("navigator", { clipboard: { writeText, readText } });
    const view = createView("keep cut", 5, 8);

    item(buildEditorEditMenuItems(view, false), "Cut").onClick();
    expect(writeText).toHaveBeenCalledWith("cut");
    expect(view.state.doc.toString()).toBe("keep ");

    item(buildEditorEditMenuItems(view, false), "Paste").onClick();
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe("keep pasted")
    );
  });

  it("disables editing items when read-only or nothing applies", () => {
    const readOnly = buildEditorEditMenuItems(createView("a b", 0, 1), true);
    expect(item(readOnly, "Cut").disabled).toBe(true);
    expect(item(readOnly, "Paste").disabled).toBe(true);
    expect(item(readOnly, "Copy").disabled).toBe(false);

    const empty = buildEditorEditMenuItems(createView("", 0), false);
    expect(item(empty, "Copy").disabled).toBe(true);
    expect(item(empty, "Select Word").disabled).toBe(true);
    expect(item(empty, "Select Line").disabled).toBe(true);
    expect(item(empty, "Select All").disabled).toBe(true);
  });
});
