import chalk from "chalk";
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
} from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import type { PromptCompleteData } from "../../WorkflowInstance";

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
        }
        break;
      }
      case CLI_EVENT_TYPES.THINKING: {
        const data = event.data as ThinkingBlock;
        if (data.text) {
          const label = data.label ?? "Thinking";
          console.log(chalk.dim(`● ${label}`));
          console.log(chalk.dim("  " + data.text.split("\n").join("\n  ")));
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
        }
        if (data.exitCode !== undefined && data.exitCode !== 0) {
          console.log(chalk.red("✗ exit " + data.exitCode));
        } else if (data.exitCode === 0) {
          console.log(chalk.green("✓"));
        }
        break;
      }
      case CLI_EVENT_TYPES.FILE_EDIT: {
        const data = event.data as FileEditData;
        if (data.path) {
          console.log(chalk.cyan("~ " + data.path));
        }
        break;
      }
      case CLI_EVENT_TYPES.FILE_WRITE: {
        const data = event.data as FileWriteData;
        if (data.path) {
          console.log(chalk.green("+ " + data.path));
        }
        break;
      }
      case CLI_EVENT_TYPES.FILE_READ: {
        const data = event.data as FileReadData;
        if (data.path) {
          console.log(chalk.dim("  " + data.path));
        }
        break;
      }
      case CLI_EVENT_TYPES.FILE_DELETE: {
        const data = event.data as FileDeleteData;
        if (data.path) {
          console.log(chalk.red("- " + data.path));
        }
        break;
      }
      case CLI_EVENT_TYPES.MCP_TOOL_CALL: {
        const data = event.data as McpToolCallData;
        if (data.server && data.tool) {
          console.log(chalk.magenta("⚙ " + data.server + ":" + data.tool));
        }
        break;
      }
      case CLI_EVENT_TYPES.WEB_SEARCH: {
        const data = event.data as WebSearchData;
        if (data.query) {
          console.log(chalk.blue("⌕ " + data.query));
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
      console.log(chalk.dim(parts.join(" | ")));
    }
  }
}
