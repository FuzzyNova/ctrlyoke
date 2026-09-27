# Register ctrlyoke's Schemas in the SchemaStore Catalog

> **Status:** Backlog. Do this at or after the release cut, once `/schema/v1/` is live
> (`SCHEMA_RELEASE_READINESS_PLAN.md` §12 checklist).
>
> **Problem in one line:** editors other than VS Code with the ctrlyoke extension only validate
> ctrlyoke files when the file itself links a schema, and ctrlyoke deliberately no longer
> writes that link.

---

## 1. Background

`SCHEMA_RELEASE_READINESS_PLAN.md` §3 first had ctrlyoke's writers stamp `$schema` into
settings and JSON workflows, and a `# yaml-language-server: $schema=…` line into YAML. That
was reversed on 2026-09-27. An in-file schema link replaces the extension's bundled
`jsonValidation`/`yamlValidation` association instead of adding to it, so VS Code went to the
network. Offline, or before the site was deployed, that failed. Even once the site is live,
VS Code rejects the fetch as "untrusted" unless the user adds `ctrlyoke.dev` to
`json.schemaDownload.trustedDomains`. The link also pinned dev builds to the published schema.
The durable rule is in `config.instructions.md`.

The goal the links served is still worth having: a ctrlyoke file should validate in any
schema-aware editor, not only in VS Code with the extension installed. Examples are JetBrains
IDEs, Neovim/Helix/Zed through `yaml-language-server` or `vscode-json-languageservice`, and
VS Code for someone who only uses the npm CLI.

[SchemaStore](https://www.schemastore.org/) provides this without touching any file. Its
catalog (`https://www.schemastore.org/api/json/catalog.json`) maps file-name patterns to
schema URLs, and most JSON/YAML tooling reads it by default.

## 2. Catalog entries

Add two entries to `src/api/json/catalog.json` in `SchemaStore/schemastore`:

```jsonc
{
  "name": "ctrlyoke workflow",
  "description": "ctrlyoke AI coding-harness workflow definition",
  "fileMatch": ["*.ctrlyoke.json", "*.ctrlyoke.yaml", "*.ctrlyoke.yml"],
  "url": "https://ctrlyoke.dev/schema/v1/workflow.json",
  "versions": { "1": "https://ctrlyoke.dev/schema/v1/workflow.json" }
},
{
  "name": "ctrlyoke settings",
  "description": "ctrlyoke settings (~/.ctrlyoke/settings.json, .ctrlyoke/settings.json)",
  "fileMatch": ["**/.ctrlyoke/settings.json"],
  "url": "https://ctrlyoke.dev/schema/v1/settings.json",
  "versions": { "1": "https://ctrlyoke.dev/schema/v1/settings.json" }
}
```

- **`fileMatch` must stay as narrow as the extension's.** Copy the `package.json`
  `jsonValidation`/`yamlValidation` globs. Never use a bare `settings.json`: that would claim
  every settings file in the world.
- **`.prompt.md` is excluded.** Its schema applies only to the frontmatter, which catalog
  consumers can't validate.
- **`versions`** records each format version. When `/schema/v2/` ships (readiness plan §2.6),
  add a `"2"` entry and point `url` at v2. The v1 URL keeps working because `/v1/` is frozen.
- SchemaStore requires positive and negative test files for every schema it hosts. Check
  whether that also applies to entries that only point at an external `url`, and reuse
  `src/test/fixtures/formats/` if so.

## 3. Open questions to settle before submitting

1. **Hosted by us or copied into SchemaStore?** SchemaStore allows a catalog entry to point at
   an external URL, or can host a copy under `json.schemastore.org`. `json.schemastore.org`
   and `www.schemastore.org` are in VS Code's default `json.schemaDownload.trustedDomains`;
   `ctrlyoke.dev` is not. If VS Code applies the trust check to a catalog match, a
   `ctrlyoke.dev` URL would bring the "untrusted" warning back for CLI-only VS Code users. A
   copy would then be better, kept in sync by a release step or SchemaStore's
   external-schema sync. Test this with a local catalog before choosing.
2. **Does the extension still win in VS Code?** With the extension installed, a
   `*.ctrlyoke.yaml` file would match both the extension's bundled association and the
   catalog entry. Confirm in VS Code (JSON and Red Hat YAML) that the bundled, offline schema
   is used, or that both apply without conflicting diagnostics. If the catalog copy takes
   priority or doubles the errors, check whether the extension's association can take
   precedence. Red Hat YAML has `yaml.schemaStore.enable`, but ctrlyoke must not change a
   user's settings to force it. This is the same class of problem as the stamped links, so
   do not submit until it has been checked.
3. **Cross-file `$ref`s.** The settings schema refers to `workflow.json#/$defs/…`, which is
   resolved against its `$id`. A catalog consumer that loads `settings.json` from
   `ctrlyoke.dev` fetches `workflow.json` from the same directory, which the publish script
   already provides. If SchemaStore hosts a copy (question 1), the ref must still resolve,
   either through a copy that keeps `$id` or through an absolute ref.

## 4. Work

- [ ] `/schema/v1/` deployed with `Content-Type: application/schema+json` and
      `Access-Control-Allow-Origin: *` (readiness plan checklist; prerequisite).
- [ ] Answer §3's questions with a local catalog: VS Code with and without the extension,
      Red Hat YAML, one JetBrains IDE, and `yaml-language-server` from the command line.
- [ ] Open the SchemaStore PR with the §2 entries (and test files, if required).
- [ ] Docs: `docs/reference/_partials/settings/intro.md` and the workflow-schema intro
      partial should say that other editors pick the schema up automatically through
      SchemaStore, and drop the "set `$schema` by hand" advice where it is no longer needed.
      Regenerate with `npm run generate-schema-docs`.
- [ ] Add "update the SchemaStore `versions` map" to the version-bump steps in the readiness
      plan's §2.6 successor (wherever the v2 procedure ends up documented).

## 5. Out of scope

- Writing `$schema` or a YAML schema line from any ctrlyoke writer. This stays forbidden;
  see §1.
- CLI `--json` output schemas. They are an API contract, not files an editor opens.
