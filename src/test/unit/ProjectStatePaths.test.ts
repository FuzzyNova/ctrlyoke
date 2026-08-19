import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  ctrlyokeStateHome,
  projectKey,
  projectStateRoot,
} from "../../utils/ProjectStatePaths";
import { RUN_HISTORY_LOCATIONS } from "../../types/DashboardConstants";

suite("ProjectStatePaths", () => {
  test("folds Windows drive-letter casing into one deterministic key", () => {
    if (process.platform !== "win32") return;

    assert.strictEqual(projectKey("C:\\dev\\x"), projectKey("c:/dev/x"));
  });

  test("sanitizes and caps the readable project slug", () => {
    const stateRoot = path.join(os.tmpdir(), "My Project_É-" + "x".repeat(60));
    const key = projectKey(stateRoot);
    const hash12 = key.slice(-12);
    const slug = key.slice(0, -(hash12.length + 1));

    assert.strictEqual(slug, `my-project-e-${"x".repeat(35)}`);
    assert.ok(slug.length <= 48);
    assert.match(slug, /^[a-z0-9-]+$/);
  });

  test("uses project when the resolved state root has no basename", () => {
    const root = path.parse(path.resolve()).root;
    assert.match(projectKey(root), /^project-[0-9a-f]{12}$/);
  });

  test("does not collide for a hyphenated sibling directory", () => {
    assert.notStrictEqual(
      projectKey("C:\\dev\\ctrlyoke"),
      projectKey("C:\\dev-ctrlyoke")
    );
  });

  test("uses the CTRLYOKE_HOME override from the extension-test bootstrap", () => {
    assert.ok(process.env.CTRLYOKE_HOME);
    assert.strictEqual(
      ctrlyokeStateHome(),
      path.resolve(process.env.CTRLYOKE_HOME!)
    );
  });

  test("preserves the workspace layout and derives the user project root", () => {
    const stateRoot = path.join(os.tmpdir(), "ctrlyoke-state-root");

    assert.strictEqual(
      projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.WORKSPACE),
      path.join(stateRoot, ".ctrlyoke")
    );
    assert.strictEqual(
      projectStateRoot(stateRoot, RUN_HISTORY_LOCATIONS.USER),
      path.join(ctrlyokeStateHome(), "projects", projectKey(stateRoot))
    );
  });
});
