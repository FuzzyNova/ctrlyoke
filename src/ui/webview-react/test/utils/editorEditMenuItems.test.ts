import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import type {
  ContextMenuEntry,
  ContextMenuItem,
} from "@components/shared/ContextMenu";
import {
  buildEditorEditMenuItems,
  findWordRangeAt,
  isTouchOnSelectionHandle,
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

function item(items: ContextMenuEntry[], label: string): ContextMenuItem {
  const found = items.find(
    (entry): entry is ContextMenuItem =>
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

  it("hands clipboard images to pasteImages instead of pasting text", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    const read = vi.fn().mockResolvedValue([
      {
        types: ["text/html", "image/png"],
        getType: vi.fn().mockResolvedValue(blob),
      },
    ]);
    const readText = vi.fn().mockResolvedValue("text");
    vi.stubGlobal("navigator", { clipboard: { read, readText } });
    const pasteImages = vi.fn();
    const view = createView("", 0);

    item(
      buildEditorEditMenuItems(view, false, { pasteImages }),
      "Paste"
    ).onClick();

    await vi.waitFor(() =>
      expect(pasteImages).toHaveBeenCalledWith([
        { blob, mimeType: "image/png" },
      ])
    );
    expect(readText).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");
  });

  it("pastes text when the clipboard has no image or cannot be read as items", async () => {
    const readText = vi.fn().mockResolvedValue("pasted");
    const pasteImages = vi.fn();
    vi.stubGlobal("navigator", {
      clipboard: {
        read: vi.fn().mockRejectedValue(new Error("denied")),
        readText,
      },
    });
    const view = createView("", 0);

    item(
      buildEditorEditMenuItems(view, false, { pasteImages }),
      "Paste"
    ).onClick();

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("pasted"));
    expect(pasteImages).not.toHaveBeenCalled();
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

describe("isTouchOnSelectionHandle", () => {
  // jsdom has no layout, so give each document position a fixed line box:
  // x = 10px per character, line from y=100 to y=120.
  function withCoords(view: EditorView): EditorView {
    vi.spyOn(view, "coordsAtPos").mockImplementation((pos: number) => ({
      left: pos * 10,
      right: pos * 10,
      top: 100,
      bottom: 120,
    }));
    return view;
  }

  it("is false with no selection, wherever the touch lands", () => {
    const view = withCoords(createView("hello world", 3));
    expect(isTouchOnSelectionHandle(view, 30, 110)).toBe(false);
  });

  it("is true on either end of a selection, including the knob outside the line", () => {
    const view = withCoords(createView("hello world", 2, 8));
    expect(isTouchOnSelectionHandle(view, 20, 110)).toBe(true);
    expect(isTouchOnSelectionHandle(view, 80, 145)).toBe(true);
    expect(isTouchOnSelectionHandle(view, 15, 75)).toBe(true);
  });

  it("is false in the middle of a selection or away from it", () => {
    const view = withCoords(createView("hello world", 1, 10));
    expect(isTouchOnSelectionHandle(view, 55, 110)).toBe(false);
    expect(isTouchOnSelectionHandle(view, 10, 200)).toBe(false);
  });
});
