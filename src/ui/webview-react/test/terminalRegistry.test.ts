import { afterEach, describe, expect, it, vi } from "vitest";

let terminalConstructCount = 0;

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    element: HTMLElement | undefined;
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;

    constructor(options: Record<string, unknown>) {
      terminalConstructCount += 1;
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
