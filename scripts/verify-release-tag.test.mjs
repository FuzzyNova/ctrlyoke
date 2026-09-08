import assert from "node:assert/strict";
import test from "node:test";

import {
  extractChangelogSection,
  versionFromTag,
} from "./verify-release-tag.mjs";

test("versionFromTag strips a leading v", () => {
  assert.equal(versionFromTag("v0.1.0"), "0.1.0");
  assert.equal(versionFromTag("0.1.0"), "0.1.0");
});

const CHANGELOG_FIXTURE = `# Changelog

## [Unreleased]

### Changed

- Something not yet released.

## [0.2.0] - 2026-09-01

### Added

- New thing.
- Another new thing.

## [0.1.0] - 2026-05-12

Initial release.

### Added

- First thing.
`;

test("extractChangelogSection returns the body between two headings", () => {
  const section = extractChangelogSection(CHANGELOG_FIXTURE, "0.2.0");
  assert.equal(
    section,
    "### Added\n\n- New thing.\n- Another new thing.\n"
  );
});

test("extractChangelogSection returns everything to end-of-file for the oldest entry", () => {
  const section = extractChangelogSection(CHANGELOG_FIXTURE, "0.1.0");
  assert.equal(section, "Initial release.\n\n### Added\n\n- First thing.\n");
});

test("extractChangelogSection returns null when the version heading is missing", () => {
  assert.equal(extractChangelogSection(CHANGELOG_FIXTURE, "9.9.9"), null);
});

test("extractChangelogSection treats the version as a literal string, not a regex", () => {
  const changelog = "## [1.0.0] - 2026-01-01\n\nbody\n";
  assert.equal(extractChangelogSection(changelog, "1x0x0"), null);
});
