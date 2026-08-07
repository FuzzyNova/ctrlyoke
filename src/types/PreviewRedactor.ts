/**
 * PreviewRedactor is the swap point for the future central service described
 * in dev/backlog/SECRETS_AND_REDACTION_PLAN.md. Keep callers on this boundary.
 */

import type {
  CategorizedPromptSectionPreview,
  HookPreview,
  McpServerPreview,
  RedactionSpan,
  StepExecutionPreview,
  VariableResolutionPreview,
  WorkflowExecutionPreview,
} from "./ExecutionPreviewTypes";

export interface RedactionRule {
  id: string;
  pattern: RegExp;
  valueGroup?: number;
}

export const REDACTION_MARKER = "[REDACTED]";

export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: "private-key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: "bearer-token",
    pattern: /(Bearer\s+)(?!\[REDACTED\])([A-Za-z0-9._~+/=-]{20,})/gi,
    valueGroup: 2,
  },
  {
    id: "credential-prefix",
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g,
  },
  {
    id: "credential-assignment",
    pattern:
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|private[_-]?key)\s*["']?\s*[:=]\s*["']?)(?!\[REDACTED\])([^\s"',;}\]]{8,})/gi,
    valueGroup: 2,
  },
];

interface RedactedText {
  text: string;
  spans: RedactionSpan[];
}

function redactText(
  text: string,
  existing: RedactionSpan[] = []
): RedactedText {
  let currentText = text;
  let spans = [...existing];

  for (const rule of REDACTION_RULES) {
    const matches = [...currentText.matchAll(rule.pattern)];
    if (matches.length === 0) {
      continue;
    }

    let output = "";
    let cursor = 0;
    const newSpans: RedactionSpan[] = [];
    for (const match of matches) {
      const matchStart = match.index ?? 0;
      const matchText = match[0];
      const value = rule.valueGroup ? match[rule.valueGroup] : matchText;
      if (!value) {
        continue;
      }
      const valueOffset = rule.valueGroup ? matchText.indexOf(value) : 0;
      const valueStart = matchStart + Math.max(valueOffset, 0);
      const valueEnd = valueStart + value.length;
      if (valueStart < cursor) {
        continue;
      }

      output += currentText.slice(cursor, valueStart);
      const replacementStart = output.length;
      output += REDACTION_MARKER;
      newSpans.push({
        start: replacementStart,
        end: output.length,
        ruleId: rule.id,
        replacement: REDACTION_MARKER,
      });
      cursor = valueEnd;
    }
    output += currentText.slice(cursor);

    if (newSpans.length > 0) {
      currentText = output;
      spans = [...spans, ...newSpans];
    }
  }

  return { text: currentText, spans };
}

function redactVariable(
  variable: VariableResolutionPreview
): VariableResolutionPreview {
  const redacted = redactText(variable.value, variable.redactions);
  return { ...variable, value: redacted.text, redactions: redacted.spans };
}

function redactHook(hook: HookPreview): HookPreview {
  const command = redactText(hook.command, hook.redactions);
  const inlineConfig = hook.inlineConfigFragment
    ? redactText(hook.inlineConfigFragment, hook.inlineConfigRedactions)
    : undefined;
  const redactedHook: HookPreview = {
    ...hook,
    command: command.text,
    redactions: command.spans,
  };
  return inlineConfig
    ? {
        ...redactedHook,
        inlineConfigFragment: inlineConfig.text,
        inlineConfigRedactions: inlineConfig.spans,
      }
    : redactedHook;
}

function redactMcpServer(server: McpServerPreview): McpServerPreview {
  const inlineConfig = server.inlineConfigFragment
    ? redactText(server.inlineConfigFragment, server.inlineConfigRedactions)
    : undefined;
  const redactedServer: McpServerPreview = {
    ...server,
  };
  return inlineConfig
    ? {
        ...redactedServer,
        inlineConfigFragment: inlineConfig.text,
        inlineConfigRedactions: inlineConfig.spans,
      }
    : redactedServer;
}

function redactSection(
  section: CategorizedPromptSectionPreview
): CategorizedPromptSectionPreview {
  return { ...section };
}

function redactStep(step: StepExecutionPreview): StepExecutionPreview {
  const redactedStep: StepExecutionPreview = {
    ...step,
    resolvedProperties: {
      ...step.resolvedProperties,
      hooks: step.resolvedProperties.hooks.map(redactHook),
    },
    variables: step.variables.map(redactVariable),
  };
  return {
    ...redactedStep,
    ...(step.prompt
      ? {
          prompt: {
            ...step.prompt,
            sections: step.prompt.sections.map(redactSection),
          },
        }
      : {}),
    ...(step.command ? { command: step.command } : {}),
    ...(step.mcpApplication
      ? {
          mcpApplication: {
            ...step.mcpApplication,
            servers: step.mcpApplication.servers.map(redactMcpServer),
          },
        }
      : {}),
  };
}

/** Return a redacted snapshot without mutating the supplied preview. */
export function redactExecutionPreview(
  preview: WorkflowExecutionPreview
): WorkflowExecutionPreview {
  return {
    ...preview,
    steps: preview.steps.map(redactStep),
  };
}
