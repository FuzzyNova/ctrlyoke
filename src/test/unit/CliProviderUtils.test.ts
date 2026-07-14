import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import { CliProviderUtils } from "../../core/harness/shared/CliProviderUtils";

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
});
