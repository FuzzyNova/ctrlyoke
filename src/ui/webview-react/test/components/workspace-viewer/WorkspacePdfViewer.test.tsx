import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const { getDocument, loadingTaskDestroy, renderedPages, cancelledRenders } =
  vi.hoisted(() => ({
    getDocument: vi.fn(),
    loadingTaskDestroy: vi.fn(),
    renderedPages: [] as number[],
    cancelledRenders: [] as number[],
  }));

vi.mock("@utils/workspacePdfSupport/loadWorkspacePdfSupport", () => ({
  PDFJS_ASSET_PATH: "/pdfjs/",
  loadWorkspacePdfSupport: async () => ({ getDocument }),
}));

import { WorkspacePdfViewer } from "@components/workspace-viewer/WorkspacePdfViewer";

const observers: MockIntersectionObserver[] = [];
class MockIntersectionObserver {
  private readonly callback: IntersectionObserverCallback;
  private readonly targets = new Set<Element>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  disconnect() {
    this.targets.clear();
  }
  intersect(target: Element) {
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  leave(target: Element) {
    this.callback(
      [{ target, isIntersecting: false } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  get observed() {
    return [...this.targets];
  }
}

function makePdf(pageCount = 3) {
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: vi.fn(() => {
      renderedPages.push(index + 1);
      return {
        promise: Promise.resolve(),
        cancel: vi.fn(() => cancelledRenders.push(index + 1)),
      };
    }),
  }));
  const document = {
    numPages: pageCount,
    getPage: vi.fn(async (number: number) => pages[number - 1]),
  };
  const task = {
    promise: Promise.resolve(document),
    destroy: loadingTaskDestroy,
  };
  getDocument.mockReturnValue(task);
  return { document, pages };
}

describe("WorkspacePdfViewer", () => {
  let originalIntersectionObserver: typeof window.IntersectionObserver;
  let originalCanvasGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    observers.length = 0;
    renderedPages.length = 0;
    cancelledRenders.length = 0;
    getDocument.mockReset();
    loadingTaskDestroy.mockReset();
    originalIntersectionObserver = window.IntersectionObserver;
    originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: MockIntersectionObserver,
    });
    HTMLCanvasElement.prototype.getContext =
      (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: originalIntersectionObserver,
    });
    HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
  });

  it("loads with the raw URL, static data URLs, and range-friendly options", async () => {
    makePdf(1);
    render(<WorkspacePdfViewer rawUrl="/raw/manual.pdf?token=x" />);

    await waitFor(() => expect(getDocument).toHaveBeenCalledOnce());
    expect(getDocument).toHaveBeenCalledWith({
      url: "/raw/manual.pdf?token=x",
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
    });
  });

  it("renders only pages intersecting the viewport observer", async () => {
    makePdf(3);
    render(<WorkspacePdfViewer rawUrl="/raw/long.pdf" />);
    await waitFor(() => expect(observers).toHaveLength(3));
    expect(renderedPages).toEqual([]);

    const firstPage = observers[0].observed[0];
    act(() => observers[0].intersect(firstPage));
    await waitFor(() => expect(renderedPages).toEqual([1]));
  });

  it("cancels page rendering when the page leaves the viewport or zoom changes", async () => {
    makePdf(1);
    render(<WorkspacePdfViewer rawUrl="/raw/zoom.pdf" />);
    await waitFor(() => expect(observers).toHaveLength(1));
    const firstPage = observers[0].observed[0];
    act(() => observers[0].intersect(firstPage));
    await waitFor(() => expect(renderedPages).toEqual([1]));

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(cancelledRenders).toEqual([1]));
    await waitFor(() => expect(renderedPages).toEqual([1, 1]));

    act(() => observers[0].leave(firstPage));
    await waitFor(() => expect(cancelledRenders).toEqual([1, 1]));
  });

  it("destroys the loading task and document on file change and unmount", async () => {
    const { document } = makePdf(1);
    const view = render(<WorkspacePdfViewer rawUrl="/raw/one.pdf" />);
    await waitFor(() => expect(document.getPage).toHaveBeenCalled());

    const nextDocument = makePdf(1).document;
    view.rerender(<WorkspacePdfViewer rawUrl="/raw/two.pdf" />);
    await waitFor(() => expect(nextDocument.getPage).toHaveBeenCalled());
    expect(loadingTaskDestroy).toHaveBeenCalled();

    view.unmount();
    expect(loadingTaskDestroy).toHaveBeenCalledTimes(2);
  });

  it("shows an open-in-new-tab link for a failed PDF", async () => {
    getDocument.mockReturnValue({
      promise: Promise.reject(new Error("invalid PDF")),
      destroy: loadingTaskDestroy,
    });
    render(<WorkspacePdfViewer rawUrl="/raw/broken.pdf" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This PDF could not be opened."
    );
    expect(
      within(screen.getByRole("alert")).getByRole("link", {
        name: "Open in new tab",
      })
    ).toHaveAttribute("href", "/raw/broken.pdf");
  });
});
