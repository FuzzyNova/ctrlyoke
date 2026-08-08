import { describe, expect, it } from "vitest";
import {
  PREVIEW_PROMPT_CATEGORIES,
  PREVIEW_STEP_TYPES,
} from "@root/types/DashboardConstants";
import type {
  CategorizedPromptPreview,
  CommandPreview,
  StepExecutionPreview,
} from "@root/types/ExecutionPreviewTypes";
import {
  buildStepTimeline,
  STEP_TIMELINE_ENTRY_KINDS,
} from "@utils/dryRunTimeline";

const command: CommandPreview = {
  cwd: "C:/workspace",
  executable: "claude",
  args: ["--print"],
  displayCommand: "claude --print",
  displayShell: "powershell",
  requiresShellVerbatimArgs: false,
  environmentKeys: [],
};

function promptWithSections(
  sections: CategorizedPromptPreview["sections"]
): CategorizedPromptPreview {
  return {
    sections,
    totalByteCount: sections.reduce(
      (total, section) => total + section.byteCount,
      0
    ),
    includedBodyByteCount: 0,
    bodyBudgetBytes: 1024,
  };
}

function makeStep(
  overrides: Partial<StepExecutionPreview> = {}
): StepExecutionPreview {
  return {
    stepIndex: 0,
    type: PREVIEW_STEP_TYPES.PROMPT,
    resolvedProperties: {
      harnessId: "claude-cli",
      session: { present: false },
      skills: [],
      mcpServerIds: [],
      hooks: [],
      permissions: { allowedRules: [], deniedRules: [] },
      limits: { violations: [] },
      conditions: {
        pre: [],
        end: [],
        retry: { maxAttempts: 1 },
      },
      propertySources: {},
    },
    workspaceMutations: [],
    variables: [],
    conditions: {
      pre: [],
      end: [],
      retry: { maxAttempts: 1 },
    },
    diagnostics: [],
    ...overrides,
  };
}

describe("buildStepTimeline", () => {
  it("omits the payload entry for Tier 1 file references", () => {
    const step = makeStep({
      prompt: promptWithSections([
        {
          category: PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE,
          byteCount: 500,
          lineCount: null,
          tokenEstimate: 100,
          chunkIndex: 0,
          contentHash: null,
          path: "C:/workspace/README.md",
        },
      ]),
    });

    expect(buildStepTimeline(step)).toEqual([]);
  });

  it("counts real payload sections and their bytes", () => {
    const step = makeStep({
      prompt: promptWithSections([
        {
          category: PREVIEW_PROMPT_CATEGORIES.PROMPT_TEXT,
          byteCount: 120,
          lineCount: 2,
          tokenEstimate: 30,
          chunkIndex: 0,
          contentHash: "prompt",
          body: "prompt",
        },
        {
          category: PREVIEW_PROMPT_CATEGORIES.INLINE_REFERENCE,
          byteCount: 80,
          lineCount: 1,
          tokenEstimate: 20,
          chunkIndex: 0,
          contentHash: "inline",
          body: "excerpt",
        },
      ]),
    });

    expect(buildStepTimeline(step)).toEqual([
      {
        kind: STEP_TIMELINE_ENTRY_KINDS.PAYLOAD,
        fileCount: 2,
        totalByteCount: 200,
      },
    ]);
  });

  it("builds a command-only timeline for a script step", () => {
    const step = makeStep({
      type: PREVIEW_STEP_TYPES.SCRIPT,
      prompt: undefined,
      command,
    });

    expect(buildStepTimeline(step)).toEqual([
      {
        kind: STEP_TIMELINE_ENTRY_KINDS.COMMAND,
        cwd: command.cwd,
        executable: command.executable,
      },
    ]);
  });

  it("preserves mutation order between payload and command", () => {
    const sharedMutation = {
      scope: "shared" as const,
      ownedKeys: ["hooks"],
      operation: "merge",
      path: "C:/workspace/settings.json",
      warning: "Shared file",
    };
    const step = makeStep({
      prompt: promptWithSections([
        {
          category: PREVIEW_PROMPT_CATEGORIES.PROMPT_TEXT,
          byteCount: 50,
          lineCount: 1,
          tokenEstimate: 10,
          chunkIndex: 0,
          contentHash: "prompt",
          body: "prompt",
        },
      ]),
      workspaceMutations: [sharedMutation],
      command,
    });

    expect(buildStepTimeline(step)).toEqual([
      {
        kind: STEP_TIMELINE_ENTRY_KINDS.PAYLOAD,
        fileCount: 1,
        totalByteCount: 50,
      },
      { kind: STEP_TIMELINE_ENTRY_KINDS.MUTATION, mutation: sharedMutation },
      {
        kind: STEP_TIMELINE_ENTRY_KINDS.COMMAND,
        cwd: command.cwd,
        executable: command.executable,
      },
    ]);
  });
});
