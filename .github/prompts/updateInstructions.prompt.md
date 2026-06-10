---
name: updateInstructions
description: Updates github folder level instructions based on the current state of the repository and recent changes.
---

As an orchestrator, update the instructions in the .github/instructions folder based on the current state of the repository. For each existing instruction file, create a new subagent using #runSubagent with the following prompt:

```
Read <instruction file> and look at the front matter block to see which files this instruction file pertains to. Then examine the current state of the repository. If the instruction is still relevant, update it to reflect any recent changes in the repository. If the instruction is no longer relevant, delete it.

Keep instructions concise and focused on non-obvious information: architectural decisions, conventions, gotchas, state/data flow, and relationships between files that an agent could not quickly infer by skimming the code. Do NOT include information that is easily looked up directly, such as full directory trees, exhaustive file-by-file listings, or descriptions of every file's name/purpose. A short list of the handful of most important entry-point files is fine, but do not enumerate every file in a directory.

You have explicit permission — and are expected — to actively prune the existing file, not just avoid adding new bloat. If the current content includes a directory tree, exhaustive file listings, restated code/types that are easy to find by reading the source, or other verbose sections that don't meet the bar above, remove them even if they aren't directly related to the recent changes you're documenting. Removing outdated or low-value content is just as valuable as adding new guidance.

If the file has grown large (roughly 300+ lines) or covers multiple distinct sub-areas, split it into smaller, focused instruction files instead of continuing to grow it. Each split file should get its own front matter with an `applyTo` pattern scoped to the relevant subdirectory or file glob, and a descriptive name (e.g. `webview-react-state.instructions.md`, `webview-react-components.instructions.md`). Trim the original file to its remaining scope (or delete it if fully superseded) so there is no duplication across the split files.

Keep the format consistent with the existing instruction files, preferring xml for main section titles and markdown for content. Do not add any extra formatting unless it is necessary for clarity since it can waste tokens.
```

Once existing instruction files have been updated, split, or deleted, check if there are any directories in the repository that do not have corresponding instruction files. If the directory is tracked in the repo and you think it would be helpful to have instructions for it, start a new subagent to create a new instruction file in the .github/instructions folder with the appropriate front matter and content, following the same conciseness and splitting guidance above. The front matter should specify which files or directories the instruction pertains to, and the content should provide clear guidance for AI agents interacting with those files or directories.

When all subagents finish, run a final subagent to review all the updated, deleted, split, and newly created instruction files in order to update the top-level .github/copilot-instructions.md file to reflect overall project instructions based on the current state of the repository and the changes made to the instruction files. The top-level instructions should provide a high-level overview of the project structure and guidance for AI agents on how to navigate and interact with the various components of the repository and should try not to duplicate information that is already present in the individual instruction files. The top-level instructions should be concise and focused on providing an overall understanding of the project.
