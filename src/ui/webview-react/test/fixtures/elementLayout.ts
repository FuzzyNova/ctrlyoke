import { afterAll, beforeAll } from "vitest";

/** Per-element box sizes for a jsdom layout stub; an omitted axis keeps jsdom's 0. */
export interface ElementLayoutStub {
  height?: (element: HTMLElement) => number;
  width?: (element: HTMLElement) => number;
}

type LayoutProperty =
  "offsetHeight" | "clientHeight" | "offsetWidth" | "clientWidth";

/**
 * jsdom performs no layout, so every box measures 0. Stubs both the offset and
 * client dimensions with the same value: jsdom draws no borders or scrollbars,
 * and libraries differ on which one they read (TanStack Virtual measures its
 * scroll viewport from `clientHeight`, its rows from `offsetHeight`).
 *
 * Returns a function that restores the original properties.
 */
export function installElementLayout(stub: ElementLayoutStub): () => void {
  const restorers: Array<() => void> = [];
  const define = (
    property: LayoutProperty,
    size: (element: HTMLElement) => number
  ) => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      property
    );
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        return size(this);
      },
    });
    restorers.push(() => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, property, original);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, property);
      }
    });
  };

  if (stub.height) {
    define("offsetHeight", stub.height);
    define("clientHeight", stub.height);
  }
  if (stub.width) {
    define("offsetWidth", stub.width);
    define("clientWidth", stub.width);
  }
  return () => {
    for (const restore of restorers.reverse()) restore();
  };
}

/** Installs {@link installElementLayout} for every test in the calling file. */
export function stubElementLayoutForFile(stub: ElementLayoutStub): void {
  let restore: (() => void) | undefined;
  beforeAll(() => {
    restore = installElementLayout(stub);
  });
  afterAll(() => restore?.());
}
