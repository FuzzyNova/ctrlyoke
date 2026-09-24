import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { getCodexHomeDir } from "../../utils/CodexHome";
import { getCodexUserMcpConfigPath } from "../../utils/McpConfigPaths";

suite("McpConfigPaths", () => {
  suite("Codex home", () => {
    let previousCodexHome: string | undefined;

    setup(() => {
      previousCodexHome = process.env.CODEX_HOME;
    });

    teardown(() => {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    });

    test("honours CODEX_HOME for the home and the user config", () => {
      const home = path.join(os.tmpdir(), "custom-codex-home");
      process.env.CODEX_HOME = `  ${home}  `;

      assert.strictEqual(getCodexHomeDir(), home);
      assert.strictEqual(
        getCodexUserMcpConfigPath(),
        path.join(home, "config.toml")
      );
    });

    test("falls back to ~/.codex when CODEX_HOME is unset or blank", () => {
      process.env.CODEX_HOME = "   ";
      const blank = getCodexHomeDir();
      delete process.env.CODEX_HOME;
      const unset = getCodexHomeDir();

      assert.strictEqual(path.basename(unset), ".codex");
      assert.strictEqual(blank, unset);
    });
  });
});
