import * as assert from "assert";
import * as path from "path";
import {
  firstViewerSegment,
  stripViewerPrefix,
  joinViewerPath,
  rootForViewerPath,
  toViewerPath,
  fromViewerPath,
  type ViewerRootContext,
} from "../../platform/WorkspaceViewerPath";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";

/**
 * Pure-function tests for the folder-name-prefixed viewer-path convention.
 * `toViewerPath` and `fromViewerPath` are asserted as exact inverses so the
 * single-sourced hosted-SCM and snapshot layers stay in agreement.
 */
suite("WorkspaceViewerPath Tests", () => {
  const primary = path.resolve("/ws/primary");
  const secondary = path.resolve("/ws/secondary");

  const singleRoot: ViewerRootContext = {
    primaryRoot: primary,
    namedRoots: [],
  };
  const multiRoots: ResolverWorkspaceFolder[] = [
    { name: "primary", fsPath: primary },
    { name: "secondary", fsPath: secondary },
  ];
  const multiRoot: ViewerRootContext = {
    primaryRoot: primary,
    namedRoots: multiRoots,
  };

  suite("string primitives", () => {
    test("firstViewerSegment returns the segment before the first slash", () => {
      assert.strictEqual(firstViewerSegment("secondary/src/x.ts"), "secondary");
      assert.strictEqual(firstViewerSegment("secondary"), "secondary");
      assert.strictEqual(firstViewerSegment("a\\b\\c"), "a");
      assert.strictEqual(firstViewerSegment(""), "");
    });

    test("stripViewerPrefix removes a known prefix, else returns unchanged", () => {
      assert.strictEqual(
        stripViewerPrefix("root/src/x.ts", "root"),
        "src/x.ts"
      );
      assert.strictEqual(stripViewerPrefix("root", "root"), "");
      assert.strictEqual(stripViewerPrefix("other/x.ts", "root"), "other/x.ts");
      assert.strictEqual(stripViewerPrefix("root/x.ts", ""), "root/x.ts");
      // A prefix that is only a string-prefix of the segment must not match.
      assert.strictEqual(
        stripViewerPrefix("rootish/x.ts", "root"),
        "rootish/x.ts"
      );
    });

    test("joinViewerPath composes prefix and remainder", () => {
      assert.strictEqual(joinViewerPath("root", "src/x.ts"), "root/src/x.ts");
      assert.strictEqual(joinViewerPath("root", ""), "root");
      assert.strictEqual(joinViewerPath("", "src/x.ts"), "src/x.ts");
      assert.strictEqual(joinViewerPath("", ""), "");
    });

    test("stripViewerPrefix and joinViewerPath round-trip", () => {
      const viewer = "secondary/lib/util.ts";
      const rest = stripViewerPrefix(viewer, "secondary");
      assert.strictEqual(joinViewerPath("secondary", rest), viewer);
    });
  });

  suite("rootForViewerPath", () => {
    test("matches the first segment to a named root", () => {
      assert.strictEqual(
        rootForViewerPath("secondary/a.ts", multiRoots)?.name,
        "secondary"
      );
      assert.strictEqual(
        rootForViewerPath("primary/a.ts", multiRoots)?.name,
        "primary"
      );
    });

    test("returns undefined for an unprefixed / unknown path", () => {
      assert.strictEqual(rootForViewerPath("a.ts", multiRoots), undefined);
      assert.strictEqual(rootForViewerPath("nope/a.ts", multiRoots), undefined);
    });
  });

  suite("single-root conversions", () => {
    test("toViewerPath yields a plain workspace-relative path", () => {
      const abs = path.join(primary, "src", "index.ts");
      assert.strictEqual(toViewerPath(abs, singleRoot), "src/index.ts");
    });

    test("fromViewerPath resolves against the primary root", () => {
      assert.strictEqual(
        fromViewerPath("src/index.ts", singleRoot),
        path.join(primary, "src", "index.ts")
      );
    });

    test("round-trips absolute → viewer → absolute", () => {
      const abs = path.join(primary, "a", "b.ts");
      assert.strictEqual(
        fromViewerPath(toViewerPath(abs, singleRoot), singleRoot),
        abs
      );
    });
  });

  suite("multi-root conversions", () => {
    test("toViewerPath prefixes with the owning root's folder name", () => {
      assert.strictEqual(
        toViewerPath(path.join(secondary, "src", "x.ts"), multiRoot),
        "secondary/src/x.ts"
      );
      assert.strictEqual(
        toViewerPath(path.join(primary, "y.ts"), multiRoot),
        "primary/y.ts"
      );
    });

    test("toViewerPath of a root's own toplevel is the bare folder name", () => {
      assert.strictEqual(toViewerPath(secondary, multiRoot), "secondary");
    });

    test("fromViewerPath resolves a prefixed path against the matching root", () => {
      assert.strictEqual(
        fromViewerPath("secondary/src/x.ts", multiRoot),
        path.join(secondary, "src", "x.ts")
      );
    });

    test("fromViewerPath resolves a bare root name to that root's toplevel", () => {
      assert.strictEqual(fromViewerPath("secondary", multiRoot), secondary);
    });

    test("round-trips absolute → viewer → absolute for each root", () => {
      for (const abs of [
        path.join(primary, "a.ts"),
        path.join(secondary, "deep", "b.ts"),
        secondary,
      ]) {
        assert.strictEqual(
          fromViewerPath(toViewerPath(abs, multiRoot), multiRoot),
          abs
        );
      }
    });
  });
});
