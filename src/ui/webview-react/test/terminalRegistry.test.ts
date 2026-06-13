import { afterEach, describe, expect, it, vi } from "vitest";

let proposedDimensionsQueue: Array<{ cols: number; rows: number } | undefined> =
  [];

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    element: HTMLElement | undefined;
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    loadAddon() {}

    open(element: HTMLElement) {
      this.element = element;
    }

    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }

    write() {}

    scrollLines() {}

    refresh() {}

    onData() {
      return { dispose() {} };
    }

    dispose() {}
  }

  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit() {}

    proposeDimensions() {
      return proposedDimensionsQueue.length > 0
        ? proposedDimensionsQueue.shift()
        : { cols: 80, rows: 24 };
    }
  }

  return { FitAddon: MockFitAddon };
});

describe("terminalRegistry.attach", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    proposedDimensionsQueue = [];
    document.body.innerHTML = "";
  });

  it("attaches the terminal DOM immediately without waiting for WebGL", async () => {
    let resolveWebglImport: (() => void) | undefined;

    vi.doMock("@xterm/addon-webgl", () => {
      return new Promise((resolve) => {
        resolveWebglImport = () =>
          resolve({
            WebglAddon: class {
              onContextLoss() {}

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

  it("retries connected refits until dimensions become measurable again", async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    vi.doMock("@xterm/addon-webgl", () => {
      return new Promise(() => {});
    });

    proposedDimensionsQueue = [
      { cols: 153, rows: 15 },
      undefined,
      { cols: 153, rows: 15 },
    ];

    const { terminalRegistry } = await import("../terminalRegistry");
    const workflowId = "wf-webgl";
    const sessionId = "sess-webgl";
    const container = document.createElement("div");
    document.body.appendChild(container);

    const entry = await terminalRegistry.create(workflowId, sessionId);
    await terminalRegistry.attach(workflowId, sessionId, container);

    rafCallbacks.shift()?.(performance.now());
    expect(entry.term.cols).toBe(153);
    expect(entry.term.rows).toBe(15);

    entry.term.resize(80, 24);
    expect(
      terminalRegistry.scheduleFitSessionToContainer(
        workflowId,
        sessionId,
        "test-recovery"
      )
    ).toBe(true);

    rafCallbacks.shift()?.(performance.now());
    expect(entry.term.cols).toBe(80);
    expect(entry.term.rows).toBe(24);

    expect(rafCallbacks.length).toBeGreaterThan(0);
    rafCallbacks.shift()?.(performance.now());
    expect(entry.term.cols).toBe(153);
    expect(entry.term.rows).toBe(15);
  });
});
