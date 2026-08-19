import { render, waitFor } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffFileList } from "@components/diff/DiffFileList";
import * as rdvAdapter from "@utils/rdvAdapter";
import {
  createDiffFileFixture,
  flattenDiffFileFixture,
} from "../../fixtures/diffFileFixture";

const SCROLLER_CLASS = "diff-lazy-fixture-scroller";
const { tokenizeMock } = vi.hoisted(() => ({
  tokenizeMock: vi.fn(),
}));

vi.mock("react-diff-view", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-diff-view")>();
  return {
    ...original,
    tokenize: (...args: Parameters<typeof original.tokenize>) => {
      tokenizeMock(...args);
      return original.tokenize(...args);
    },
  };
});

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth"
);
const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;

class NoopResizeObserver implements ResizeObserver {
  observe(_target: Element): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}

  constructor(_callback: ResizeObserverCallback) {}
}

beforeEach(() => {
  window.ResizeObserver = NoopResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains(SCROLLER_CLASS) ? 180 : 120;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const isScroller = this.classList.contains(SCROLLER_CLASS);
    const height = isScroller ? 180 : this.matches("[data-index]") ? 120 : 40;
    return {
      width: 800,
      height,
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: height,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight
    );
  }
  if (originalOffsetWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetWidth",
      originalOffsetWidth
    );
  }
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function FixtureHost(): ReactElement {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollContainerRef} className={SCROLLER_CLASS}>
      <DiffFileList
        groups={createDiffFileFixture(120)}
        emptyMessage="No files"
        command={{ version: 0, collapsed: false }}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
}

function markerFrom(value: string): string | undefined {
  return value.match(/fixture-file-\d+-marker/)?.[0];
}

describe("diff-file lazy construction acceptance", () => {
  it("does not parse, tokenize, or render tables for offscreen files", async () => {
    const toRdvFromContent = vi.spyOn(rdvAdapter, "toRdvFromContent");
    tokenizeMock.mockClear();
    const view = render(<FixtureHost />);

    await waitFor(() => {
      expect(
        view.container.querySelectorAll("[data-index]").length
      ).toBeGreaterThan(0);
    });

    const files = flattenDiffFileFixture(createDiffFileFixture(120));
    const mountedKeys = new Set(
      Array.from(
        view.container.querySelectorAll<HTMLElement>("[data-diff-file-key]")
      )
        .map((row) => {
          const parts = row.dataset.diffFileKey?.split("\u001f") ?? [];
          return parts[parts.length - 1];
        })
        .filter((key): key is string => key !== undefined)
    );
    const mountedMarkers = new Set(
      files
        .filter((file) => mountedKeys.has(file.key))
        .flatMap((file) => {
          const source = file.source;
          if (source.kind !== "content") {
            return [`fixture-file-${file.key.slice("fixture-".length)}-marker`];
          }
          return [source.oldContent, source.newContent].flatMap((content) =>
            content
              ? [markerFrom(content)].filter(
                  (marker): marker is string => marker !== undefined
                )
              : []
          );
        })
    );
    const offscreenMarkers = files
      .filter((file) => !mountedKeys.has(file.key))
      .map(
        (file) => `fixture-file-${file.key.slice("fixture-".length)}-marker`
      );

    expect(mountedKeys.size).toBeLessThan(files.length);
    expect(
      view.container.querySelectorAll("[data-index] table").length
    ).toBeGreaterThan(0);
    expect(toRdvFromContent).toHaveBeenCalled();
    expect(tokenizeMock).toHaveBeenCalled();

    for (const call of toRdvFromContent.mock.calls) {
      const marker = markerFrom(call[0]) ?? markerFrom(call[1]);
      expect(marker).toBeDefined();
      expect(mountedMarkers).toContain(marker);
    }
    for (const marker of offscreenMarkers) {
      expect(
        toRdvFromContent.mock.calls.some(
          (call) =>
            markerFrom(call[0]) === marker || markerFrom(call[1]) === marker
        )
      ).toBe(false);
    }

    const tokenizedHunks = tokenizeMock.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .join("\n");
    for (const marker of offscreenMarkers) {
      expect(tokenizedHunks).not.toContain(marker);
    }
  });
});
