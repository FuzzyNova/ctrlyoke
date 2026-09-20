import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import { buildDirectoryAttachmentXml } from "../utils/AttachmentBuilders";
import { makeTempDir, removeTempDir } from "./helpers/tempWorkspace";

suite("AttachmentBuilders.buildDirectoryAttachmentXml", () => {
  let workspaceRoot: string;
  let outsideDir: string;

  afterEach(() => {
    removeTempDir(workspaceRoot);
    removeTempDir(outsideDir);
  });

  test("builds a directory tree for an in-workspace @dir/ reference", async () => {
    workspaceRoot = makeTempDir("cy-attach-");
    fs.mkdirSync(path.join(workspaceRoot, "sub"));
    fs.writeFileSync(path.join(workspaceRoot, "sub", "a.ts"), "// a\n");

    const xml = await buildDirectoryAttachmentXml("sub/", workspaceRoot);

    assert.ok(xml.includes("a.ts"));
    assert.ok(!xml.includes("blocked"));
  });

  test("blocks a @dir/ reference that escapes the workspace via '..'", async () => {
    workspaceRoot = makeTempDir("cy-attach-");
    outsideDir = makeTempDir("cy-attach-outside-");
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n");
    const traversal = path.relative(workspaceRoot, outsideDir);

    const xml = await buildDirectoryAttachmentXml(
      `${traversal}/`,
      workspaceRoot,
      [],
      [],
      false,
      workspaceRoot
    );

    assert.ok(xml.includes("blocked"));
    assert.ok(!xml.includes("secret.txt"));
  });

  test("blocks an absolute directory path outside the workspace", async () => {
    workspaceRoot = makeTempDir("cy-attach-");
    outsideDir = makeTempDir("cy-attach-outside-");
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "TOP SECRET\n");

    const xml = await buildDirectoryAttachmentXml(
      `${outsideDir}/`,
      workspaceRoot
    );

    assert.ok(xml.includes("blocked"));
    assert.ok(!xml.includes("secret.txt"));
  });

  test("allows a directory reference into a second trusted root (multi-root workspace)", async () => {
    workspaceRoot = makeTempDir("cy-attach-");
    outsideDir = makeTempDir("cy-attach-second-");
    fs.mkdirSync(path.join(outsideDir, "sub"));
    fs.writeFileSync(path.join(outsideDir, "sub", "b.ts"), "// b\n");
    const relativeDir = path.relative(
      workspaceRoot,
      path.join(outsideDir, "sub")
    );

    // Without the second root trusted, the same reference is blocked.
    const untrusted = await buildDirectoryAttachmentXml(
      `${relativeDir}/`,
      workspaceRoot,
      [],
      [],
      false,
      workspaceRoot
    );
    assert.ok(untrusted.includes("blocked"));

    const trusted = await buildDirectoryAttachmentXml(
      `${relativeDir}/`,
      workspaceRoot,
      [workspaceRoot, outsideDir],
      [],
      false,
      workspaceRoot
    );
    assert.ok(trusted.includes("b.ts"));
    assert.ok(!trusted.includes("blocked"));
  });

  test("resolves a workflow-relative directory reference against the workflow file", async () => {
    workspaceRoot = makeTempDir("cy-attach-");
    const workflowDir = path.join(workspaceRoot, "bundles");
    const assetsDir = path.join(workflowDir, "workflow.assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "asset.ts"), "// asset\n");

    const xml = await buildDirectoryAttachmentXml(
      "./workflow.assets/",
      workspaceRoot,
      [],
      [],
      false,
      workflowDir
    );

    assert.ok(xml.includes("asset.ts"));
    assert.ok(!xml.includes("blocked"));
  });
});
