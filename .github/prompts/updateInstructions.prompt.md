---
name: updateInstructions
description: Updates github folder level instructions based on the current state of the repository and recent changes.
---

As an orchestrator, update the instructions in the .github/instructions folder based on the current state of the repository. For each existing instruction file, create a new subagent using #runSubagent with the following prompt:

```
Read <instruction file> and look at the front matter block to see which files this instruction file pertains to. Then examine the current state of the repository. If the instruction is still relevant, update it to reflect any recent changes in the repository. If the instruction is no longer relevant, delete it. Keep the instructions clear and concise, ensuring they provide accurate guidance for AI agents. Keep the format consistent with the existing instruction files, preferring xml for main section titles and markdown for content. Do not add any extra formatting unless it is necessary for clarity since it can waste tokens.
```

Once existing instruction files have been updated or deleted, check if there are any directories in the repository that do not have corresponding instruction files. If the directory is tracked in the repo and you think it would be helpful to have instructions for it, start a new subagent to create a new instruction file in the .github/instructions folder with the appropriate front matter and content. The front matter should specify which files or directories the instruction pertains to, and the content should provide clear guidance for AI agents interacting with those files or directories, following the same formatting guidelines as above.

When all subagents finish, run a final subagent to review all the updated, deleted, and newly created instruction files in order to update the top-level .github/copilot-instructions.md file to reflect overall project instructions based on the current state of the repository and the changes made to the instruction files. The top-level instructions should provide a high-level overview of the project structure and guidance for AI agents on how to navigate and interact with the various components of the repository and should try not to duplicate information that is already present in the individual instruction files. The top-level instructions should be concise and focused on providing an overall understanding of the project.
