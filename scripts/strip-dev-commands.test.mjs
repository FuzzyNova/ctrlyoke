import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripDevCommands } from "./strip-dev-commands.mjs";

test("an existing package backup is never overwritten", (context) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-strip-test-"));
  context.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const packagePath = path.join(tempDir, "package.json");
  const backupPath = `${packagePath}.backup`;
  const currentPackage = JSON.stringify({ contributes: { commands: [] } });
  const originalBackup = "preserve this original backup\n";
  writeFileSync(packagePath, currentPackage);
  writeFileSync(backupPath, originalBackup);

  assert.throws(
    () => stripDevCommands({ packagePath, backup: backupPath }),
    /npm run restore-package/
  );
  assert.equal(readFileSync(packagePath, "utf8"), currentPackage);
  assert.equal(readFileSync(backupPath, "utf8"), originalBackup);
});
