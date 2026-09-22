☑️ fix run number display and find a good location for run dropdown

☑️ fix pause display and icons
☑️ fix continuation mode banner and run icon ordering

increase size of custom select a bit on mobile at least

☑️ fork a draft

☑️ terminal follow up not always working, and definitely not working in pause mode

in "more run dropdown" step 6 context didnt get read by claude automatically because the files were too big, may need to adjust our file splitter

☑️ add hover text to model dropdowns to show full name, or make dropdown wider (models for opencode don't show all the way)

☑️ Opencode converts typed "@" file references to an agent mode like "@explore" in inject mode

☑️ fix how editting completed prompts works, right now it forces a rewind but throws due to revision issue.

☑️ Bug with new workflow showing draft with 2 runs that don't belong to it.

☑️ do a follow up for agy and see if we can get better context window stats

☑️ render all references as chips in output history

☑️ fix formatting of pre / post condition

☑️ commit message generation should use CLI ouput and display the raw output of the harness.

☑️ template doesn't load final step only templates correctly

☑️ codex hook cleanup

☑️ opencode.json gitignore

☑️ fix where ctrlyoke right click menu shortcuts show up in vs code (currently doesn't show up in scm)

☑️ Add more context menus to the app, specifically workspace explorer (copy/move files), we have cut and paste already though

☑️ Add file link to diff views so it opens the full file

☑️ Make undo modal take up full window space and use diff view used by workspace

☑️ Add animation for output window new messages and fix scroll lock behavior and glitchiness when live events are coming in (no animation needed)

☑️ add find to output window and make icons bigger

☑️ script result string doesn't wrap properly in the OutputSection

☑️ FOUND THE EDITOR SHIFT CAUSE: it happens when you drag to select - so figure out why dragging to select drags the whole editor down and brings the propery drawer up.

☑️ research translation and localization

fix tab navigation and keyboard shortcuts

☑️ fix commit message generation

☑️ we are leaving statusline configuration in the global claude settings, it should probably be a setting like antigravity has where users can disable if wanted.

☑️ auto complete dropdown for single line codemirror doesn't work on mobile (maybe keyboard hiding it)

☑️ we should add codemirror auto complete editors for allowed tools lists, additional args, and maybe convert the variable field to one

☑️ (VARIABLE FIELD NOT DONE YET). - variable field is done but it's a straight variable editor not code mirror

hooks don't warn when empty

☑️ switching away from the commit-message-generation to a new workflow made the workflow's panel disabled

☑️ commit-message-generation workflow should overlay why the panels are disabled (ie and overlay of workflow prop panel saying "disabled due to system workflow" or "disabled: workflow deleted"), not allow the send or queue buttons in the editor, and show the actual value in the workflow props panel, even if they are grayed out it, it should still show the right harness/model/etc

mcp sometimes does not get attached, or harness bugs where the don't pick up the mcp. Claude suggested changing our mcp format to http instead of stdio might fix this, but not sure.

☑️ token count uses cached tokens and inflates the actual totals and makes it hard to read, context bar should switch to using "2x or 3x" instead of the raw token value too

☑️ fix default location of ctrlyoke panel in vs code, bottom panel feels wrong now.

☑️ find the right way to force a specific aspect ratio and resolution (maybe in the developer section, or just using playwright), ideally it takes an automatic screenshot too

☑️ fix externally controlled banners, use the same banner as pause and continue instead of overloading the chips in the workflow summary table.

readAddressedRunView is slow on large histories — measured 4.1s for the summaries/descriptor/history read on a ~1350-run lineage (ctrlyoke-1788448120396.log, 19:31:28→19:31:33), because getRunSummaries reads one working file per run. It no longer blocks acting on a workflow (revisions are published ahead of the snapshot now), but it still delays every run-view refresh.

☑️ Script step commands run under a different shell depending on Execution Mode, silently, on Windows: Interactive always resolves and uses PowerShell (WorkflowInstance.ts:3714-3719 → PtyProcessManager.ts's resolveWindowsShell, ~line 59-75), while Headless has no shell-selection logic at all — it sets `viaShell: true` (EndConditionEvaluator.ts:211-221) and falls through to Node's child_process.spawn default (CliProcessManager.ts:87-94), which on Windows means cmd.exe. The same script text (e.g. a PowerShell `for ($i=1; ...)` loop) works in one execution mode and fails with a shell-specific parse error in the other, with no warning to the user about which shell will run it.

☑️ fix marketing copy to include "workflow engine" somewhere

☑️ fix font color on header banners to be more readable

Undo and redo do not work for a lot of things, this one needs a big pass

workflow status header is hiding the branch and terminal icon at wider views since changing the status badge grows.

☑️ switching to a running workflow doesn't show the live context window until the next update.
