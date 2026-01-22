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
    return str.substring(0, maxLen - 3) + '...';
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
    return '...' + parts.slice(-2).join('/');
  }

  /**
   * Extract key parameters from tool call for display
   * @param {string} toolName - Name of the tool
   * @param {Object} parameters - Tool parameters
   * @returns {string} Formatted parameter string
   */
  function extractKeyParameters(toolName, parameters) {
    if (!parameters) return '';

    const lowerName = toolName.toLowerCase();

    // Bash/Shell commands
    if (lowerName === 'bash' || lowerName === 'shell') {
      return truncate(parameters.command, 80);
    }

    // File operations
    if (lowerName === 'write' || lowerName === 'edit' || lowerName === 'read') {
      return shortenPath(parameters.file_path);
    }

    // MultiEdit
    if (lowerName === 'multiedit') {
      const fileCount = Array.isArray(parameters.files) ? parameters.files.length : 1;
      return `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    }

    // Glob
    if (lowerName === 'glob') {
      return parameters.pattern || '';
    }

    // Grep/Search
    if (lowerName === 'grep' || lowerName === 'search') {
      const pattern = parameters.pattern ? `"${truncate(parameters.pattern, 40)}"` : '';
      const path = parameters.path ? `, path: ${shortenPath(parameters.path)}` : '';
      return `${pattern}${path}`;
    }

    // Task
    if (lowerName === 'task') {
      return truncate(parameters.description || parameters.prompt || '', 60);
    }

    // Default: show first 2-3 key parameters
    const keys = Object.keys(parameters).slice(0, 3);
    return keys.map(k => `${k}: ${truncate(String(parameters[k]), 30)}`).join(', ');
  }

  /**
   * Format tool call in terminal style: ● ToolName(params)
   * @param {Object} tool - Tool call object
   * @returns {string} Formatted tool call line
   */
  function formatToolCallTerminalStyle(tool) {
    if (!tool || !tool.name) return '';
    const params = extractKeyParameters(tool.name, tool.parameters);
    return `● ${tool.name}(${params})`;
  }

  /**
   * Format tool result in terminal style:   ⎿  Result
   * @param {Object} result - Tool result object
   * @returns {string} Formatted result line
   */
  function formatToolResultTerminalStyle(result) {
    if (!result) return '';

    const prefix = '  ⎿  ';

    // Error case
    if (!result.success && result.error) {
      return prefix + truncate(result.error, 200);
    }

    // Success with output
    if (result.output) {
      return prefix + truncate(result.output, 100);
    }

    // Simple success/failure
    return prefix + (result.success ? 'Success' : 'Failed');
  }

  /**
   * Render diff visualization for Edit operations using proper diff algorithm
   * @param {Object} parameters - Tool parameters
   * @returns {string} HTML string with diff visualization
   */
  function renderDiffVisualization(parameters) {
    if (!parameters.old_string || !parameters.new_string) {
      return '';
    }

    // Use the diff library (window.Diff is exposed by diff-bundle.js)
    if (!window.Diff) {
      console.error('Diff library not loaded');
      return '';
    }

    let html = '<div class="tool-call-diff">';

    // Generate line-by-line diff
    const diff = window.Diff.diffLines(parameters.old_string, parameters.new_string);

    // Render each chunk
    diff.forEach((part) => {
      if (part.added) {
        // Added lines (green)
        part.value.split('\n').forEach((line, index, array) => {
          // Skip the last empty line if it exists
          if (index === array.length - 1 && line === '') return;
          html += '<div class="diff-line added">' + escapeHtml(line) + "</div>";
        });
      } else if (part.removed) {
        // Removed lines (red)
        part.value.split('\n').forEach((line, index, array) => {
          // Skip the last empty line if it exists
          if (index === array.length - 1 && line === '') return;
          html += '<div class="diff-line removed">' + escapeHtml(line) + "</div>";
        });
      }
      // Unchanged lines are not rendered (part.added === false && part.removed === false)
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
              '● ' + escapeHtml(event.data.text) +
              "</div>\n";
          }
          break;

        case "toolCall":
          // Tool call events - terminal style
          if (event.data) {
            const toolLine = formatToolCallTerminalStyle(event.data);

            html += '<div class="output-tool-call-terminal">';
            html += '<div class="tool-call-line">' + escapeHtml(toolLine) + '</div>';

            // Add diff visualization if available (for Edit operations)
            if (event.data.parameters) {
              html += renderDiffVisualization(event.data.parameters);
            }

            // Add result if available
            if (event.data.result) {
              const resultLine = formatToolResultTerminalStyle(event.data.result);
              const resultClass = event.data.result.success ? '' : ' error';
              html += '<div class="tool-result-line' + resultClass + '">' + escapeHtml(resultLine) + '</div>';
            }

            html += "</div>\n";
          }
          break;

        case "thinking":
          // Thinking block events - terminal style
          if (event.data && event.data.text) {
            const label = (event.data.label && event.data.label !== "Thinking")
              ? event.data.label
              : "Thinking";

            html += '<div class="output-text-terminal">';
            html += '● ' + escapeHtml(label) + ': ' + escapeHtml(event.data.text);
            html += "</div>\n";
          }
          break;

        case "toolResult":
          // Tool result events (if separate from toolCall)
          if (event.data && event.data.result) {
            const resultLine = formatToolResultTerminalStyle(event.data.result);
            const resultClass = event.data.result.success ? '' : ' error';
            html += '<div class="tool-result-line' + resultClass + '">' + escapeHtml(resultLine) + '</div>\n';
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
          html += `<div class="output-cli-command">$ ${escapeHtml(output.cliCommand)}</div>`;
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

      // If the streaming entry has accumulated content, PRESERVE it
      // Only update metadata (elapsed, tokens, isStreaming flag)
      if (streamingEntry.response && streamingEntry.response.length > 0) {
        console.log(
          "📊 Dashboard: Preserving streamed response (" +
            streamingEntry.response.length +
            " chars), updating metadata only"
        );
        // Keep the streamed response, update everything else
        outputs[outputs.length - 1] = {
          ...output,
          response: streamingEntry.response, // Keep streamed content!
          timestampMs: streamingEntry.timestampMs, // Keep original timestamp
        };
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
   * Handle CLI streaming chunk
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
          lines.push(`$ ${output.cliCommand}`);
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
                  lines.push('● ' + event.data.text);
                  lines.push("");
                }
                break;

              case "toolCall":
                // Tool call events - terminal style
                if (event.data) {
                  const toolLine = formatToolCallTerminalStyle(event.data);
                  lines.push(toolLine);

                  // Add diff visualization if available (for Edit operations)
                  if (event.data.parameters && event.data.parameters.old_string && event.data.parameters.new_string && window.Diff) {
                    lines.push("");
                    lines.push("```diff");

                    // Use diff library for proper diff
                    const diff = window.Diff.diffLines(event.data.parameters.old_string, event.data.parameters.new_string);
                    diff.forEach((part) => {
                      if (part.added) {
                        part.value.split('\n').forEach((line, index, array) => {
                          if (index === array.length - 1 && line === '') return;
                          lines.push("+ " + line);
                        });
                      } else if (part.removed) {
                        part.value.split('\n').forEach((line, index, array) => {
                          if (index === array.length - 1 && line === '') return;
                          lines.push("- " + line);
                        });
                      }
                      // Unchanged lines are not included in markdown export
                    });

                    lines.push("```");
                  }

                  if (event.data.result) {
                    const resultLine = formatToolResultTerminalStyle(event.data.result);
                    lines.push(resultLine);
                  }
                  lines.push("");
                }
                break;

              case "thinking":
                // Thinking block events - terminal style
                if (event.data && event.data.text) {
                  const label = (event.data.label && event.data.label !== "Thinking")
                    ? event.data.label
                    : "Thinking";
                  lines.push('● ' + label + ': ' + event.data.text);
                  lines.push("");
                }
                break;

              case "toolResult":
                // Tool result events (if separate from toolCall)
                if (event.data && event.data.result) {
                  const resultLine = formatToolResultTerminalStyle(event.data.result);
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
    handleStatusMessage,
    handleExportOutput,
    toggleOutputSection,
    restoreOutputCollapseState,
  };
})();
