import * as assert from "assert";
import { promisify } from "util";
const childProcess = require("child_process") as {
  exec: typeof import("child_process").exec;
};

type ExecCallback = (
  error: (Error & { code?: number | string | null; killed?: boolean; stdout?: string }) | null,
  stdout: string,
  stderr: string
) => void;

suite("ModelRegistry discovery", () => {
  const originalExec = childProcess.exec;

  teardown(() => {
    childProcess.exec = originalExec;
  });

  function loadRegistry(
    run: (command: string, callback: ExecCallback) => void
  ): typeof import("../utils/ModelRegistry") {
    const fakeExec = ((command: string, _options: unknown, callback: ExecCallback) => {
      run(command, callback);
      return {} as import("child_process").ChildProcess;
    }) as typeof childProcess.exec;
    Object.defineProperty(fakeExec, promisify.custom, {
      value: (command: string) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          run(command, (error, stdout, stderr) => {
            if (error) {
              Object.assign(error, { stdout, stderr });
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          });
        }),
    });
    childProcess.exec = fakeExec;
    const registryPath = require.resolve("../utils/ModelRegistry");
    delete require.cache[registryPath];
    return require(registryPath) as typeof import("../utils/ModelRegistry");
  }

  test("background-retries Copilot discovery after one initialization times out", async () => {
    let copilotCalls = 0;
    const registry = loadRegistry((command, callback) => {
      if (command.includes("copilot help config")) {
        copilotCalls++;
        if (copilotCalls === 1) {
          const timeout = Object.assign(new Error("timed out"), {
            killed: true,
            signal: "SIGTERM",
            code: null,
          });
          callback(timeout, "", "");
        } else {
          callback(
            null,
            '  `model`: AI model to use for Copilot CLI\n    - "copilot-new-model"\n',
            ""
          );
        }
        return;
      }
      if (command === "opencode --version") {
        callback(Object.assign(new Error("absent"), { code: "ENOENT" }), "", "");
        return;
      }
      callback(Object.assign(new Error("absent"), { code: "ENOENT" }), "", "");
    });

    const originalSetTimeout = global.setTimeout;
    let retryCallback: (() => void) | undefined;
    let retryWasUnrefed = false;
    global.setTimeout = ((callback: () => void) => {
      retryCallback = callback;
      return {
        unref: () => {
          retryWasUnrefed = true;
        },
      } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    try {
      await registry.initializeModelRegistry();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
    assert.strictEqual(registry.isRegistryInitialized(), true);
    assert.strictEqual(retryWasUnrefed, true);
    assert.ok(registry.getCliSupportedModelIdsSync().length > 0);
    assert.strictEqual(registry.getCliSupportedModelIdsSync().includes("copilot-new-model"), false);
    assert.ok(retryCallback);
    retryCallback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(copilotCalls, 2);
    assert.strictEqual(
      registry.getCliSupportedModelIdsSync().includes("copilot-new-model"),
      true
    );
  });

  test("does not parse OpenCode output after timeout or maxBuffer overflow", async () => {
    for (const failure of [
      Object.assign(new Error("timed out"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
        stdout: "partial/timeout-model",
      }),
      Object.assign(new Error("buffer exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        stdout: "partial/buffer-model",
      }),
    ]) {
      const registry = loadRegistry((command, callback) => {
        if (command === "opencode --version") {
          callback(null, "1.0.0", "");
        } else if (command === "opencode models --verbose") {
          callback(failure, failure.stdout ?? "", "");
        } else {
          callback(Object.assign(new Error("absent"), { code: "ENOENT" }), "", "");
        }
      });
      await registry.initializeModelRegistry();
      assert.strictEqual(
        registry.getOpenCodeModelIdsSync().includes(failure.stdout!.split("/")[1]),
        false
      );
    }
  });

  test("parses stdout from a genuine OpenCode non-zero exit", async () => {
    const registry = loadRegistry((command, callback) => {
      if (command === "opencode --version") {
        callback(null, "1.0.0", "");
      } else if (command === "opencode models --verbose") {
        const failure = Object.assign(new Error("exit 1"), {
          code: 1,
          stdout: "opencode/recovered-model\n{\n  \"limit\": { \"context\": 8192 }\n}\n",
        });
        callback(failure, failure.stdout, "");
      } else {
        callback(Object.assign(new Error("absent"), { code: "ENOENT" }), "", "");
      }
    });

    await registry.initializeModelRegistry();
    assert.deepStrictEqual(registry.getOpenCodeModelIdsSync(), ["opencode/recovered-model"]);
  });
});
