/**
 * The VS Code extension's `vscode:uninstall` hook (package.json `scripts`).
 *
 * VS Code runs it once, as a plain Node process with no `vscode` API, after
 * the extension is fully uninstalled. That happens on the next VS Code start,
 * from the extension folder, before VS Code deletes it. Updates do not run
 * it. It hands each harness's statusline back to the user unless another
 * ctrlyoke installation, such as the npm CLI, still uses it
 * (`PackageUninstall.ts`).
 *
 * VS Code shows nothing this prints and may kill a slow hook, so this stays
 * small and never throws.
 */

import * as path from "path";
import { configService } from "./config/CtrlYokeConfigService";
import { createUserConfigBackend } from "./config/FileConfigBackend";
import { uninstallPackageIntegration } from "./core/harness/shared/PackageUninstall";

configService.setUserBackend(createUserConfigBackend());

// Bundled to out/vscode-uninstall.js, so the package root is one level up.
uninstallPackageIntegration(path.resolve(__dirname, "..")).catch(
  () => undefined
);
