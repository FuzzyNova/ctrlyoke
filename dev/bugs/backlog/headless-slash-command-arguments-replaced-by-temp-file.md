# Headless steps send `/command args` as `/command @temp-file`, dropping the arguments

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli, dry-run + unit test)
- **Area:** `src/core/harness/shared/CliPromptPreparer.ts` (`planPrompt`, headless note and the slash-command-with-arguments inline path)
- **Severity:** medium

## Symptom

A prompt step that invokes a harness slash command with arguments, e.g.
`prompt: /review 123` or `/fix-issue 42`, is sent intact in interactive mode.
In headless mode (the default for most CLI and workflow runs) the harness gets
a different command:

```
ctrlyoke run sl.ctrlyoke.yaml --dry-run
  Command (POSIX shell): 'claude' '/review Follow instructions in @.ctrlyoke/temp/sl-1-….prompt.md ' '-p' …
  Payload: Prompt text
    /review 123 This headless session ends when you end your turn, …
```

The command's argument is now "Follow instructions in @…prompt.md" instead of
`123`. A command that substitutes `$ARGUMENTS` (Claude custom commands, Codex
and opencode prompts) receives the temp-file pointer, not the user's argument;
the real argument only exists inside the file, glued to the headless notice.

## Steps to Reproduce

Unit test (fails on the headless iteration, passes interactive), for
`src/test/unit/CliPromptPreparer.test.ts`:

```ts
test("keeps a slash command with arguments inline in headless mode too", async () => {
  const preparer = new CliPromptPreparer({
    shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
    buildPromptSections: async (prompt) =>
      createSections({ userPromptText: prompt.prompt }),
    extractLeadingSlashCommand: (text) => text.split(" ")[0] ?? null,
    isSimplePrompt: () => true,
    buildPriorContextXmlFromItems: () => "",
    getWorkspaceRoot: () => process.cwd(),
    getTempFileSplitConfig: () => undefined,
    formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
    formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
    formatCategorizedReferences: (...refs) => refs.flat().join(" "),
  });
  const prompt = { prompt: "/review 123" } as PromptStep;
  for (const executionMode of [
    EXECUTION_MODES.INTERACTIVE,
    EXECUTION_MODES.HEADLESS,
  ]) {
    const plan = await preparer.planPrompt(
      prompt,
      undefined,
      { executionMode } as ResolvedProperties,
      undefined
    );
    assert.strictEqual(
      plan.promptWithInstruction,
      "/review 123",
      executionMode
    );
    assert.deepStrictEqual(plan.tempFilePaths, [], executionMode);
  }
});
// headless: actual '/review @<workspace>/.ctrlyoke/temp/prompt-….prompt.md'
```

Or with the CLI: a workflow with `harness: claude-cli` and one step
`prompt: /review 123`, run with `ctrlyoke run <file> --dry-run` (the dry run
plans headless).

## Root Cause

`planPrompt` appends the headless note to the user text (line ~361):

```ts
if (resolvedProperties?.executionMode === EXECUTION_MODES.HEADLESS) {
  outgoingSections.userPromptText = `${…trimEnd()} ${HEADLESS_EXECUTION_NOTE}`;
}
```

The slash-command-with-arguments inline path just below (lines ~387-406)
requires `originalPromptText === outgoingSections.userPromptText`. That
equality is there to detect expansions that changed the text, and the note
always breaks it in headless mode. So the prompt falls through to the
categorized temp-file path, which keeps only the command token in argv and
moves the rest, arguments included, into the file. Introduced by `2a7699a9b`
(fix: warn when headless steps stop background work), shipped since v0.3.0.

Pure slash commands (`/compact`) are unaffected because they return before the
note is appended (line ~212).

## Suggested Fix

Don't let the headless note alter a slash-command invocation:

- Run the slash-command-with-arguments check against the note-free text (keep
  the pre-note `userPromptText` in a local and compare with that), and when that
  inline path is taken, send `originalPromptText` without the note. Appending
  the note there would change the command's arguments, which is the bug.
- Keep the note for every other headless prompt, including slash commands that
  go through the categorized path for other reasons (attachments, references,
  multi-line), where the text is already in a temp file.

Add the test above to `src/test/unit/CliPromptPreparer.test.ts`, and keep the
existing "adds the headless execution note only to headless prompts" test
passing. Add a `CHANGELOG.md` **Fixed** entry under `## [Unreleased]`.
