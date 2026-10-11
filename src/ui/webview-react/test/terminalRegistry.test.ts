import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon, ITerminalDimensions } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";

let terminalConstructCount = 0;

vi.mock("@xterm/xterm", () => {
  class MockTerminal implements Pick<
    Terminal,
    | "loadAddon"
    | "open"
    | "resize"
    | "write"
    | "scrollLines"
    | "refresh"
    | "onData"
  > {
    element: HTMLElement | undefined;
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    writes: string[] = [];

    constructor(options: Record<string, unknown>) {
      terminalConstructCount += 1;
      this.options = options;
    }

    loadAddon(_addon: Parameters<Terminal["loadAddon"]>[0]) {}

    open(element: HTMLElement) {
      this.element = element;
    }

    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }

    write(data: string) {
      this.writes.push(data);
    }

    scrollLines(_amount: number) {}

    refresh(_start: number, _end: number) {}

    onData(_listener: Parameters<Terminal["onData"]>[0]): IDisposable {
      return { dispose() {} };
    }

    dispose() {}
  }

  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon implements Pick<FitAddon, "fit" | "proposeDimensions"> {
    fit() {}

    proposeDimensions(): ITerminalDimensions {
      return { cols: 80, rows: 24 };
    }
  }

  return { FitAddon: MockFitAddon };
});

describe("terminalRegistry.attach", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    terminalConstructCount = 0;
    document.body.innerHTML = "";
  });

  it("attaches the terminal DOM immediately without waiting for WebGL", async () => {
    let resolveWebglImport: (() => void) | undefined;

    vi.doMock("@xterm/addon-webgl", () => {
      return new Promise((resolve) => {
        resolveWebglImport = () =>
          resolve({
            WebglAddon: class implements Pick<WebglAddon, "onContextLoss"> {
              onContextLoss = () => ({ dispose() {} });

              dispose() {}
            },
          });
      });
    });

    const { terminalRegistry } = await import("../terminalRegistry");
    const workflowId = "wf-terminal";
    const sessionId = "sess-terminal";
    const container = document.createElement("div");
    document.body.appendChild(container);

    const entry = await terminalRegistry.create(workflowId, sessionId);

    const attachStatus = await Promise.race([
      terminalRegistry.attach(workflowId, sessionId, container).then(() => {
        return "resolved";
      }),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("timed-out"), 50);
      }),
    ]);

    expect(attachStatus).toBe("resolved");
    expect(container.contains(entry.domEl)).toBe(true);

    resolveWebglImport?.();
  });

  it("deduplicates concurrent creates for the same terminal session", async () => {
    vi.doMock("@xterm/addon-webgl", () => {
      return new Promise(() => {});
    });

    const { terminalRegistry } = await import("../terminalRegistry");
    const workflowId = "wf-concurrent";
    const sessionId = "sess-concurrent";

    const [firstEntry, secondEntry] = await Promise.all([
      terminalRegistry.create(workflowId, sessionId),
      terminalRegistry.create(workflowId, sessionId),
    ]);

    expect(firstEntry).toBe(secondEntry);
    expect(terminalRegistry.get(workflowId, sessionId)).toBe(firstEntry);
    expect(terminalConstructCount).toBe(1);
  });
});

describe("terminalRegistry orphan output buffer", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    terminalConstructCount = 0;
    document.body.innerHTML = "";
  });

  it("flushes output buffered before create() into the new terminal, in order", async () => {
    const { terminalRegistry } = await import("../terminalRegistry");
    const workflowId = "wf-orphan";
    const sessionId = "sess-orphan";

    // No entry exists yet — the PTY's first chunks arrive before mount.
    expect(terminalRegistry.get(workflowId, sessionId)).toBeUndefined();
    terminalRegistry.bufferOrphanOutput(workflowId, sessionId, "first ");
    terminalRegistry.bufferOrphanOutput(workflowId, sessionId, "second");

    const entry = await terminalRegistry.create(workflowId, sessionId);

    expect((entry.term as unknown as { writes: string[] }).writes).toEqual([
      "first ",
      "second",
    ]);
  });

  it("does not replay buffered output on a second create() after the entry exists", async () => {
    const { terminalRegistry } = await import("../terminalRegistry");
    const workflowId = "wf-orphan-once";
    const sessionId = "sess-orphan-once";

    terminalRegistry.bufferOrphanOutput(workflowId, sessionId, "only-once");
    const entry = await terminalRegistry.create(workflowId, sessionId);
    const writes = (entry.term as unknown as { writes: string[] }).writes;
    expect(writes).toEqual(["only-once"]);

    // A subsequent create() returns the existing entry and must not re-flush.
    const again = await terminalRegistry.create(workflowId, sessionId);
    expect(again).toBe(entry);
    expect(writes).toEqual(["only-once"]);
  });

  it("drops buffered output when the session is cleared before create()", async () => {
    const { terminalRegistry } = await import("../terminalRegistry");
    const workflowId = "wf-orphan-clear";
    const sessionId = "sess-orphan-clear";

    terminalRegistry.bufferOrphanOutput(workflowId, sessionId, "stale");
    // Session disposed (e.g. run boundary) before it ever mounted — the stale
    // chunk must not survive to replay into a future entry and duplicate the
    // server reconnect-buffer replay.
    terminalRegistry.clearSession(workflowId, sessionId);

    const entry = await terminalRegistry.create(workflowId, sessionId);
    expect((entry.term as unknown as { writes: string[] }).writes).toEqual([]);
  });
});

describe("terminalRegistry font metric changes", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    terminalConstructCount = 0;
    document.body.innerHTML = "";
  });

  function giveSize(el: HTMLElement, width: number, height: number): void {
    Object.defineProperty(el, "offsetWidth", {
      configurable: true,
      get: () => width,
    });
    Object.defineProperty(el, "offsetHeight", {
      configurable: true,
      get: () => height,
    });
  }

  async function createRenderedEntry(
    terminalRegistry: typeof import("../terminalRegistry").terminalRegistry,
    workflowId: string,
    sessionId: string
  ) {
    const entry = await terminalRegistry.create(workflowId, sessionId);
    const container = document.createElement("div");
    document.body.appendChild(container);
    entry.term.open(entry.domEl);
    container.appendChild(entry.domEl);
    giveSize(entry.domEl, 640, 360);
    return entry;
  }

  it("refits rendered controllers, keeps a viewer on the controller's columns, and then notifies listeners", async () => {
    vi.doMock("@xterm/addon-webgl", () => new Promise(() => {}));
    const { terminalRegistry } = await import("../terminalRegistry");

    const controller = await createRenderedEntry(
      terminalRegistry,
      "wf-metrics",
      "sess-controller"
    );
    controller.term.resize(10, 5);

    const viewer = await createRenderedEntry(
      terminalRegistry,
      "wf-metrics",
      "sess-viewer"
    );
    viewer.controllerCols = 132;
    viewer.controllerRows = 40;

    const seenAtNotify: Array<{ controllerCols: number; fontSize: unknown }> =
      [];
    const unsubscribe = terminalRegistry.onMetricsChanged(() => {
      seenAtNotify.push({
        controllerCols: controller.term.cols,
        fontSize: controller.term.options.fontSize,
      });
    });

    terminalRegistry.updateFontSize(12);

    expect(controller.term.options.fontSize).toBe(12);
    expect(viewer.term.options.fontSize).toBe(12);
    // Controller refit to the fit addon's proposal before listeners run.
    expect(seenAtNotify).toEqual([{ controllerCols: 80, fontSize: 12 }]);
    // Viewer keeps the controller's grid instead of fitting its own columns.
    expect(viewer.term.cols).toBe(132);
    expect(viewer.term.rows).toBe(40);

    unsubscribe();
    terminalRegistry.updateFontSize(13);
    expect(seenAtNotify).toHaveLength(1);
  });

  it("skips detached entries when refitting after a metrics change", async () => {
    vi.doMock("@xterm/addon-webgl", () => new Promise(() => {}));
    const { terminalRegistry } = await import("../terminalRegistry");

    const detached = await terminalRegistry.create("wf-metrics", "sess-off");
    detached.term.open(detached.domEl);
    detached.term.resize(10, 5);
    const listener = vi.fn();
    terminalRegistry.onMetricsChanged(listener);

    terminalRegistry.updateFontSize(16);

    expect(detached.term.options.fontSize).toBe(16);
    expect(detached.term.cols).toBe(10);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("terminalRegistry viewport measurement", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    terminalConstructCount = 0;
    document.body.innerHTML = "";
  });

  it("measures an empty terminal container with the hidden probe terminal", async () => {
    const { terminalRegistry } = await import("../terminalRegistry");
    const container = document.createElement("div");
    Object.defineProperty(container, "offsetWidth", {
      configurable: true,
      get: () => 640,
    });
    Object.defineProperty(container, "offsetHeight", {
      configurable: true,
      get: () => 360,
    });
    document.body.appendChild(container);

    const fitResult = terminalRegistry.measureViewportContainer(container);

    expect(fitResult).toMatchObject({
      cols: 80,
      rows: 24,
      proposedCols: 80,
      proposedRows: 24,
      mode: "controller",
    });
    expect(container.children).toHaveLength(1);

    terminalRegistry.releaseViewportMeasurement();
    expect(container.children).toHaveLength(0);
  });
});
