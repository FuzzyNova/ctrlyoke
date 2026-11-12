import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EditorView } from "@codemirror/view";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { PASTING_IMAGE_PLACEHOLDER } from "@/types/messages";
import {
  pasteImagesAsReferences,
  pastedImagePlaceholderField,
} from "@utils/pastedImages";

const views: EditorView[] = [];

function createView(doc: string, anchor: number): EditorView {
  const view = new EditorView({
    parent: document.body,
    doc,
    selection: { anchor },
    extensions: [pastedImagePlaceholderField],
  });
  views.push(view);
  return view;
}

function reply(data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: MESSAGE_TYPES.PASTED_IMAGE_SAVED, ...data },
    })
  );
}

const image = {
  blob: new Blob(["image"], { type: "image/png" }),
  mimeType: "image/png",
};

beforeAll(() => {
  // jsdom has no Range layout; CodeMirror measures after a scrollIntoView.
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
});

beforeEach(() => {
  vi.stubGlobal(
    "FileReader",
    class {
      result: string | ArrayBuffer | null = "data:image/png;base64,AQ==";
      onload: (() => unknown) | null = null;
      onerror: (() => unknown) | null = null;
      readAsDataURL() {
        this.onload?.();
      }
    }
  );
});

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.unstubAllGlobals();
});

describe("pasteImagesAsReferences", () => {
  it("swaps the placeholder for a reference once the image is saved, through later edits", async () => {
    const transport = { postMessage: vi.fn() };
    const view = createView("prompt: see ", 12);

    pasteImagesAsReferences(view, [image], transport);
    expect(view.state.doc.toString()).toBe(
      `prompt: see ${PASTING_IMAGE_PLACEHOLDER}`
    );
    const request = transport.postMessage.mock.calls[0]![0] as {
      type: string;
      seq: number;
      mimeType: string;
    };
    expect(request).toMatchObject({
      type: MESSAGE_TYPES.SAVE_PASTED_IMAGE,
      mimeType: "image/png",
      dataBase64: "AQ==",
    });

    view.dispatch({ changes: { from: 0, insert: "# " } });
    reply({ seq: request.seq + 1000, relativePath: "other.png" });
    reply({ seq: request.seq, relativePath: ".ctrlyoke/attachments/a.png" });

    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe(
        "# prompt: see @.ctrlyoke/attachments/a.png "
      )
    );
    expect(view.state.field(pastedImagePlaceholderField).size).toBe(0);
  });

  it("removes the placeholder when the save fails", async () => {
    const transport = { postMessage: vi.fn() };
    const view = createView("x", 1);

    pasteImagesAsReferences(view, [image], transport);
    const { seq } = transport.postMessage.mock.calls[0]![0] as { seq: number };
    reply({ seq, error: "disk full" });

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("x"));
  });

  it("skips images of an unsupported type", () => {
    const transport = { postMessage: vi.fn() };
    const view = createView("", 0);

    pasteImagesAsReferences(
      view,
      [{ blob: new Blob(["x"]), mimeType: "image/x-unknown" }],
      transport
    );

    expect(view.state.doc.toString()).toBe("");
    expect(
      transport.postMessage.mock.calls.some(
        ([message]) =>
          (message as { type?: string }).type ===
          MESSAGE_TYPES.SAVE_PASTED_IMAGE
      )
    ).toBe(false);
  });
});
