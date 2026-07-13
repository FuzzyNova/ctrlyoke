import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import { CliProviderUtils } from "../../core/harness/shared/CliProviderUtils";

suite("CliProviderUtils", () => {
  setup(() => {
    configService.setCliOverlay({ permissions: { allowedDirs: [] } });
  });

  teardown(() => {
    configService.setCliOverlay({});
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
});
