import * as assert from "assert";
import { suite, test } from "mocha";
import {
  formatServerBanner,
  installServerShutdown,
  resolveServerSettings,
  type ServerSignalSource,
} from "../../cli/ServerCommand";
import { resolveServerToken } from "../../platform/ServerTokenStore";

const settings = {
  autoStart: false,
  port: 4747,
  fallbackPorts: [4748],
  bindAddress: "127.0.0.1",
  theme: "dark" as const,
  tls: { enabled: false, certPath: "saved-cert", keyPath: "saved-key" },
  iconBgColor: "#000000",
  iconFgColor: "#ffffff",
};

suite("ServerCommand", () => {
  test("resolves command flags over server settings and keeps setting defaults", () => {
    const resolved = resolveServerSettings(
      {
        cwd: "workspace",
        port: "5010",
        bind: "0.0.0.0",
        https: true,
        theme: "light",
      },
      "C:/repo",
      settings
    );
    assert.strictEqual(resolved.cwd, require("path").resolve("workspace"));
    assert.strictEqual(resolved.port, 5010);
    assert.strictEqual(resolved.bindAddress, "0.0.0.0");
    assert.strictEqual(resolved.https, true);
    assert.strictEqual(resolved.theme, "light");
    assert.deepStrictEqual(resolved.fallbackPorts, [4748]);
    assert.strictEqual(
      resolveServerSettings({ strictPort: true }, "C:/repo", settings)
        .fallbackPorts.length,
      0
    );
  });

  test("environment token takes precedence over persisted token", () => {
    assert.strictEqual(
      resolveServerToken("env-secret", "saved-secret"),
      "env-secret"
    );
    assert.strictEqual(
      resolveServerToken(undefined, "saved-secret"),
      "saved-secret"
    );
  });

  test("formats a plain redirected banner and a TTY hyperlink", () => {
    const plain = formatServerBanner(
      "http://localhost:4747/?token=secret",
      [],
      false,
      "QR",
      false
    );
    assert.ok(plain.includes("http://localhost:4747/?token=secret"));
    assert.ok(!plain.includes("\u001b]8;"));
    const tty = formatServerBanner(
      "https://localhost:4747/?token=secret",
      ["192.168.1.4"],
      true,
      "QR",
      true
    );
    assert.ok(
      tty.includes("\u001b]8;;https://localhost:4747/?token=secret\u001b\\")
    );
    assert.ok(tty.includes("https://192.168.1.4:4747/?token=secret"));
    assert.ok(tty.includes("/cert"));
  });

  test("disposes on the first signal and forces exit on a second signal", async () => {
    const handlers = new Map<string, () => void>();
    const signals: ServerSignalSource = {
      on: (signal, listener) => handlers.set(signal, listener),
      off: (signal) => handlers.delete(signal),
    };
    let disposed = 0;
    const exits: number[] = [];
    installServerShutdown(
      {
        dispose: async () => {
          disposed += 1;
        },
      },
      signals,
      (code) => exits.push(code)
    );
    handlers.get("SIGINT")?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(disposed, 1);
    assert.deepStrictEqual(exits, [0]);
    handlers.get("SIGINT")?.();
    assert.deepStrictEqual(exits, [0, 0]);
  });
});
