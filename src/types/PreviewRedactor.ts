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

export function redactPreviewText(
  text: string,
  existing: RedactionSpan[] = [],
  exactSecrets: readonly string[] = [],
  protectedValues: readonly string[] = []
): RedactedText {
  let currentText = text;
  let spans = [...existing];
  const protectedSet = new Set(
    protectedValues.filter((value) => value.length > 0)
  );

  for (const secret of [...exactSecrets]
    .filter((value) => value.length > 0 && !protectedSet.has(value))
    .sort((left, right) => right.length - left.length)) {
    let start = currentText.indexOf(secret);
    while (start >= 0) {
      const end = start + secret.length;
      currentText =
        currentText.slice(0, start) + REDACTION_MARKER + currentText.slice(end);
      spans.push({
        start,
        end: start + REDACTION_MARKER.length,
        ruleId: "exact-secret",
        replacement: REDACTION_MARKER,
      });
      start = currentText.indexOf(secret, start + REDACTION_MARKER.length);
    }
  }

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
      if (!value || protectedSet.has(value)) {
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
  variable: VariableResolutionPreview,
  exactSecrets: readonly string[]
): VariableResolutionPreview {
  const redacted = redactPreviewText(
    variable.value,
    variable.redactions,
    exactSecrets
  );
  return { ...variable, value: redacted.text, redactions: redacted.spans };
}

function redactHook(
  hook: HookPreview,
  exactSecrets: readonly string[]
): HookPreview {
  const command = redactPreviewText(
    hook.command,
    hook.redactions,
    exactSecrets
  );
  const inlineConfig = hook.inlineConfigFragment
    ? redactPreviewText(
        hook.inlineConfigFragment,
        hook.inlineConfigRedactions,
        exactSecrets
      )
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

function redactMcpServer(
  server: McpServerPreview,
  exactSecrets: readonly string[]
): McpServerPreview {
  const inlineConfig = server.inlineConfigFragment
    ? redactPreviewText(
        server.inlineConfigFragment,
        server.inlineConfigRedactions,
        exactSecrets
      )
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
  section: CategorizedPromptSectionPreview,
  exactSecrets: readonly string[]
): CategorizedPromptSectionPreview {
  return {
    ...section,
    ...(section.body !== undefined
      ? { body: redactPreviewText(section.body, [], exactSecrets).text }
      : {}),
  };
}

function redactStep(
  step: StepExecutionPreview,
  exactSecrets: readonly string[]
): StepExecutionPreview {
  const redactedCommand = step.command
    ? {
        ...step.command,
        args: step.command.args.map(
          (arg) => redactPreviewText(arg, [], exactSecrets).text
        ),
        displayCommand: redactPreviewText(
          step.command.displayCommand,
          [],
          exactSecrets
        ).text,
      }
    : undefined;
  const redactedStep: StepExecutionPreview = {
    ...step,
    resolvedProperties: {
      ...step.resolvedProperties,
      hooks: step.resolvedProperties.hooks.map((hook) =>
        redactHook(hook, exactSecrets)
      ),
    },
    variables: step.variables.map((variable) =>
      redactVariable(variable, exactSecrets)
    ),
  };
  return {
    ...redactedStep,
    ...(step.prompt
      ? {
          prompt: {
            ...step.prompt,
            sections: step.prompt.sections.map((section) =>
              redactSection(section, exactSecrets)
            ),
          },
        }
      : {}),
    ...(redactedCommand ? { command: redactedCommand } : {}),
    ...(step.mcpApplication
      ? {
          mcpApplication: {
            ...step.mcpApplication,
            servers: step.mcpApplication.servers.map((server) =>
              redactMcpServer(server, exactSecrets)
            ),
          },
        }
      : {}),
  };
}

/** Return a redacted snapshot without mutating the supplied preview. */
export function redactExecutionPreview(
  preview: WorkflowExecutionPreview,
  exactSecrets: readonly string[] = []
): WorkflowExecutionPreview {
  return {
    ...preview,
    steps: preview.steps.map((step) => redactStep(step, exactSecrets)),
  };
}
