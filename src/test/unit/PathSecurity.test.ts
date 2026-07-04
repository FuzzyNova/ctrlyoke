import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import {
  isPathWithinDirectory,
  isPathWithinAnyDirectory,
} from "../../utils/PathSecurity";

suite("PathSecurity", () => {
  suite("isPathWithinDirectory", () => {
    test("accepts the directory itself and descendants", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(isPathWithinDirectory(dir, dir), true);
      assert.strictEqual(
        isPathWithinDirectory(path.join(dir, "src", "a.ts"), dir),
        true
      );
    });

    test("rejects a sibling-prefix path (CVE-style bypass)", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      const sibling = path.join("C:", "dev", "ctrlyoke-evil", "payload.ps1");
      assert.strictEqual(isPathWithinDirectory(sibling, dir), false);
    });

    test("rejects the parent directory", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(isPathWithinDirectory(path.join("C:", "dev"), dir), false);
    });
  });

  suite("isPathWithinAnyDirectory", () => {
    const frontend = path.resolve("/repos/frontend");
    const backend = path.resolve("/other/backend");

    test("accepts a path under any of several trusted roots", () => {
      assert.strictEqual(
        isPathWithinAnyDirectory(
          path.join(frontend, "src", "a.ts"),
          [frontend, backend]
        ),
        true
      );
      assert.strictEqual(
        isPathWithinAnyDirectory(
          path.join(backend, "src", "b.ts"),
          [frontend, backend]
        ),
        true
      );
    });

    test("rejects a path outside every trusted root", () => {
      const outside = path.resolve("/elsewhere/secret.txt");
      assert.strictEqual(
        isPathWithinAnyDirectory(outside, [frontend, backend]),
        false
      );
    });

    test("rejects a sibling-prefix path against every trusted root", () => {
      const sibling = path.resolve("/repos/frontend-evil/payload.sh");
      assert.strictEqual(
        isPathWithinAnyDirectory(sibling, [frontend, backend]),
        false
      );
    });

    test("returns false for an empty trusted-roots list", () => {
      assert.strictEqual(
        isPathWithinAnyDirectory(path.join(frontend, "a.ts"), []),
        false
      );
    });
  });
});
