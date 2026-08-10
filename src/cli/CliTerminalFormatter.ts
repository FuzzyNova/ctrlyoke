import chalk from "chalk";
import * as Diff from "diff";
import { COMMAND_DISPLAY_SHELL_LABELS } from "../types/CommandDisplayFormatter";
import type { CliEvent } from "../types/CliOutputTypes";
import type {
  TextData,
  ThinkingBlock,
  BashCommandData,
  FileReadData,
  FileWriteData,
  FileEditData,
  FileDeleteData,
  McpToolCallData,
  WebSearchData,
  ToolCall,
  ToolResultData,
  UnifiedDiffHunk,
} from "../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  PREVIEW_PROMPT_CATEGORY_LABELS,
  PREVIEW_MUTATION_SCOPES,
  PREVIEW_TRUNCATION_REASON_COPY,
  PREVIEW_TRUNCATION_REASONS,
  STATUS_MESSAGE_SEVERITY,
} from "../types/DashboardConstants";
import type {
  PromptCompleteData,
  PromptStartData,
} from "../core/WorkflowInstance";
import type { WorkflowExecutionPreview } from "../types/ExecutionPreviewTypes";
import {
  formatTokenBreakdown,
  formatCostLabel,
  formatCostSourcePhrase,
  formatTokenCount,
  resolveTokenTotal,
} from "../utils/TokenFormatting";

/** Maximum diff lines shown before truncating with a "… N more" message. */
const MAX_DIFF_LINES = 60;

// ---- Diff helpers (ported from webview outputUtils — no shared import to avoid bundle coupling) ----

interface DiffLine {
  type: "added" | "removed" | "context";
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

function parseUnifiedDiff(hunks: UnifiedDiffHunk[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const hunk of hunks) {
    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === "+") {
        lines.push({ type: "added", newLineNum, content });
        newLineNum++;
      } else if (prefix === "-") {
        lines.push({ type: "removed", oldLineNum, content });
        oldLineNum++;
      } else {
        lines.push({ type: "context", oldLineNum, newLineNum, content });
        oldLineNum++;
        newLineNum++;
      }
    }
  }
  return lines;
}

function generateDiffLines(oldContent: string, newContent: string): DiffLine[] {
  const diffResult = Diff.diffLines(oldContent, newContent);
  const lines: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  for (const part of diffResult) {
    const partLines = part.value.split("\n");
    if (partLines[partLines.length - 1] === "") partLines.pop();
    for (const line of partLines) {
      if (part.added) {
        lines.push({ type: "added", newLineNum, content: line });
        newLineNum++;
      } else if (part.removed) {
        lines.push({ type: "removed", oldLineNum, content: line });
        oldLineNum++;
      } else {
        lines.push({ type: "context", oldLineNum, newLineNum, content: line });
        oldLineNum++;
        newLineNum++;
      }
    }
  }
  return lines;
}

// ---- Diff renderer ----

function renderDiffBlock(data: FileEditData): void {
  let lines: DiffLine[];
  if (data.structuredPatch && data.structuredPatch.length > 0) {
    lines = parseUnifiedDiff(data.structuredPatch);
  } else if (data.oldContent !== undefined && data.newContent !== undefined) {
    lines = generateDiffLines(data.oldContent, data.newContent);
  } else {
    return;
  }

  if (lines.length === 0) return;

  const displayLines = lines.slice(0, MAX_DIFF_LINES);
  const remaining = lines.length - displayLines.length;

  const maxNum = Math.max(
    ...lines.map((l) => Math.max(l.oldLineNum ?? 0, l.newLineNum ?? 0))
  );
  const numWidth = Math.max(3, String(maxNum).length);

  for (const line of displayLines) {
    const oldN =
      line.oldLineNum !== undefined
        ? String(line.oldLineNum).padStart(numWidth)
        : " ".repeat(numWidth);
    const newN =
      line.newLineNum !== undefined
        ? String(line.newLineNum).padStart(numWidth)
        : " ".repeat(numWidth);
    const nums = chalk.dim(`${oldN} ${newN}`);

    switch (line.type) {
      case "added":
        console.log(chalk.green(`  ${nums} + ${line.content}`));
        break;
      case "removed":
        console.log(chalk.red(`  ${nums} - ${line.content}`));
        break;
      case "context":
        console.log(chalk.dim(`  ${nums}   ${line.content}`));
        break;
    }
  }

  if (remaining > 0) {
    console.log(
      chalk.dim(`  … ${remaining} more line${remaining !== 1 ? "s" : ""}`)
    );
  }
}

// ---- Main formatter ----

/**
 * Chalk-based terminal renderer for CliEvent arrays.
 * Used by the standalone ctrlyoke CLI to stream structured output to stdout.
 */
export class CliTerminalFormatter {
  /** Render a complete, redacted dry-run snapshot with diagnostics first. */
  static renderExecutionPreview(
    preview: WorkflowExecutionPreview,
    writeLine: (line: string) => void = (line) => console.log(line)
  ): void {
    writeLine(chalk.bold(`Dry run: ${preview.workflow.name}`));
    writeLine(
      chalk.dim(
        `${preview.workflow.stepCount} step(s) · ${preview.workflow.totalByteCount} payload bytes · ${preview.workflow.workspaceMutationCount} planned workspace mutation(s)`
      )
    );
    writeLine("");

    if (preview.diagnostics.length > 0) {
      writeLine(chalk.bold("Diagnostics"));
      for (const diagnostic of preview.diagnostics) {
        writeLine(
          `${formatDiagnosticSeverity(diagnostic.severity)} ${diagnostic.code}: ${diagnostic.message}`
        );
      }
      writeLine("");
    }

    writeLine(chalk.bold("Steps"));
    for (const step of preview.steps) {
      const name = step.stepName ? ` — ${step.stepName}` : "";
      writeLine(`Step ${step.stepIndex + 1}${name} (${step.type})`);
      writeLine(`  Harness: ${step.resolvedProperties.harnessId}`);
      if (step.resolvedProperties.model) {
        writeLine(`  Model: ${step.resolvedProperties.model}`);
      }
      if (step.command) {
        writeLine(
          `  Command (${COMMAND_DISPLAY_SHELL_LABELS[step.command.displayShell]}): ${step.command.displayCommand}`
        );
      }
      for (const variable of step.variables) {
        writeLine(`  Variable: ${variable.name}=${variable.value}`);
      }
      for (const section of step.prompt?.sections ?? []) {
        const includedBytes = section.body
          ? Buffer.byteLength(section.body, "utf8")
          : 0;
        const lineInfo = section.lineCount === null ? "?" : section.lineCount;
        writeLine(
          `  Payload: ${PREVIEW_PROMPT_CATEGORY_LABELS[section.category]} — ${section.byteCount} bytes, ${lineInfo} lines, chunk ${section.chunkIndex}`
        );
        if (section.body) {
          for (const line of section.body.split("\n")) {
            writeLine(`    ${line}`);
          }
        }
        if (section.truncationReason) {
          const delivery =
            section.truncationReason === PREVIEW_TRUNCATION_REASONS.REFERENCE
              ? PREVIEW_TRUNCATION_REASON_COPY[
                  PREVIEW_TRUNCATION_REASONS.REFERENCE
                ]
              : section.truncationReason ===
                  PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
                ? PREVIEW_TRUNCATION_REASON_COPY[
                    PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
                  ]
                : "the full planned payload remains available to the harness";
          const line = `    [truncated: showing ${includedBytes} of ${section.byteCount} bytes; reason=${section.truncationReason}; ${delivery}]`;
          writeLine(
            section.truncationReason ===
              PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
              ? line
              : chalk.yellow(line)
          );
        }
      }
      for (const mutation of step.workspaceMutations) {
        const mutationPath = mutation.path ? ` ${mutation.path}` : "";
        const warning =
          mutation.scope === PREVIEW_MUTATION_SCOPES.SHARED && mutation.warning
            ? ` — ${mutation.warning}`
            : "";
        writeLine(`  Mutation: ${mutation.operation}${mutationPath}${warning}`);
      }
      writeLine("");
    }
  }

  /**
   * Live streaming state — tracks which block type is currently streaming so we
   * print the THINKING header once and write each chunk directly to stdout as it
   * arrives (typewriter effect), rather than buffering and dumping all at once.
   */
  private static _streaming: {
    type: typeof CLI_EVENT_TYPES.TEXT | typeof CLI_EVENT_TYPES.THINKING;
    label?: string;
    /** Whether the last character written ended with a newline (for TEXT blocks). */
    endsWithNewline: boolean;
  } | null = null;

  /**
   * Close the current streaming block by writing its trailing newline separator.
   * Call this when the prompt completes or when a non-TEXT/THINKING event arrives.
   */
  static flushStreamingBuffer(): void {
    if (!CliTerminalFormatter._streaming) return;
    CliTerminalFormatter._streaming = null;
    // End the block with a blank line separator
    process.stdout.write("\n\n");
  }

  /**
   * Renders an array of CLI events to stdout with chalk formatting.
   */
  static renderEvents(events: CliEvent[]): void {
    for (const event of events) {
      CliTerminalFormatter.renderEvent(event);
    }
  }

  static renderEvent(event: CliEvent): void {
    switch (event.type) {
      case CLI_EVENT_TYPES.TEXT: {
        const data = event.data as TextData;
        if (!data.text) break;
        const s = CliTerminalFormatter._streaming;
        if (!s || s.type !== CLI_EVENT_TYPES.TEXT) {
          // End any prior THINKING block, then start streaming TEXT
          CliTerminalFormatter.flushStreamingBuffer();
          CliTerminalFormatter._streaming = {
            type: CLI_EVENT_TYPES.TEXT,
            endsWithNewline: false,
          };
        }
        process.stdout.write(data.text);
        CliTerminalFormatter._streaming!.endsWithNewline =
          data.text.endsWith("\n");
        break;
      }

      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingBlock;
        if (!data.text) break;
        const label = data.label ?? "Thinking";
        const s = CliTerminalFormatter._streaming;
        if (
          !s ||
          s.type !== CLI_EVENT_TYPES.THINKING ||
          (s.label ?? "Thinking") !== label
        ) {
          // End any prior block, print header once, then start streaming this THINKING block
          CliTerminalFormatter.flushStreamingBuffer();
          process.stdout.write(chalk.dim(`● ${label}\n  `));
          CliTerminalFormatter._streaming = {
            type: CLI_EVENT_TYPES.THINKING,
            label,
            endsWithNewline: false,
          };
        }
        // Indent newlines within the chunk to keep thinking text aligned under the header
        process.stdout.write(chalk.dim(data.text.replace(/\n/g, "\n  ")));
        CliTerminalFormatter._streaming!.endsWithNewline =
          data.text.endsWith("\n");
        break;
      }

      case CLI_EVENT_TYPES.BASH_COMMAND: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as BashCommandData;
        if (data.command) {
          console.log(chalk.yellow("$ " + data.command));
        }
        if (data.output) {
          process.stdout.write(data.output);
          if (!data.output.endsWith("\n")) process.stdout.write("\n");
        }
        if (data.error) {
          process.stdout.write(chalk.red(data.error));
          if (!data.error.endsWith("\n")) process.stdout.write("\n");
        }
        if (data.exitCode !== undefined && data.exitCode !== 0) {
          console.log(chalk.red("✗ exit " + data.exitCode));
        } else if (data.exitCode === 0) {
          console.log(chalk.green("✓"));
        }
        console.log();
        break;
      }

      case CLI_EVENT_TYPES.FILE_EDIT: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as FileEditData;
        if (!data.path) break;
        if (data.status === OPERATION_STATUS.INITIATED) {
          console.log(chalk.dim("  ~ Editing " + data.path + "…"));
        } else if (data.status === OPERATION_STATUS.FAILED) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Edit failed: " + data.path) + errDetail);
          console.log();
        } else {
          console.log(chalk.cyan("~ " + data.path));
          renderDiffBlock(data);
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_WRITE: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as FileWriteData;
        if (!data.path) break;
        if (data.status === OPERATION_STATUS.INITIATED) {
          console.log(chalk.dim("  + Writing " + data.path + "…"));
        } else if (data.status === OPERATION_STATUS.FAILED) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Write failed: " + data.path) + errDetail);
          console.log();
        } else {
          const sizeInfo = data.content
            ? chalk.dim(` (${data.content.length} bytes)`)
            : "";
          console.log(chalk.green("+ " + data.path) + sizeInfo);
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_READ: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as FileReadData;
        if (!data.path) break;
        if (data.status === OPERATION_STATUS.INITIATED) {
          // Skip — too noisy during streaming
        } else if (data.status === OPERATION_STATUS.FAILED) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Read failed: " + data.path) + errDetail);
          console.log();
        } else {
          console.log(chalk.dim("  " + data.path));
        }
        break;
      }

      case CLI_EVENT_TYPES.FILE_DELETE: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as FileDeleteData;
        if (!data.path) break;
        if (data.success === false) {
          const errDetail = data.error ? chalk.dim(" — " + data.error) : "";
          console.log(chalk.red("✗ Delete failed: " + data.path) + errDetail);
        } else {
          console.log(chalk.red("- " + data.path));
        }
        console.log();
        break;
      }

      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as McpToolCallData;
        if (data.server && data.tool) {
          console.log(chalk.magenta("⚙ " + data.server + ":" + data.tool));
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.WEB_SEARCH: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as WebSearchData;
        if (data.query) {
          console.log(chalk.blue('⌕ "' + data.query + '"'));
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.TOOL_CALL: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as ToolCall;
        if (data.name) {
          const params = data.parameters
            ? JSON.stringify(data.parameters).slice(0, 80)
            : "";
          console.log(
            chalk.yellow("⚙ " + data.name) +
              (params ? " " + chalk.dim(params) : "")
          );
          if (data.result) {
            const text = data.result.success
              ? (data.result.output?.substring(0, 100) ?? "Success")
              : (data.result.error?.substring(0, 200) ?? "Failed");
            const color = data.result.success ? chalk.dim : chalk.red;
            console.log(color("  ⎿  " + text));
          }
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.TOOL_RESULT: {
        CliTerminalFormatter.flushStreamingBuffer();
        const data = event.data as ToolResultData;
        if (data.result?.output) {
          const truncated =
            data.result.output.length > 100
              ? data.result.output.slice(0, 100) + "…"
              : data.result.output;
          console.log(chalk.dim("  ⎿  " + truncated));
        }
        break;
      }
    }
  }

  /**
   * Renders the step header (step N/M, prompt preview) or CLI command line.
   * Called twice per attempt: first without cliCommand (show header + prompt),
   * then with cliCommand (show the harness command being run).
   */
  static renderPromptHeader(data: PromptStartData): void {
    const {
      stepIndex,
      totalSteps,
      promptText,
      attemptIndex,
      runIndex,
      cliCommand,
    } = data;

    if (cliCommand !== undefined) {
      // Second fire — print the CLI command with a yellow left border (mirrors border-l-output-command-border)
      const cmdBorder = chalk.yellow("│");
      console.log(`${cmdBorder} ${chalk.dim("$ " + cliCommand)}`);
      console.log();
      return;
    }

    // First fire — print step divider, step label, and a prompt preview
    console.log();
    console.log(chalk.dim("─".repeat(52)));

    // Blue left border mirrors border-l-output-prompt-border in the webview
    const border = chalk.blue("│");

    const executionLabel = [
      runIndex > 0 ? `Re-run ${runIndex}` : "",
      attemptIndex > 0 ? `Retry ${attemptIndex}` : "",
    ]
      .filter((label) => label.length > 0)
      .join(" · ");

    if (executionLabel) {
      console.log(
        `${border} ${chalk.yellow(`${executionLabel} — Step ${stepIndex + 1}/${totalSteps}`)}`
      );
    } else {
      console.log(
        `${border} ${chalk.bold(`Step ${stepIndex + 1}/${totalSteps}`)}`
      );
    }

    // Show up to 5 lines of the prompt as a preview
    const MAX_PREVIEW_LINES = 5;
    const lines = promptText.trimEnd().split("\n");
    const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
    const truncated = lines.length > MAX_PREVIEW_LINES;
    for (const line of previewLines) {
      console.log(`${border} ${chalk.dim(line)}`);
    }
    if (truncated) {
      console.log(`${border} ${chalk.dim("…")}`);
    }
    console.log();
  }

  /**
   * Renders a workflow status message (end condition result, retry notification, etc.)
   * using severity-appropriate chalk colour.
   */
  static renderStatusMessage(message: string, severity: string): void {
    if (severity === STATUS_MESSAGE_SEVERITY.ERROR) {
      // Red left border mirrors border-l-severity-error in the webview
      console.log(`${chalk.red("│")} ${chalk.red("✗ " + message)}`);
    } else if (severity === STATUS_MESSAGE_SEVERITY.WARNING) {
      // Yellow left border mirrors border-l-severity-warning in the webview
      console.log(`${chalk.yellow("│")} ${chalk.yellow("⚠ " + message)}`);
    } else {
      // Cyan left border mirrors border-l-severity-info in the webview
      console.log(`${chalk.cyan("│")} ${chalk.dim("ℹ " + message)}`);
    }
  }

  /**
   * Renders per-prompt statistics (tokens, session ID, elapsed time) to stdout
   * after a prompt completes, mirroring the stats section of the webview's CliOutput component.
   */
  static renderStats(data: PromptCompleteData): void {
    const parts: string[] = [];

    if (data.tokens) {
      const {
        prompt,
        completion,
        cached,
        cacheCreated,
        contextWindowUsed,
        contextWindowSize,
        total: reportedTotal,
        compactionCount,
        cost,
      } = data.tokens;
      const total = resolveTokenTotal(reportedTotal, prompt, completion);
      const totalLabel = formatTokenCount(total);
      const tokenBreakdown = formatTokenBreakdown({
        input: prompt,
        output: completion,
        total: reportedTotal,
        cached,
        cacheCreated,
      });
      const compactionLabel =
        compactionCount !== undefined && compactionCount > 0
          ? `Compacted ${compactionCount}x`
          : undefined;

      if (contextWindowUsed !== undefined && contextWindowSize) {
        const pct = Math.round((contextWindowUsed / contextWindowSize) * 100);
        const contextParts = [
          `Context: ${formatTokenCount(contextWindowUsed)}/${formatTokenCount(contextWindowSize)} (${pct}%)`,
          totalLabel ? `Total: ${totalLabel}` : null,
          data.hideCost || !cost
            ? null
            : `${formatCostLabel(cost.usd)} ${formatCostSourcePhrase([cost.source])}`,
          compactionLabel ?? null,
        ].filter((part): part is string => part !== null);
        parts.push(contextParts.join("  "));
      } else {
        const tokenParts = [
          tokenBreakdown || null,
          data.hideCost || !cost
            ? null
            : `${formatCostLabel(cost.usd)} ${formatCostSourcePhrase([cost.source])}`,
          compactionLabel ?? null,
        ].filter((part): part is string => part !== null);
        if (tokenParts.length > 0) {
          parts.push(tokenParts.join("  "));
        } else if (totalLabel) {
          parts.push(`Total: ${totalLabel}`);
        }
      }
    }

    if (data.sessionId) {
      const harnessLabel = data.harness ? ` (${data.harness})` : "";
      parts.push(`Session${harnessLabel}: ${data.sessionId}`);
    }

    if (data.elapsed !== undefined) {
      parts.push(`${data.elapsed}s`);
    }

    if (parts.length > 0) {
      console.log();
      console.log(chalk.dim(parts.join(" | ")));
    }
  }
}

function formatDiagnosticSeverity(severity: string): string {
  return `[${severity}]`;
}
