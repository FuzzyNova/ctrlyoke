import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LEGAL_VERSIONS_FILE,
  archiveCurrentVersions,
  archivedVersionPath,
  findLegalArchiveProblems,
  hashLegalText,
  readLegalArchive,
} from "./legal-archive.mjs";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const licenseText = (version, body = "Terms.") =>
  `# License\n\n**Version:** ${version}\n\n${body}\n`;

/** A throwaway checkout with one document, LICENSE.md, archived at 1.0. */
function makeCheckout(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-legal-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const text = licenseText("1.0");
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(rootDir, relative)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(rootDir, relative), content);
  };
  write("LICENSE.md", text);
  write(archivedVersionPath("eula", "1.0"), text);
  write(
    LEGAL_VERSIONS_FILE,
    JSON.stringify({
      documents: [
        { id: "eula", file: "LICENSE.md", title: "License", route: "/terms/" },
      ],
      versions: [
        {
          document: "eula",
          version: "1.0",
          published: "2026-01-01",
          sha256: hashLegalText(text),
        },
      ],
    })
  );
  return { rootDir, write };
}

const problems = (rootDir) =>
  findLegalArchiveProblems(readLegalArchive(rootDir));

test("the repository's legal archive is consistent", () => {
  assert.deepEqual(problems(ROOT_DIR), []);
});

test("every published version the registry lists is served by the archive", () => {
  const { registry } = readLegalArchive(ROOT_DIR);
  for (const doc of registry.documents) {
    assert.ok(
      registry.versions.some((v) => v.document === doc.id),
      `${doc.id} has no archived version`
    );
  }
});

test("editing a root document without a version bump fails", (t) => {
  const { rootDir, write } = makeCheckout(t);
  write("LICENSE.md", licenseText("1.0", "Changed terms."));
  assert.match(
    problems(rootDir).join("\n"),
    /LICENSE\.md changed after version 1\.0/
  );
});

test("editing an archived version fails", (t) => {
  const { rootDir, write } = makeCheckout(t);
  write(archivedVersionPath("eula", "1.0"), licenseText("1.0", "Rewritten."));
  assert.match(
    problems(rootDir).join("\n"),
    /no longer matches the text published as eula@1\.0/
  );
});

test("a new version must be archived before the check passes", (t) => {
  const { rootDir, write } = makeCheckout(t);
  write("LICENSE.md", licenseText("1.1", "New terms."));
  assert.match(
    problems(rootDir).join("\n"),
    /version 1\.1, which is not archived/
  );

  assert.deepEqual(archiveCurrentVersions(rootDir, "2026-02-01"), ["eula@1.1"]);
  assert.deepEqual(problems(rootDir), []);
  assert.equal(
    fs.readFileSync(
      path.join(rootDir, archivedVersionPath("eula", "1.1")),
      "utf8"
    ),
    licenseText("1.1", "New terms.")
  );
  const { registry } = readLegalArchive(rootDir);
  assert.deepEqual(
    registry.versions.map((v) => [v.version, v.published]),
    [
      ["1.0", "2026-01-01"],
      ["1.1", "2026-02-01"],
    ]
  );
  // Re-running is a no-op and never rewrites a published version.
  assert.deepEqual(archiveCurrentVersions(rootDir, "2026-03-01"), []);
});

test("an archived file the registry does not list fails", (t) => {
  const { rootDir, write } = makeCheckout(t);
  write(archivedVersionPath("eula", "0.9"), licenseText("0.9"));
  assert.match(problems(rootDir).join("\n"), /eula\/0\.9\.md is not listed/);
});

test("line endings do not change a text's identity", (t) => {
  const { rootDir, write } = makeCheckout(t);
  write("LICENSE.md", licenseText("1.0").replace(/\n/g, "\r\n"));
  assert.deepEqual(problems(rootDir), []);
});
