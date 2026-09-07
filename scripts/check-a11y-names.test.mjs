import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findA11yNameViolations } from "./check-a11y-names.mjs";

async function withFixture(source, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-a11y-"));
  try {
    await fs.writeFile(path.join(root, "Fixture.tsx"), source);
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("detects unnamed Icon-only native and role buttons", async () => {
  await withFixture(
    `
      const Icon = () => null;
      export const Fixture = () => (
        <>
          <button title="Only a tooltip"><Icon /></button>
          <div role="button"><i className="codicon codicon-add" /></div>
        </>
      );
    `,
    async (root) => {
      assert.deepEqual(findA11yNameViolations({ srcRoot: root }), [
        { location: "Fixture.tsx:5", element: "button" },
        { location: "Fixture.tsx:6", element: 'role="button"' },
      ]);
    }
  );
});

test("accepts named icon buttons and buttons with text", async () => {
  await withFixture(
    `
      const Icon = () => null;
      export const Fixture = () => (
        <>
          <button aria-label="Add"><Icon /></button>
          <button aria-labelledby="add-label"><Icon /></button>
          <button><Icon />Add</button>
          <div role="button" aria-label="Close"><Icon /></div>
          <button><span>Text</span></button>
        </>
      );
    `,
    async (root) => {
      assert.deepEqual(findA11yNameViolations({ srcRoot: root }), []);
    }
  );
});

test("excludes test files from the source guard", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-a11y-"));
  try {
    await fs.mkdir(path.join(root, "test"));
    await fs.writeFile(
      path.join(root, "test", "Fixture.test.tsx"),
      "<button><Icon /></button>"
    );
    assert.deepEqual(findA11yNameViolations({ srcRoot: root }), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
