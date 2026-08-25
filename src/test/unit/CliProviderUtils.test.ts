import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import {
  CliProviderUtils,
  RetryableAsyncCache,
} from "../../core/harness/shared/CliProviderUtils";
import { canonicalizeDriveLetter } from "../../utils/PathCasing";

suite("CliProviderUtils", () => {
  setup(() => {
    configService.setCliOverlay({});
  });

  teardown(() => {
    configService.setCliOverlay({});
    configService.setUserBackend({ getAll: () => ({}), set: async () => {} });
  });

  test("includes every workspace-folder root exactly once for --add-dir", () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const secondaryRoot = path.join(
      os.tmpdir(),
      "ctrlyoke-workspace-secondary"
    );

    const result = CliProviderUtils.getWorkspaceDirs(primaryRoot, [
      primaryRoot,
      secondaryRoot,
      secondaryRoot,
    ]);

    assert.deepStrictEqual(result, [
      path.resolve(primaryRoot),
      path.resolve(secondaryRoot),
    ]);
  });

  test("appends every effective approved external root after workspace roots", () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const externalRoot = path.join(os.tmpdir(), "ctrlyoke-external-root");
    // User-scope allowedExternalFileRoots is trusted immediately (no
    // trust-store decision needed) — read via getScoped(..., "user"), which
    // only sees the user/workspace backends, not the CLI overlay.
    configService.setUserBackend({
      getAll: () => ({
        permissions: { allowedExternalFileRoots: [externalRoot] },
      }),
      set: async () => {},
    });

    const result = CliProviderUtils.getWorkspaceDirs(primaryRoot, []);

    assert.deepStrictEqual(result, [
      path.resolve(primaryRoot),
      path.resolve(externalRoot),
    ]);
  });

  test("canonicalizes a lowercase drive letter for --add-dir on Windows", function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const root = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const lowerRoot = root.charAt(0).toLowerCase() + root.slice(1);
    const expected = canonicalizeDriveLetter(path.resolve(root));

    const result = CliProviderUtils.getWorkspaceDirs(lowerRoot, []);

    assert.deepStrictEqual(result, [expected]);
  });

  test("dedups a directory regardless of drive-letter casing", function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const root = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const lowerRoot = root.charAt(0).toLowerCase() + root.slice(1);
    const expected = canonicalizeDriveLetter(path.resolve(root));

    const result = CliProviderUtils.getWorkspaceDirs(root, [lowerRoot]);

    assert.deepStrictEqual(result, [expected]);
  });

  test("shares successful probes and retries a failed probe", async () => {
    const cache = new RetryableAsyncCache<string>();
    let calls = 0;

    const result = await Promise.all([
      cache.getOrRun("test --version", async () => {
        calls += 1;
        return "1.0.0";
      }),
      cache.getOrRun("test --version", async () => {
        calls += 1;
        return "1.0.0";
      }),
    ]);

    assert.deepStrictEqual(result, ["1.0.0", "1.0.0"]);
    assert.strictEqual(calls, 1);

    await assert.rejects(
      cache.getOrRun("missing --version", async () => {
        calls += 1;
        throw new Error("not installed");
      }),
      /not installed/u
    );
    const retryResult = await cache.getOrRun("missing --version", async () => {
      calls += 1;
      return "1.0.0";
    });

    assert.strictEqual(retryResult, "1.0.0");
    assert.strictEqual(calls, 3);
  });

  test("runs and caches help output while retrying failed help commands", async () => {
    const [firstResult, coalescedResult] = await Promise.all([
      CliProviderUtils.runHelpCommand("node --help"),
      CliProviderUtils.runHelpCommand("node --help"),
    ]);

    assert.match(firstResult, /Usage: node/u);
    assert.strictEqual(coalescedResult, firstResult);

    const missingCommand = `ctrlyoke-missing-help-${Date.now()} --help`;
    await assert.rejects(
      CliProviderUtils.runHelpCommand(missingCommand),
      /not found|cannot find|ENOENT|resolve/u
    );
    await assert.rejects(
      CliProviderUtils.runHelpCommand(missingCommand),
      /not found|cannot find|ENOENT|resolve/u
    );
  });

  test("keeps provider-specific references in settings MCP env and headers", () => {
    const entries = CliProviderUtils.buildSettingsJsonMcpEntries(
      undefined,
      "/workspace",
      undefined,
      undefined,
      [
        {
          id: "api",
          command: "node",
          env: { API_TOKEN: "${secret:API_TOKEN}" },
        },
        {
          id: "remote",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${secret:API_TOKEN}" },
        },
      ],
      undefined,
      undefined,
      CliProviderUtils.createMcpSecretConfigOptions((name) => `{env:${name}}`)
    );

    assert.strictEqual(
      (entries.api as { env: Record<string, string> }).env.API_TOKEN,
      "{env:API_TOKEN}"
    );
    assert.strictEqual(
      (entries.remote as { headers: Record<string, string> }).headers
        .Authorization,
      "Bearer {env:API_TOKEN}"
    );
  });

  test("creates a restrictive substitution strategy for non-expanding providers", () => {
    const options = CliProviderUtils.createMcpSecretConfigOptions(undefined, {
      API_TOKEN: "secret-value",
    });
    assert.deepStrictEqual(options, {
      mode: "substitute",
      resolvedValues: { API_TOKEN: "secret-value" },
      restrictivePermissions: true,
    });
  });
});
