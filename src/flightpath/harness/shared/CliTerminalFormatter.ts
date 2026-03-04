import chalk from "chalk";
import * as Diff from "diff";
import type { CliEvent } from "../../../types/CliOutputTypes";
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
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "../../../types/DashboardConstants";
import type { PromptCompleteData } from "../../WorkflowInstance";

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
    console.log(chalk.dim(`  … ${remaining} more line${remaining !== 1 ? "s" : ""}`));
  }
}

// ---- Main formatter ----

/**
 * Chalk-based terminal renderer for CliEvent arrays.
 * Used by the standalone flightpath CLI to stream structured output to stdout.
 */
export class CliTerminalFormatter {
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
        if (data.text) {
          process.stdout.write(data.text);
          if (!data.text.endsWith("\n")) process.stdout.write("\n");
          process.stdout.write("\n");
        }
        break;
      }

      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingBlock;
        if (data.text) {
          const label = data.label ?? "Thinking";
          console.log(chalk.dim(`● ${label}`));
          console.log(chalk.dim("  " + data.text.split("\n").join("\n  ")));
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.BASH_COMMAND: {
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
        const data = event.data as McpToolCallData;
        if (data.server && data.tool) {
          console.log(chalk.magenta("⚙ " + data.server + ":" + data.tool));
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as WebSearchData;
        if (data.query) {
          console.log(chalk.blue('⌕ "' + data.query + '"'));
          console.log();
        }
        break;
      }

      case CLI_EVENT_TYPES.TOOL_CALL: {
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
      } = data.tokens;
      const total = prompt + completion;
      const fmt = (n: number) =>
        n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

      const tokenDetail = [
        `Tokens: ${fmt(prompt)} in / ${fmt(completion)} out / ${fmt(total)} total`,
        ...(cached ? [`${fmt(cached)} cached`] : []),
        ...(cacheCreated ? [`${fmt(cacheCreated)} cache-created`] : []),
      ].join(", ");

      if (contextWindowUsed !== undefined && contextWindowSize) {
        const pct = Math.round((contextWindowUsed / contextWindowSize) * 100);
        parts.push(
          `Context: ${fmt(contextWindowUsed)}/${fmt(contextWindowSize)} (${pct}%)  [${tokenDetail}]`
        );
      } else {
        parts.push(tokenDetail);
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
