# Spell Check Dictionary Plan

**Status:** Proposed 2026-10-30. Not started.

**Goal:** let users teach the prompt editor's spell checker their own words, starting with
`ctrlyoke`, and let them change the spelling language by downloading or importing Hunspell
dictionaries, without bundling every language with ctrlyoke.

## 1. Why

The prompt editor flags every word the bundled `en_US` dictionary lacks, and nothing can be done
about it. The lint tooltip offers up to five "Change to …" fixes and nothing else. For a word with
no suggestions (our own name, `ctrlyoke`), the user just sees a red squiggle that never goes away.
Names, product terms, jargon and every non-English word all stay flagged forever.

## 2. How it works today

- **Engine:** Typo.js (`node_modules/typo-js/typo.js`), copied next to the bundle by
  `src/ui/webview-react/vite.config.ts` and loaded as a global `<script>` (`window.Typo`).
- **Dictionary:** only `src/ui/webview-react/static/dictionaries/en_US/en_US.{aff,dic}` (SCOWL
  size 60, about 550 KB). Its URIs are written onto `<body>` as `data-aff-uri` / `data-dic-uri` by
  `CtrlYokeWebviewProvider.ts` (the webview) and by `CtrlYokeHostedServer.ts` (the hosted browser),
  and read by `src/ui/webview-react/utils/dictionaryUris.ts`. The language is hardcoded: the string
  `"en_US"` appears in all three places.
- **Loading:** each `CodeMirrorEditor` instance fetches both files and builds its own
  `new window.Typo("en_US", …)` in a `useEffect`
  (`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`, "Initialize Typo.js spell
  checker"). `ScriptConditionEditor` mounts two editors, so the same dictionary is parsed more than
  once.
- **Lint:** `createSpellCheckExtension` in the same file:
  - tokenizes with `/[a-zA-Z]+(?:'[a-zA-Z]+)*/g`, which is **ASCII only**;
  - skips references, Markdown non-prose and all-caps words;
  - splits camelCase words with `splitCamelCaseWord`;
  - reports `Spelling: "<word>"` as an `error` with lazily computed "Change to" actions.
- **Docs:** `docs/guide/prompt-editor.md` lists "a misspelled word, with spelling suggestions" among
  the editor's quick fixes.

## 3. Naming the action

Use **Add to dictionary**. Chrome, Edge, Word, macOS, LibreOffice and VS Code's Code Spell Checker
all use it for "remember this word as correct". "Ignore" means something narrower in those tools:
Word's **Ignore** and **Ignore All** last only for the current document or session. We are
building the persistent version, so "Add to dictionary" is the accurate label. The list it adds to
is called the **dictionary** (setting `spelling.words`; UI label "Custom words").

A session-only "Ignore" is out of scope (§10).

## 4. Settings

Add a new root object `spelling` to `schemas/settings-schema.json` and `src/types/CtrlYokeSettings.ts`.
This is an additive change, so no `schema:bump` is needed. Run `npm run schema:update` afterwards
to regenerate the descriptions and the reference docs.

```jsonc
"spelling": {
  "enabled": true,              // turn the prompt-editor spell check off entirely
  "languages": ["en_US"],       // dictionaries to check against, in order
  "words": ["ctrlyoke"]         // custom words that always count as correctly spelled
}
```

### 4.1 `spelling.enabled`

- Type: boolean. Default: `true`.
- When it is off, the extension skips loading any dictionary. Nothing like this exists today.
  Users who find the squiggles noisy currently have no way to turn them off, and the switch costs
  almost nothing to add.

### 4.2 `spelling.languages`

- Type: array of dictionary IDs. Each ID matches `^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*$`.
- Default: `["en_US"]`. Must have at least one item.
- A word counts as correct if **any** listed dictionary accepts it. Suggestions come from the
  languages in order, with duplicates removed. This one setting covers both requests: changing the
  base language means replacing `en_US`, and bilingual users can list two languages.
- An ID that is not installed (§6) is skipped, with a warning in the Spelling settings section. If
  none of the IDs is installed, the editor falls back to the built-in `en_US`, so spell check never
  turns off silently.
- Workspace scope may set it. A project written in German can choose `de_DE` even though each user
  installs the dictionary on their own machine.

### 4.3 `spelling.words`

- Type: array of strings, each 1–64 characters with no whitespace. Default: `["ctrlyoke"]`.
- **User and workspace values are merged as a union**, not replaced. Today `deepMerge` in
  `src/config/CtrlYokeConfigService.ts` replaces arrays, so this needs a special case like the
  existing `modelPricing` one. With the union, a team can commit project terms to
  `.ctrlyoke/settings.json` while each user keeps a personal list.
- The default applies only while neither scope sets the key. Once a user edits their list, the UI
  writes the whole list, so `ctrlyoke` stays unless they remove it on purpose. Do not also union in
  the default: that would make `ctrlyoke` impossible to remove.
- **Matching rules** (the same as Code Spell Checker):
  - A word saved in all lowercase matches any capitalization: `ctrlyoke` also accepts `Ctrlyoke`
    and `CTRLYOKE`.
  - A word saved with any capital letter must match exactly: `GitHub` does not accept `github`.
- Check the **whole token before the camelCase split**. Otherwise a saved `CtrlYoke` would still be
  split into `Ctrl` and `Yoke`, and each part checked separately.

## 5. Lint quick fixes

In `createSpellCheckExtension`:

1. Keep the "Change to" suggestions first. Then add:
   - **Add "word" to dictionary**, which saves to user scope;
   - **Add "word" to workspace dictionary**, shown only when a workspace is open.

   Both appear even when Typo.js has no suggestions, which fixes the `ctrlyoke` case in the
   screenshot.
2. Saving a word must be an **append-unique done on the host**. Add a message
   `SPELLING_ADD_WORD { word, scope }` to `src/types/WebviewMessageTypes.ts` that reads the current
   list, appends the word if it is missing, and writes the list back through
   `CtrlYokeConfigService`. Do not build the new array in the webview and send it through
   `UPDATE_GLOBAL_SETTING`: two dashboards (the panel and a hosted tab) adding words at the same
   time would overwrite each other's additions.
3. The squiggle must disappear without waiting for an edit. Keep the custom-word set in a ref that
   the linter reads; when settings change, update the ref and call `forceLinting(view)` from
   `@codemirror/lint`. Also add the word to the ref right away, so the squiggle clears before the
   settings round trip completes.
4. Replace the `(this as any)._cachedActions` getter with a typed diagnostic factory while touching
   this code (see the coding principles on structural casts).

## 6. Getting more languages

### 6.1 Where dictionaries live

- Installed dictionaries are machine-local data, not settings. Store each one as
  `<ctrlyokeStateHome>/dictionaries/<id>/` (`ProjectStatePaths.ctrlyokeStateHome()`), containing
  `<id>.aff`, `<id>.dic`, the upstream `LICENSE` when there is one, and `dictionary.json`.
- `dictionary.json` records `schemaVersion`, `id`, `source` (`"catalog"` or `"import"`), the
  upstream package and version, `sha256`, the SPDX license and `installedAt`. It is versioned
  persisted state, so the rules in `CLAUDE.md` apply: read older formats, and keep a file written by
  a newer ctrlyoke read-only.
- `en_US` stays bundled as the built-in dictionary. It can't be uninstalled, and it is what the
  editor falls back to.

### 6.2 Download from a pinned catalog (recommended path)

Source: [`wooorm/dictionaries`](https://github.com/wooorm/dictionaries). It publishes about 90
Hunspell dictionaries as npm packages named `dictionary-<code>`. Each package contains
`index.aff`, `index.dic` and its license, all already UTF-8. The packages are fetched from the npm
registry or jsDelivr at a pinned version.

- Add a generator, `scripts/generate-spelling-catalog.mjs`, that writes
  `src/utils/SpellingDictionaryCatalog.ts`. Each entry holds the ID, display name, package,
  **pinned version**, `sha256` of both files, size and SPDX license. Regenerate it by hand when we
  want newer word lists; never resolve "latest" at runtime.
- The **extension host** downloads the files, not the webview. This keeps the webview CSP
  (`connect-src ${webview.cspSource}`) and the hosted CSP unchanged, and it works the same from the
  VS Code panel and the hosted browser. Before writing anything to disk, the host checks each file
  against the catalog's hash and size. A mismatch aborts the install.
- Licenses vary by language: MIT, BSD, LGPL, GPL and MPL all appear. Show the license next to each
  language in the picker, and keep the `LICENSE` file beside the installed dictionary. ctrlyoke
  does not redistribute anything: the user downloads directly from upstream when they ask to.

### 6.3 Import from files

This is for languages missing from the catalog and for offline machines.

- The user picks a `.aff` and `.dic` pair. Use an `<input type="file">`, which works in both the
  webview and the hosted browser. The webview sends the bytes to the host in a
  `SPELLING_DICTIONARY_IMPORT` message.
- The hosted WebSocket accepts up to 24 MB per message (`HOSTED_WEBSOCKET_MAX_PAYLOAD_BYTES`). Reject
  any import larger than about 20 MB in the UI, before sending.
- The host validates the pair:
  - both files parse;
  - the ID comes from the file name and passes the ID pattern;
  - the dictionary does not replace the built-in `en_US`;
  - it can replace an existing imported dictionary only after the user confirms.
- **Encoding:** many LibreOffice dictionaries declare `SET ISO8859-1` (or another legacy encoding)
  in their `.aff` file. The webview reads dictionaries with `fetch().text()`, which always decodes
  as UTF-8, so those files would come out garbled. The host should transcode both files to UTF-8
  with `TextDecoder` on import and rewrite the `SET` line to `SET UTF-8`.
- A LibreOffice `.oxt` extension is a zip that contains the `.aff`/`.dic` pair. Accepting one is a
  follow-up (§10).
- The settings section links to where users can find dictionaries: wooorm/dictionaries and the
  LibreOffice dictionaries repository. Put those URLs in one constant (an external-URL constant in
  `DashboardConstants.ts`), not inline in the component.

### 6.4 Serving installed dictionaries to the editor

- **Webview:** add `<ctrlyokeStateHome>/dictionaries` to `localResourceRoots` in
  `CtrlYokeWebviewProvider.ts`. Expose a base URI for it (for example, a `data-user-dictionaries-uri`
  attribute on `<body>`).
- **Hosted server:** add an authenticated route, `/user-dictionaries/<id>/<file>`. It may serve
  only `<id>.aff` or `<id>.dic`, and only for an `id` that appears in an installed manifest, which
  rules out path traversal.
- Replace `getDictionaryUris()` with a resolver that takes the language list and returns one URI
  pair per language. The `"en_US"` literals in the provider, the server and `dictionaryUris.ts`
  become a single constant.

## 7. Spell checker loading (prerequisite refactor)

Do this before adding languages, because extra dictionaries multiply the cost of today's approach:

- Move loading out of `CodeMirrorEditor` into a module-level `SpellChecker` service in
  `src/ui/webview-react/utils/`. It caches one Typo instance per language ID and exposes
  `check(word)` / `suggest(word)` over the configured languages. Every editor shares it.
- **Spike first:** measure load time and heap for a few large catalog dictionaries (`de`, `fr`,
  `hu`, `pt-BR`) in Typo.js. Typo.js expands affix rules eagerly, so some languages may take
  seconds to load and a lot of memory. If the numbers are bad:
  - move parsing and checking into a Web Worker, so the editor never blocks; and/or
  - switch the engine to [`nspell`](https://github.com/wooorm/nspell), which reads the same
    `.aff`/`.dic` format and comes from the same author as the catalog. Unlike Typo.js, it is an
    npm module, so the `window.Typo` global and the `{{typoUri}}` script tag would go away.

  Record the measurements in this doc before choosing.
- **Tokenizer:** replace `/[a-zA-Z]+(?:'[a-zA-Z]+)*/g` with a Unicode-aware pattern using the `u`
  flag, e.g. `/\p{L}+(?:['’]\p{L}+)*/gu`. Update `splitCamelCaseWord` and the all-caps checks to use
  locale-independent `\p{Lu}` / `\p{Ll}` tests. Without this, words like "über" or "café" are split
  apart at the accented letter, and no non-English dictionary can work.

## 8. Settings UI

Add a **Spelling** subsection to `GeneralSection.tsx`, after Font Sizes and before UI Preferences.
It contains:

1. **Check spelling in the prompt editor**: a toggle for `spelling.enabled`.
2. **Languages:** a list of the configured languages. Each row shows an install-state badge and a
   remove button, and rows can be reordered. Below the list:
   - **Add language…**: a searchable `CustomSelect` over the catalog plus the imported dictionaries.
     Picking a language that is not installed downloads it, with progress shown inline, then adds it.
   - **Import dictionary…**: opens the file picker from §6.3.
   - **Find dictionaries**: an external link.
3. **Installed dictionaries:** a short table of name, source, license, size and an Uninstall
   button. Uninstalling a language that is still listed in `spelling.languages` asks for
   confirmation, which respects `ui.confirmDeleteOperations`.
4. **Custom words:** a list editor for `spelling.words`, with add, remove and a filter box for long
   lists, shown per scope like other settings rows (`SettingInputRow` with `rowProps`).
   `PortListEditor` and `TrustedRootsListEditor` under `components/shared/` already follow the same
   add/remove-list pattern. Pull out a generic string-list editor rather than writing a third copy.

Register the new keys in `settingsCatalog.ts` so settings search finds them. Install, import,
uninstall and list messages go in `WebviewMessageTypes.ts`, with matching handlers in the
`WebviewMessageRouter`. The host pushes the installed-dictionary list to every client after any
change.

## 9. Delivery

### Phase 1: custom words (ships alone)

- `spelling.enabled` and `spelling.words`: schema, types, union merge, `schema:update`.
- The shared `SpellChecker` service and the Unicode tokenizer.
- The two Add-to-dictionary quick fixes, `SPELLING_ADD_WORD`, and live re-linting.
- The Spelling section with the toggle and the custom-words editor.
- Tests:
  - word matching (case rules, check before camelCase split);
  - union merge across scopes;
  - concurrent add-word on the host;
  - UI tests that the quick fix appears for a word with no suggestions and that the squiggle clears.
- `docs/guide/prompt-editor.md`: document Add to dictionary and the setting. Add a `CHANGELOG.md`
  entry under `## [Unreleased]`.

### Phase 2: languages

- Spike and engine decision (§7). Record the measurements here.
- `spelling.languages`, the installed-dictionary store and manifest, the catalog generator, and the
  host downloader with hash checks.
- Import with transcoding, the serving routes, and the Languages / Installed-dictionaries UI.
- Tests:
  - hash mismatch aborts the install;
  - the hosted route rejects path traversal;
  - a Latin-1 `.aff`/`.dic` pair imports correctly;
  - a missing language falls back to `en_US`;
  - a newer-version manifest is treated as read-only.
- Docs: a "Spelling languages" section in the prompt-editor guide, with links to the dictionary
  sources.

## 10. Out of scope / follow-ups

- Session-only **Ignore** / **Ignore all** (in memory, cleared on reload).
- Importing a LibreOffice `.oxt` directly.
- Spell checking in other editors (script, condition and workspace-file editors), and choosing a
  language per workflow.
- A CLI command for managing words or dictionaries. Today they are edited in `settings.json` or
  the dashboard.

## 11. Open questions

1. Should the workspace-dictionary quick fix be hidden when `.ctrlyoke/settings.json` is
   gitignored? It still works either way, but it isn't shared with the team.
2. Typo.js or nspell? This waits on the §7 spike.
3. Should `en_US` move out of the bundle once downloads exist? The recommendation is no: keep it so
   spell check works offline on first run.
