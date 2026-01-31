/**
 * FlightPath Dashboard Output Manager Module
 *
 * Manages CLI output display, streaming, export, and section collapse.
 *
 * Exports:
 * - init: Initialize with dependencies
 * - renderAllCliOutputs: Render all outputs in chronological order
 * - handleCliOutput: Handle CLI output message
 * - handleCliStreamingChunk: Handle CLI streaming chunk
 * - handleStatusMessage: Handle status message
 * - handleExportOutput: Export output to markdown
 * - toggleOutputSection: Toggle output section collapse
 * - restoreOutputCollapseState: Restore collapse state from localStorage
 */
(function () {
  // Import constants and utilities from global scope
  const { MESSAGE_TYPES, STEP_STATUS } = window.FlightPathConstants;
  const { getTimestamp, formatTime, escapeHtml } = window.FlightPathUtilities;

  // Dependencies
  let vscode = null;
  let elements = null;
  let stateManager = null;

  /**
   * Initialize output manager with dependencies
   * @param {Object} _vscode - VS Code API instance
   * @param {Object} _elements - DOM elements object
   * @param {Object} _stateManager - State manager instance
   */
  function init(_vscode, _elements, _stateManager) {
    vscode = _vscode;
    elements = _elements;
    stateManager = _stateManager;

    // Set up event listeners
    setupEventListeners();
  }

  /**
   * Set up event listeners for output section
   */
  function setupEventListeners() {
    // Export button
    elements.exportBtn.addEventListener("click", handleExportOutput);

    // Collapse button
    elements.btnCollapseOutput.addEventListener("click", () => {
      toggleOutputSection();
    });
  }

  /**
   * Truncate string to max length with ellipsis
   * @param {string} str - String to truncate
   * @param {number} maxLen - Maximum length
   * @returns {string} Truncated string
   */
  function truncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + "...";
  }

  /**
   * Shorten file path for display
   * @param {string} filePath - File path to shorten
   * @param {number} maxLen - Maximum length
   * @returns {string} Shortened path
   */
  function shortenPath(filePath, maxLen = 50) {
    if (!filePath || filePath.length <= maxLen) return filePath;

    const parts = filePath.split(/[/\\]/);
    if (parts.length <= 2) return filePath;

    // Show "...parent/file.ext"
    return "..." + parts.slice(-2).join("/");
  }

  /**
   * Extract key parameters from tool call for display
   * @param {string} toolName - Name of the tool
   * @param {Object} parameters - Tool parameters
   * @returns {string} Formatted parameter string
   */
  function extractKeyParameters(toolName, parameters) {
    if (!parameters) return "";

    const lowerName = toolName.toLowerCase();

    // Bash/Shell commands
    if (lowerName === "bash" || lowerName === "shell") {
      return truncate(parameters.command, 80);
    }

    // File operations
    if (lowerName === "write" || lowerName === "edit" || lowerName === "read") {
      return shortenPath(parameters.file_path);
    }

    // MultiEdit
    if (lowerName === "multiedit") {
      const fileCount = Array.isArray(parameters.files)
        ? parameters.files.length
        : 1;
      return `${fileCount} file${fileCount !== 1 ? "s" : ""}`;
    }

    // Glob
    if (lowerName === "glob") {
      return parameters.pattern || "";
    }

    // Grep/Search
    if (lowerName === "grep" || lowerName === "search") {
      const pattern = parameters.pattern
        ? `"${truncate(parameters.pattern, 40)}"`
        : "";
      const path = parameters.path
        ? `, path: ${shortenPath(parameters.path)}`
        : "";
      return `${pattern}${path}`;
    }

    // Task
    if (lowerName === "task") {
      return truncate(parameters.description || parameters.prompt || "", 60);
    }

    // Default: show first 2-3 key parameters
    const keys = Object.keys(parameters).slice(0, 3);
    return keys
      .map((k) => `${k}: ${truncate(String(parameters[k]), 30)}`)
      .join(", ");
  }

  /**
   * Format tool call in terminal style: ● ToolName(params)
   * @param {Object} tool - Tool call object
   * @returns {string} Formatted tool call line
   */
  function formatToolCallTerminalStyle(tool) {
    if (!tool || !tool.name) return "";
    const params = extractKeyParameters(tool.name, tool.parameters);
    return `● ${tool.name}(${params})`;
  }

  /**
   * Format tool result in terminal style:   ⎿  Result
   * @param {Object} result - Tool result object
   * @returns {string} Formatted result line
   */
  function formatToolResultTerminalStyle(result) {
    if (!result) return "";

    const prefix = "  ⎿  ";

    // Error case
    if (!result.success && result.error) {
      return prefix + truncate(result.error, 200);
    }

    // Success with output
    if (result.output) {
      return prefix + truncate(result.output, 100);
    }

    // Simple success/failure
    return prefix + (result.success ? "Success" : "Failed");
  }

  /**
   * Render diff from structured patch (unified diff format with accurate line numbers)
   * @param {Array} hunks - Array of unified diff hunks
   * @returns {string} HTML string with diff visualization
   */
  function renderUnifiedDiff(hunks) {
    let html = '<div class="tool-call-diff">';

    hunks.forEach((hunk) => {
      let oldLineNum = hunk.oldStart;
      let newLineNum = hunk.newStart;

      hunk.lines.forEach((line) => {
        const prefix = line[0];
        const content = line.slice(1); // Remove prefix character

        if (prefix === "+") {
          // Added line - only show new line number
          html += '<div class="diff-line added">';
          html += '<span class="line-num old"></span>';
          html += '<span class="line-num new">' + newLineNum + "</span>";
          html += '<span class="line-content">' + escapeHtml(content) + "</span>";
          html += "</div>";
          newLineNum++;
        } else if (prefix === "-") {
          // Removed line - only show old line number
          html += '<div class="diff-line removed">';
          html += '<span class="line-num old">' + oldLineNum + "</span>";
          html += '<span class="line-num new"></span>';
          html += '<span class="line-content">' + escapeHtml(content) + "</span>";
          html += "</div>";
          oldLineNum++;
        } else {
          // Context line (space prefix) - show both line numbers
          html += '<div class="diff-line context">';
          html += '<span class="line-num old">' + oldLineNum + "</span>";
          html += '<span class="line-num new">' + newLineNum + "</span>";
          html += '<span class="line-content">' + escapeHtml(content) + "</span>";
          html += "</div>";
          oldLineNum++;
          newLineNum++;
        }
      });
    });

    html += "</div>";
    return html;
  }

  /**
   * Render diff visualization for Edit operations using proper diff algorithm
   * @param {Object} parameters - Tool parameters with oldContent/newContent fields
   * @returns {string} HTML string with diff visualization
   */
  function renderDiffVisualization(parameters) {
    // Prefer structured patch with accurate line numbers (Claude CLI provides this)
    if (
      parameters.structuredPatch &&
      Array.isArray(parameters.structuredPatch) &&
      parameters.structuredPatch.length > 0
    ) {
      return renderUnifiedDiff(parameters.structuredPatch);
    }

    // Fallback: Generate diff from oldContent/newContent (other providers or when patch unavailable)
    if (!parameters.oldContent || !parameters.newContent) {
      return "";
    }

    // Use the diff library (window.Diff is exposed by diff-bundle.js)
    if (!window.Diff) {
      console.error("Diff library not loaded");
      return "";
    }

    let html = '<div class="tool-call-diff">';

    // Generate line-by-line diff
    const diff = window.Diff.diffLines(
      parameters.oldContent,
      parameters.newContent
    );

    // Track line numbers for old (left) and new (right) files
    // NOTE: These start at 1 because we don't have actual file position data
    let oldLineNum = 1;
    let newLineNum = 1;

    // Render each chunk with line numbers and context
    diff.forEach((part) => {
      const lines = part.value.split("\n");
      // Remove last empty line if it exists (trailing newline artifact)
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }

      lines.forEach((line) => {
        if (part.added) {
          // Added lines (green) - only increment new file line number
          html += '<div class="diff-line added">';
          html += '<span class="line-num old"></span>'; // Empty old line number
          html += '<span class="line-num new">' + newLineNum + "</span>";
          html += '<span class="line-content">' + escapeHtml(line) + "</span>";
          html += "</div>";
          newLineNum++;
        } else if (part.removed) {
          // Removed lines (red) - only increment old file line number
          html += '<div class="diff-line removed">';
          html += '<span class="line-num old">' + oldLineNum + "</span>";
          html += '<span class="line-num new"></span>'; // Empty new line number
          html += '<span class="line-content">' + escapeHtml(line) + "</span>";
          html += "</div>";
          oldLineNum++;
        } else {
          // Unchanged context lines - increment both line numbers
          html += '<div class="diff-line context">';
          html += '<span class="line-num old">' + oldLineNum + "</span>";
          html += '<span class="line-num new">' + newLineNum + "</span>";
          html += '<span class="line-content">' + escapeHtml(line) + "</span>";
          html += "</div>";
          oldLineNum++;
          newLineNum++;
        }
      });
    });

    html += "</div>";
    return html;
  }

  /**
   * Render structured output with events in chronological order
   * @param {Object} output - CLI output object with optional structured field
   * @returns {string} HTML string
   */
  function renderStructuredOutput(output) {
    let html = "";

    // If no structured data, fall back to response text
    if (!output.structured || !output.structured.events) {
      if (output.response) {
        html +=
          '<div class="output-response">' +
          escapeHtml(output.response) +
          "</div>";
      }
      return html;
    }

    // Render events in chronological order
    for (const event of output.structured.events) {
      switch (event.type) {
        case "text":
          // Text events - terminal style with bullet
          if (event.data && event.data.text) {
            html +=
              '<div class="output-text-terminal">' +
              "● " +
              escapeHtml(event.data.text) +
              "</div>\n";
          }
          break;

        case "bashCommand":
          // Bash command execution - show full command (no truncation)
          if (event.data) {
            const status = event.data.status || "unknown";
            const exitCode =
              event.data.exitCode !== undefined ? event.data.exitCode : "?";
            const success = exitCode === 0;

            html += '<div class="output-tool-call-terminal">';
            html += '<div class="tool-call-line">';
            html += "● " + escapeHtml(event.data.command);
            html +=
              ' <span class="status-badge ' +
              (success ? "success" : "error") +
              '">';
            html += status + " (exit: " + exitCode + ")";
            html += "</span></div>";

            // Show output if available
            if (event.data.output) {
              html += '<div class="tool-output">';
              html += "<pre>" + escapeHtml(event.data.output) + "</pre>";
              html += "</div>";
            }

            // Show error if available
            if (event.data.error) {
              html += '<div class="tool-error">';
              html += "<pre>" + escapeHtml(event.data.error) + "</pre>";
              html += "</div>";
            }

            html += "</div>\n";
          }
          break;

        case "fileEdit":
          // File edit operation - show diff visualization
          if (event.data) {
            html += '<div class="output-tool-call-terminal">';

            // If changes array exists (Codex format)
            if (event.data.changes && event.data.changes.length > 0) {
              for (const change of event.data.changes) {
                html += '<div class="tool-call-line">';
                html +=
                  "● File " + change.kind + ": " + escapeHtml(change.path);
                html += "</div>";

                // Show diff if old/new content available
                if (change.oldContent && change.newContent) {
                  html += renderDiffVisualization(change);
                }
              }
            }
            // Single file edit (Claude/Copilot format)
            else if (event.data.path) {
              html += '<div class="tool-call-line">';
              html += "● Edit file: " + escapeHtml(event.data.path);
              html += "</div>";

              if (event.data.oldContent && event.data.newContent) {
                html += renderDiffVisualization(event.data);
              }
            }

            html += "</div>\n";
          }
          break;

        case "fileWrite":
          // File write operation
          if (event.data) {
            html += '<div class="output-tool-call-terminal">';
            html += '<div class="tool-call-line">';
            html += "● Write file: " + escapeHtml(event.data.path);
            if (event.data.content) {
              html += " (" + event.data.content.length + " bytes)";
            }
            html += "</div>";
            html += "</div>\n";
          }
          break;

        case "fileRead":
          // File read operation
          if (event.data) {
            html += '<div class="output-tool-call-terminal">';
            html += '<div class="tool-call-line">';
            html += "● Read file: " + escapeHtml(event.data.path);
            html += "</div>";
            html += "</div>\n";
          }
          break;

        case "fileDelete":
          // File delete operation
          if (event.data) {
            html += '<div class="output-tool-call-terminal">';
            html += '<div class="tool-call-line">';
            html += "● Delete file: " + escapeHtml(event.data.path);
            html += "</div>";
            html += "</div>\n";
          }
          break;

        case "mcpToolCall":
          // MCP tool call
          if (event.data) {
            html += '<div class="output-tool-call-terminal">';
            html += '<div class="tool-call-line">';
            html +=
              "● MCP: " +
              escapeHtml(event.data.server) +
              "." +
              escapeHtml(event.data.tool);
            html += "</div>";
            html += "</div>\n";
          }
          break;

        case "webSearch":
          // Web search operation
          if (event.data) {
            html += '<div class="output-tool-call-terminal">';
            html += '<div class="tool-call-line">';
            html += '● Web search: "' + escapeHtml(event.data.query) + '"';
            html += "</div>";
            html += "</div>\n";
          }
          break;

        case "toolCall":
          // Generic tool call (fallback for unrecognized tools)
          if (event.data) {
            const toolLine = formatToolCallTerminalStyle(event.data);

            html += '<div class="output-tool-call-terminal">';
            html +=
              '<div class="tool-call-line">' + escapeHtml(toolLine) + "</div>";

            // Add result if available
            if (event.data.result) {
              const resultLine = formatToolResultTerminalStyle(
                event.data.result
              );
              const resultClass = event.data.result.success ? "" : " error";
              html +=
                '<div class="tool-result-line' +
                resultClass +
                '">' +
                escapeHtml(resultLine) +
                "</div>";
            }

            html += "</div>\n";
          }
          break;

        case "thinking":
          // Thinking block events - terminal style
          if (event.data && event.data.text) {
            const label =
              event.data.label && event.data.label !== "Thinking"
                ? event.data.label
                : "Thinking";

            html += '<div class="output-text-terminal">';
            html +=
              "● " + escapeHtml(label) + ": " + escapeHtml(event.data.text);
            html += "</div>\n";
          }
          break;

        case "toolResult":
          // Tool result events (if separate from toolCall)
          if (event.data && event.data.result) {
            const resultLine = formatToolResultTerminalStyle(event.data.result);
            const resultClass = event.data.result.success ? "" : " error";
            html +=
              '<div class="tool-result-line' +
              resultClass +
              '">' +
              escapeHtml(resultLine) +
              "</div>\n";
          }
          break;
      }
    }

    return html;
  }

  /**
   * Render all CLI outputs in chronological order
   */
  function renderAllCliOutputs() {
    const state = stateManager.getState();

    // Build a combined array of ALL messages from ALL steps with timestamps for chronological sorting
    const allMessages = [];

    // Iterate through all steps and collect all messages
    for (let stepIndex = 0; stepIndex < state.totalSteps; stepIndex++) {
      const outputs = state.cliOutputs[stepIndex] || [];
      const statusMessages = state.statusMessages[stepIndex] || [];

      // Add status messages with their timestamps
      statusMessages.forEach((statusMsg, index) => {
        allMessages.push({
          type: "status",
          stepIndex,
          timestamp: statusMsg.timestampMs || stepIndex * 10000 + index,
          data: statusMsg,
        });
      });

      // Add CLI outputs with their timestamps
      outputs.forEach((output, attemptIndex) => {
        allMessages.push({
          type: "copilot-cli",
          stepIndex,
          timestamp:
            output.timestampMs ||
            stepIndex * 10000 + statusMessages.length + attemptIndex,
          data: output,
          attemptIndex,
        });
      });
    }

    if (allMessages.length === 0) {
      // Show empty state
      elements.outputContent.innerHTML =
        '<p class="empty-state">Output will appear here during execution</p>';
      return;
    }

    // Sort by timestamp to get chronological order
    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Render all messages in chronological order
    let html = "";

    allMessages.forEach((item) => {
      if (item.type === "status") {
        const statusMsg = item.data;
        const severityClass = statusMsg.severity
          ? `status-${statusMsg.severity}`
          : "status-info";
        html += `<div class="status-message ${severityClass}">`;
        html += `<span class="status-time">[${statusMsg.timestamp}]</span> `;
        html += `<span class="status-text">${escapeHtml(statusMsg.message)}</span>`;
        html += "</div>";
      } else if (item.type === "copilot-cli") {
        const output = item.data;
        const attemptIndex = item.attemptIndex;
        const stepIndex = item.stepIndex;
        const attemptLabel =
          attemptIndex === 0 ? "Initial Attempt" : `Retry ${attemptIndex}`;
        const streamingIndicator = output.isStreaming
          ? ' <span style="color: #4ec9b0;">⬤ Streaming...</span>'
          : "";

        html += '<div class="cli-output-item">';
        html += `<div class="output-header">[Prompt ${stepIndex + 1}] ${attemptLabel}${streamingIndicator}</div>`;

        if (output.prompt) {
          html += `<div class="output-prompt">${escapeHtml(output.prompt)}</div>`;
        }

        if (output.cliCommand) {
          // Format command with working directory prefix (terminal-style)
          // Use the full workspace path if available, otherwise fallback to 'workspace'
          const workingDir = output.workingDirectory || "workspace";
          html += `<div class="output-cli-command">${escapeHtml(workingDir)}> ${escapeHtml(output.cliCommand)}</div>`;
        }

        // Render response (and structured data if available)
        html += renderStructuredOutput(output);

        if (output.tokens) {
          const total = output.tokens.prompt + output.tokens.completion;
          html += `<div class="output-stats">Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion / ${total} total</div>`;
        }

        if (!output.isStreaming && output.elapsed !== undefined) {
          html += `<div class="output-stats">${output.elapsed}s</div>`;
        }

        html += "</div>";
      }
    });

    elements.outputContent.innerHTML = html;

    // Auto-scroll to bottom if autoscroll is enabled and there's streaming or new content
    if (elements.autoscrollCheckbox.checked) {
      elements.outputContent.scrollTop = elements.outputContent.scrollHeight;
    }
  }

  /**
   * Handle CLI output message
   * @param {number} stepIndex - Step index
   * @param {Object} output - CLI output object
   */
  function handleCliOutput(stepIndex, output) {
    console.log(
      "📊 Dashboard: Received CLI output for step",
      stepIndex,
      "isStreaming:",
      output.isStreaming,
      "hasStructured:",
      !!output.structured,
      "eventCount:",
      output.structured?.events?.length || 0,
      "outputCount before:",
      (stateManager.getState().cliOutputs[stepIndex] || []).length
    );

    const state = stateManager.getState();

    // Initialize array for this step if needed
    if (!state.cliOutputs[stepIndex]) {
      state.cliOutputs[stepIndex] = [];
    }

    // Add timestamp to output if not present
    if (!output.timestampMs) {
      output.timestampMs = getTimestamp();
    }

    const outputs = state.cliOutputs[stepIndex];

    // Log current state
    if (outputs.length > 0) {
      console.log(
        "📊 Dashboard: Last output isStreaming:",
        outputs[outputs.length - 1].isStreaming,
        "response length:",
        outputs[outputs.length - 1].response?.length || 0
      );
    }

    // If the last entry is a streaming placeholder and this is the final version
    if (outputs.length > 0 && outputs[outputs.length - 1].isStreaming) {
      const streamingEntry = outputs[outputs.length - 1];

      // If the streaming entry has accumulated content, decide whether to preserve it
      if (streamingEntry.response && streamingEntry.response.length > 0) {
        // If the final output has structured data, REPLACE the streamed text
        // The structured events contain all the information in a better format
        if (
          output.structured &&
          output.structured.events &&
          output.structured.events.length > 0
        ) {
          console.log(
            "📊 Dashboard: Replacing streamed text (" +
              streamingEntry.response.length +
              " chars) with structured output (" +
              output.structured.events.length +
              " events)"
          );
          outputs[outputs.length - 1] = output; // Use final output with structured data
        } else {
          // No structured output - preserve the streamed response
          console.log(
            "📊 Dashboard: Preserving streamed response (" +
              streamingEntry.response.length +
              " chars), no structured data available"
          );
          outputs[outputs.length - 1] = {
            ...output,
            response: streamingEntry.response, // Keep streamed content!
            timestampMs: streamingEntry.timestampMs, // Keep original timestamp
          };
        }
      } else {
        // No streamed content, use the final output as-is
        console.log(
          "📊 Dashboard: No streamed content, replacing with final output"
        );
        outputs[outputs.length - 1] = output;
      }
    } else {
      console.log("📊 Dashboard: Appending new output (initial or retry)");
      outputs.push(output);
    }

    console.log("📊 Dashboard: outputCount after:", outputs.length);

    // Update state (shallow copy to trigger updates if needed)
    stateManager.updateState({ cliOutputs: state.cliOutputs });

    // Always render to show all accumulated outputs
    renderAllCliOutputs();
  }

  /**
   * Handle CLI streaming chunk (plain text - Copilot CLI)
   * @param {number} stepIndex - Step index
   * @param {string} chunk - Streaming chunk
   */
  function handleCliStreamingChunk(stepIndex, chunk) {
    console.log(
      `🔍 Dashboard.handleCliStreamingChunk: stepIndex=${stepIndex}, chunk length=${chunk.length}, content (first 100): ${JSON.stringify(chunk.substring(0, 100))}`
    );

    const state = stateManager.getState();

    // Initialize array if needed
    if (!state.cliOutputs[stepIndex]) {
      state.cliOutputs[stepIndex] = [];
    }

    const outputs = state.cliOutputs[stepIndex];

    // Initialize streaming buffer if needed
    if (outputs.length === 0 || !outputs[outputs.length - 1].isStreaming) {
      console.log(
        "🔍 Dashboard.handleCliStreamingChunk: Creating new streaming buffer"
      );
      outputs.push({
        prompt: "",
        response: "",
        elapsed: 0,
        tokens: null,
        isStreaming: true,
        timestampMs: getTimestamp(),
      });
    }

    // Append chunk to the last (streaming) output's response
    outputs[outputs.length - 1].response += chunk;
    console.log(
      `🔍 Dashboard.handleCliStreamingChunk: Total response length now: ${outputs[outputs.length - 1].response.length}`
    );

    // Update state (shallow copy to trigger updates if needed)
    stateManager.updateState({ cliOutputs: state.cliOutputs });

    // Always render to show streaming updates
    renderAllCliOutputs();
  }

  /**
   * Handle CLI streaming events (structured - Claude/Codex CLI)
   * @param {number} stepIndex - Step index
   * @param {Array} events - Array of CliEvent objects
   */
  function handleCliStreamingEvents(stepIndex, events) {
    console.log(
      `🔍 Dashboard.handleCliStreamingEvents: stepIndex=${stepIndex}, event count=${events.length}`
    );

    const state = stateManager.getState();

    // Initialize array if needed
    if (!state.cliOutputs[stepIndex]) {
      state.cliOutputs[stepIndex] = [];
    }

    const outputs = state.cliOutputs[stepIndex];

    // Initialize streaming buffer with structured field if needed
    if (outputs.length === 0 || !outputs[outputs.length - 1].isStreaming) {
      console.log(
        "🔍 Dashboard.handleCliStreamingEvents: Creating new structured streaming buffer"
      );
      outputs.push({
        prompt: "",
        response: "",
        structured: { events: [] }, // Initialize structured events array
        elapsed: 0,
        tokens: null,
        isStreaming: true,
        timestampMs: getTimestamp(),
      });
    }

    // Ensure structured field exists
    if (!outputs[outputs.length - 1].structured) {
      outputs[outputs.length - 1].structured = { events: [] };
    }

    // Append events to the structured events array
    outputs[outputs.length - 1].structured.events.push(...events);
    console.log(
      `🔍 Dashboard.handleCliStreamingEvents: Total event count now: ${outputs[outputs.length - 1].structured.events.length}`
    );

    // Update state (shallow copy to trigger updates if needed)
    stateManager.updateState({ cliOutputs: state.cliOutputs });

    // Always render to show streaming updates with terminal-style formatting
    renderAllCliOutputs();
  }

  /**
   * Handle status message
   * @param {Object} messageData - Status message data
   */
  function handleStatusMessage(messageData) {
    const stepIndex = messageData.stepIndex;
    console.log(
      "📝 Dashboard: Received status message for step",
      stepIndex,
      messageData
    );

    const state = stateManager.getState();

    // Initialize array for this step if needed
    if (!state.statusMessages[stepIndex]) {
      state.statusMessages[stepIndex] = [];
    }

    // Add status message with timestamp and severity
    const timestampMs = getTimestamp();

    state.statusMessages[stepIndex].push({
      message: messageData.message,
      timestamp: formatTime(timestampMs),
      timestampMs,
      severity: messageData.severity || "info",
    });

    // Update state (shallow copy to trigger updates if needed)
    stateManager.updateState({ statusMessages: state.statusMessages });

    // Always render to show all accumulated messages
    renderAllCliOutputs();
  }

  /**
   * Format structured patch for markdown export (unified diff format with accurate line numbers)
   * @param {Array} hunks - Array of unified diff hunks
   * @returns {string[]} Array of markdown diff lines
   */
  function formatStructuredPatchForMarkdown(hunks) {
    const diffLines = [];

    hunks.forEach((hunk) => {
      let oldLineNum = hunk.oldStart;
      let newLineNum = hunk.newStart;

      hunk.lines.forEach((line) => {
        const prefix = line[0];
        const content = line.slice(1); // Remove prefix

        if (prefix === "+") {
          // Added line - show new line number
          diffLines.push(`+${String(newLineNum).padStart(4)} | ${content}`);
          newLineNum++;
        } else if (prefix === "-") {
          // Removed line - show old line number
          diffLines.push(`-${String(oldLineNum).padStart(4)} | ${content}`);
          oldLineNum++;
        } else {
          // Context line - show both line numbers (old file)
          diffLines.push(` ${String(oldLineNum).padStart(4)} | ${content}`);
          oldLineNum++;
          newLineNum++;
        }
      });
    });

    return diffLines;
  }

  /**
   * Format diff for markdown export with line numbers and context
   * @param {string} oldContent - Original content
   * @param {string} newContent - New content
   * @param {Array} [structuredPatch] - Optional structured patch with accurate line numbers
   * @returns {string[]} Array of markdown diff lines
   */
  function formatDiffForMarkdown(oldContent, newContent, structuredPatch) {
    // Prefer structured patch with accurate line numbers
    if (
      structuredPatch &&
      Array.isArray(structuredPatch) &&
      structuredPatch.length > 0
    ) {
      return formatStructuredPatchForMarkdown(structuredPatch);
    }

    // Fallback: Generate diff from content
    const diffLines = [];

    if (!window.Diff) {
      return diffLines;
    }

    const diff = window.Diff.diffLines(oldContent, newContent);

    // NOTE: Line numbers start at 1 because we don't have actual file position data
    let oldLineNum = 1;
    let newLineNum = 1;

    diff.forEach((part) => {
      const lines = part.value.split("\n");
      // Remove last empty line if it exists
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }

      lines.forEach((line) => {
        if (part.added) {
          // Added line - show new line number
          diffLines.push(`+${String(newLineNum).padStart(4)} | ${line}`);
          newLineNum++;
        } else if (part.removed) {
          // Removed line - show old line number
          diffLines.push(`-${String(oldLineNum).padStart(4)} | ${line}`);
          oldLineNum++;
        } else {
          // Context line - show both line numbers
          diffLines.push(` ${String(oldLineNum).padStart(4)} | ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      });
    });

    return diffLines;
  }

  /**
   * Generate markdown-formatted output for export
   * @returns {string} Markdown content
   */
  function generateMarkdownOutput() {
    const state = stateManager.getState();
    const lines = [];
    const timestamp = new Date().toISOString();

    // Header
    lines.push("# FlightPath Execution Output");
    lines.push("");
    lines.push(`**File:** ${state.fileName || "Unknown"}`);
    lines.push(`**Exported:** ${timestamp}`);
    lines.push(`**Status:** ${state.executionState}`);
    lines.push(
      `**Progress:** ${state.currentStep} of ${state.totalSteps} completed`
    );
    lines.push("");
    lines.push("---");
    lines.push("");

    // Build chronological message list (same logic as renderAllCliOutputs)
    const allMessages = [];

    for (let stepIndex = 0; stepIndex < state.totalSteps; stepIndex++) {
      const outputs = state.cliOutputs[stepIndex] || [];
      const statusMessages = state.statusMessages[stepIndex] || [];

      statusMessages.forEach((statusMsg, index) => {
        allMessages.push({
          type: "status",
          stepIndex,
          timestamp: statusMsg.timestampMs || stepIndex * 10000 + index,
          data: statusMsg,
        });
      });

      outputs.forEach((output, attemptIndex) => {
        allMessages.push({
          type: "copilot-cli",
          stepIndex,
          timestamp:
            output.timestampMs ||
            stepIndex * 10000 + statusMessages.length + attemptIndex,
          data: output,
          attemptIndex,
        });
      });
    }

    // Sort by timestamp
    allMessages.sort((a, b) => a.timestamp - b.timestamp);

    if (allMessages.length === 0) {
      lines.push("*No output captured*");
      return lines.join("\n");
    }

    // Render each message
    allMessages.forEach((item) => {
      if (item.type === "status") {
        const statusMsg = item.data;
        lines.push(`> **[${statusMsg.timestamp}]** ${statusMsg.message}`);
        lines.push("");
      } else if (item.type === "copilot-cli") {
        const output = item.data;
        const attemptIndex = item.attemptIndex;
        const stepIndex = item.stepIndex;
        const attemptLabel =
          attemptIndex === 0 ? "Initial Attempt" : `Retry ${attemptIndex}`;

        lines.push(`## Prompt ${stepIndex + 1} - ${attemptLabel}`);
        lines.push("");

        if (output.prompt) {
          lines.push("### Prompt");
          lines.push("");
          lines.push("```");
          lines.push(output.prompt);
          lines.push("```");
          lines.push("");
        }

        if (output.cliCommand) {
          lines.push("### CLI Command");
          lines.push("");
          lines.push("```bash");
          // Format command with working directory prefix (terminal-style)
          // Use the full workspace path if available, otherwise fallback to 'workspace'
          const workingDir = output.workingDirectory || "workspace";
          lines.push(`${workingDir}> ${output.cliCommand}`);
          lines.push("```");
          lines.push("");
        }

        // Export events in chronological order - terminal style
        if (output.structured?.events && output.structured.events.length > 0) {
          lines.push("### Response");
          lines.push("");

          output.structured.events.forEach((event) => {
            switch (event.type) {
              case "text":
                // Text events - terminal style with bullet
                if (event.data && event.data.text) {
                  lines.push("● " + event.data.text);
                  lines.push("");
                }
                break;

              case "bashCommand":
                // Bash command execution - show full command
                if (event.data) {
                  const status = event.data.status || "unknown";
                  const exitCode =
                    event.data.exitCode !== undefined
                      ? event.data.exitCode
                      : "?";
                  lines.push(
                    `● ${event.data.command} (${status}, exit: ${exitCode})`
                  );

                  if (event.data.output) {
                    lines.push("");
                    lines.push("```");
                    lines.push(event.data.output.trim());
                    lines.push("```");
                  }

                  if (event.data.error) {
                    lines.push("");
                    lines.push("Error:");
                    lines.push("```");
                    lines.push(event.data.error.trim());
                    lines.push("```");
                  }
                  lines.push("");
                }
                break;

              case "fileEdit":
                // File edit operation - show diff
                if (event.data) {
                  if (event.data.changes && event.data.changes.length > 0) {
                    event.data.changes.forEach((change) => {
                      lines.push(`● File ${change.kind}: ${change.path}`);

                      if (change.oldContent && change.newContent) {
                        lines.push("");
                        lines.push("```diff");
                        const diffLines = formatDiffForMarkdown(
                          change.oldContent,
                          change.newContent,
                          change.structuredPatch
                        );
                        diffLines.forEach((line) => lines.push(line));
                        lines.push("```");
                      }
                      lines.push("");
                    });
                  } else if (event.data.path) {
                    lines.push(`● Edit file: ${event.data.path}`);

                    if (event.data.oldContent && event.data.newContent) {
                      lines.push("");
                      lines.push("```diff");
                      const diffLines = formatDiffForMarkdown(
                        event.data.oldContent,
                        event.data.newContent,
                        event.data.structuredPatch
                      );
                      diffLines.forEach((line) => lines.push(line));
                      lines.push("```");
                    }
                    lines.push("");
                  }
                }
                break;

              case "fileWrite":
                if (event.data) {
                  lines.push(`● Write file: ${event.data.path}`);
                  if (event.data.content) {
                    lines.push(` (${event.data.content.length} bytes)`);
                  }
                  lines.push("");
                }
                break;

              case "fileRead":
                if (event.data) {
                  lines.push(`● Read file: ${event.data.path}`);
                  lines.push("");
                }
                break;

              case "fileDelete":
                if (event.data) {
                  lines.push(`● Delete file: ${event.data.path}`);
                  lines.push("");
                }
                break;

              case "mcpToolCall":
                if (event.data) {
                  lines.push(`● MCP: ${event.data.server}.${event.data.tool}`);
                  lines.push("");
                }
                break;

              case "webSearch":
                if (event.data) {
                  lines.push(`● Web search: "${event.data.query}"`);
                  lines.push("");
                }
                break;

              case "toolCall":
                // Generic tool call (fallback)
                if (event.data) {
                  const toolLine = formatToolCallTerminalStyle(event.data);
                  lines.push(toolLine);

                  if (event.data.result) {
                    const resultLine = formatToolResultTerminalStyle(
                      event.data.result
                    );
                    lines.push(resultLine);
                  }
                  lines.push("");
                }
                break;

              case "thinking":
                // Thinking block events - terminal style
                if (event.data && event.data.text) {
                  const label =
                    event.data.label && event.data.label !== "Thinking"
                      ? event.data.label
                      : "Thinking";
                  lines.push("● " + label + ": " + event.data.text);
                  lines.push("");
                }
                break;

              case "toolResult":
                // Tool result events (if separate from toolCall)
                if (event.data && event.data.result) {
                  const resultLine = formatToolResultTerminalStyle(
                    event.data.result
                  );
                  lines.push(resultLine);
                  lines.push("");
                }
                break;
            }
          });
        } else if (output.response) {
          // Fallback for old format without events
          lines.push("### Response");
          lines.push("");
          lines.push("```");
          lines.push(output.response);
          lines.push("```");
          lines.push("");
        }

        // Stats section
        const stats = [];
        if (output.tokens) {
          const total = output.tokens.prompt + output.tokens.completion;
          stats.push(
            `Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion / ${total} total`
          );
        }
        if (output.elapsed !== undefined) {
          stats.push(`${output.elapsed}s`);
        }

        if (stats.length > 0) {
          lines.push(`*${stats.join(" | ")}*`);
          lines.push("");
        }

        lines.push("---");
        lines.push("");
      }
    });

    return lines.join("\n");
  }

  /**
   * Handle export output button click
   */
  function handleExportOutput() {
    const state = stateManager.getState();
    const markdownContent = generateMarkdownOutput();
    vscode.postMessage({
      type: MESSAGE_TYPES.EXPORT_OUTPUT,
      content: markdownContent,
      fileName: state.fileName,
    });
  }

  /**
   * Toggle output section collapse
   */
  function toggleOutputSection() {
    const storageKey = "flightpath.section.output.collapsed";

    // Toggle collapsed class
    const isCollapsed = elements.outputSection.classList.toggle("collapsed");

    // Save state to localStorage
    try {
      localStorage.setItem(storageKey, isCollapsed.toString());
    } catch (error) {
      console.warn("Failed to save output collapse state:", error);
    }

    // Update button title
    elements.btnCollapseOutput.title = isCollapsed
      ? "Expand output section"
      : "Collapse output section";
    elements.btnCollapseOutput.setAttribute(
      "aria-label",
      isCollapsed ? "Expand output" : "Collapse output"
    );
  }

  /**
   * Restore output section collapse state from localStorage
   */
  function restoreOutputCollapseState() {
    try {
      const outputCollapsed =
        localStorage.getItem("flightpath.section.output.collapsed") === "true";
      if (outputCollapsed) {
        elements.outputSection.classList.add("collapsed");
        elements.btnCollapseOutput.title = "Expand output section";
        elements.btnCollapseOutput.setAttribute("aria-label", "Expand output");
      }
    } catch (error) {
      console.warn("Failed to restore output collapse state:", error);
    }
  }

  // Export public API to global scope
  window.FlightPathOutputManager = {
    init,
    renderAllCliOutputs,
    handleCliOutput,
    handleCliStreamingChunk,
    handleCliStreamingEvents,
    handleStatusMessage,
    handleExportOutput,
    toggleOutputSection,
    restoreOutputCollapseState,
  };
})();
