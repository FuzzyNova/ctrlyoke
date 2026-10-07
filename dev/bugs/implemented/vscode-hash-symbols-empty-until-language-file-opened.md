# VS Code-hosted `#` symbol completions are empty until a file of that language is opened

**Resolution:** fixed in this commit

- **Found:** 2026-10-07 by Nathan (manual testing)
- **Area:** `src/platform/VsCodeSymbolIndex.ts`, `src/completions/CompletionHelpers.ts`
- **Severity:** medium

## Symptom

In the VS Code-hosted dashboard (panel or hosted browser), typing `#` in the
prompt editor (`CodeMirrorEditor.tsx`) shows no workspace symbols when no
`.ts`/`.tsx` document has been opened in the VS Code session. After any
TS/TSX file is opened, `#` returns TypeScript symbols as expected.

## Steps to Reproduce

1. Start VS Code on a TypeScript workspace and close every editor (or start
   fresh with none restored).
2. Open the ctrlyoke dashboard and type `#Workflow` in the prompt editor.
3. The completion list has no symbols (only editor selections, if any).
4. Open any `.ts` file in VS Code, then type `#Workflow` again: symbols appear.

## Root Cause

`VsCodeSymbolIndex.workspaceSymbols` calls only
`vscode.executeWorkspaceSymbolProvider`, and nothing falls back when that
returns empty (`CompletionCore.getSymbolCompletions` consumes it directly).
That command queries providers that are already registered and activates
nothing. The bundled `typescript-language-features` (10.0.0) has three
behaviors that make the result empty before a TS document opens:

- It activates only on `onLanguage:*` (no `workspaceContains`).
- Even when active, it registers its language providers only once a JS/TS
  document is in `workspace.textDocuments`.
- Its `navto` request (scope `allOpenProjects`) searches only the tsserver
  projects that an open file has loaded.

No VS Code or TypeScript setting preloads projects. The full analysis is in
`dev/backlog/WORKSPACE_EDITOR_LANGUAGE_INTELLIGENCE_PLAN.md`, "VS Code cold
start".

## Suggested Fix

Phase 7c of the language-intelligence plan (staging Stage I2):

1. Add a `FallbackSymbolIndex` wrapping `VsCodeSymbolIndex` with the existing
   `RegexSymbolIndex`, which is already standalone's `#` source. It serves
   regex symbols whenever VS Code returns none.
2. On a `#` query with no TS/JS document open, have `VsCodeSymbolIndex` call
   `vscode.workspace.openTextDocument` (never `showTextDocument`) on an anchor
   source file under the workspace's `tsconfig.json`/`jsconfig.json`. That
   activates the extension and makes tsserver load the project. Later
   keystrokes then get full-fidelity results.

Documentation alone ("open a file of each language first") was rejected
because the fallback removes the empty case outright.
