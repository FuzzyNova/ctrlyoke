import * as fs from "fs/promises";
import * as path from "path";
import {
  packageStatuslineDirectory,
  STATUSLINE_LAUNCHER_FILES,
} from "../../core/harness/shared/StatuslineLauncher";

/**
 * Create a package root at `root` containing every statusline script.
 *
 * Statusline registration refuses to point harness config at a script that
 * does not exist, so a test that expects an install needs a real package
 * root, not a placeholder path. With `version`, a `package.json` is written
 * and the scripts deploy to the (test-isolated) `~/.ctrlyoke/bin` launcher;
 * without it the launcher cannot deploy and the package's own copy is used.
 */
export async function writeStatuslinePackage(
  root: string,
  options: { version?: string; contents?: string } = {}
): Promise<string> {
  const scripts = packageStatuslineDirectory(root);
  await fs.mkdir(scripts, { recursive: true });
  if (options.version !== undefined) {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ version: options.version }),
      "utf8"
    );
  }
  for (const file of STATUSLINE_LAUNCHER_FILES) {
    await fs.writeFile(
      path.join(scripts, file),
      options.contents ?? "// script",
      "utf8"
    );
  }
  return root;
}
