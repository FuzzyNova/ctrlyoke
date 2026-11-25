# Community template installs re-serialize the file and drop the author's comments

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, confirmed by probe against `out/`)
- **Area:** `src/core/TemplateManager.ts`
- **Resolution:** fixed in this commit

## Symptom

Installing a community template whose YAML contains comments (for example
`# Author comment: keep this`) writes a file with the comments removed and the
quoting and layout normalized. The same happens to a user's existing legacy
install when it is marked as a community install.

## Steps to Reproduce

1. Call `installTemplateContent(name, scope, "yaml", content, "<name>.ctrlyoke.yaml")`
   with content that starts with a comment line — this is what
   `CommunityTemplateService.handleInstall` always does.
2. Read the installed file: the comment is gone.

## Root Cause

`installTemplateContent` (`src/core/TemplateManager.ts:941-985`) documents
that the content "is then written byte for byte, so the author's comments and
layout survive". Since b99a0b8c8, whenever `communityInstallFile` is passed
(lines 972-978) it sets the marker on the parsed object and replaces `content`
with `serializeTemplate(parsed, format)`, i.e. a `js-yaml` dump.
`markLegacyCommunityInstall` (`TemplateManager.ts:~1068-1077`) re-serializes
the same way. The unit test "writes valid content verbatim"
(`src/test/unit/TemplateManager.test.ts:~796`) passes no marker, so it covers
only a path production never takes.

## Suggested Fix

Insert the marker without re-serializing YAML: use a comment-preserving YAML
document API (the `yaml` package's `parseDocument`, if it is already a
dependency) or splice a `communityInstallFile: <file>` line into the
top-level `_templateMeta` block mapping, matching its indentation; fall back to
re-serializing only when `_templateMeta` is a flow mapping or cannot be
located. JSON may keep re-serializing. Add tests that pass `communityInstallFile`
and assert a comment and the author's key order survive, and that the marker
is still read back by `parseTemplateMeta`.
