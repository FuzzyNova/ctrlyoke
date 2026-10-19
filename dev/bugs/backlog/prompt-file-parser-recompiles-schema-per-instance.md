# PromptFileParser recompiles the workflow schema on every construction

- **Found:** 2026-10-19 by Claude Code (performance investigation, extension-host CPU profile)
- **Area:** `src/core/PromptFileParser.ts`
- **Severity:** low

## Symptom

Each new `PromptFileParser` compiles both Ajv validators for `schemas/workflow-schema.json`
synchronously: ~120–250 ms of blocked event loop per construction in a startup CPU profile
(about 1.15 s total during dev-host activation). The session log shows
`[PromptFileParser] JSON schema loaded successfully` five or more times during activation.
Constructions come from `extension.ts` activation, `TemplateManager`, `WorkflowOrchestrator`,
`PromptEditorSupportService`, and **every `WorkflowInstance`**
(`buildWorkflowInstanceForHost`). Loading or switching to a workflow that has no instance yet,
and every **Load from File…** (which creates a fresh instance each time, per
`hosted-tab-startup-stalls-with-loaded-workflows.md`), pays the compile again.

## Steps to Reproduce

1. Start a dev host and count `JSON schema loaded successfully` lines in the session log.
2. Load a workflow from file several times; each load adds another line and another
   ~200 ms `[EventLoopStall]`-sized gap.

## Root Cause

`PromptFileParser` owns a per-instance `Ajv` (`src/core/PromptFileParser.ts:144`), and its
constructor calls `loadSchemas()` (line 156), which reads the schema and runs
`this.ajv.compile(...)` for both the strict and relaxed validators (lines 185–186).
Nothing shares the compiled functions across instances, although the schema is a static
bundled file.

## Suggested Fix

Compile the two validators once per process: a lazily initialized module-level singleton
keyed by schema path, or a static on the class. Every `PromptFileParser` then reuses them. Keep
the instance API unchanged so callers and tests are unaffected.
