I'm seeing an issue with how we detect the prompt echo in the CLI interactive mode. It's mainly an issue for @src/flightpath/cli/CodexCommandLineIntegration.ts, because codex removes some spaces sometimes in the output:

[2025-12-27T22:24:08.339Z] DEBUG: [File Echo Buffer] Content: "
Follow instructionsin.flightpath\temp\1766874247-dynamic-queue-basic-example-4.prompt.md"

See the full log here if you want @logs/Codex-file-echo-bug.log, but when doing the File Echo Buffer check, we should remove all whitespace before doing the compare, I don't think that could have any negative side effects, we want to detect the prompt echo regardless of whitespace.
