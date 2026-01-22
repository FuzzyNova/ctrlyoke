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
   * Check if tool is a file modification operation
   * @param {string} toolName - Name of the tool
   * @returns {boolean} True if tool modifies files
   */
  function isFileModificationTool(toolName) {
    const fileTools = [
      "Edit",
      "Write",
      "MultiEdit",
      "sed",
      "patch",
      "apply_diff",
      "insert",
    ];
    return fileTools.some((t) =>
      toolName.toLowerCase().includes(t.toLowerCase())
    );
  }

  /**
   * Render tool call with diff visualization for file modifications
   * @param {Object} tool - Tool call object
   * @returns {string} HTML string
   */
  function renderToolWithDiff(tool) {
    let html = "";

    // Try to extract old_string and new_string from parameters for diff display
    if (tool.parameters.old_string && tool.parameters.new_string) {
      html += '<div class="tool-call-diff">';

      const oldLines = tool.parameters.old_string.split("\n");
      const newLines = tool.parameters.new_string.split("\n");

      // Show removed lines
      oldLines.forEach((line) => {
        html += '<div class="diff-line removed">' + escapeHtml(line) + "</div>";
      });

      // Show added lines
      newLines.forEach((line) => {
        html += '<div class="diff-line added">' + escapeHtml(line) + "</div>";
      });

      html += "</div>";
    } else if (tool.parameters.content && tool.parameters.file_path) {
      // Write tool - show file path and content
      html += '<div class="tool-file-info">';
      html +=
        '<div class="file-path">' +
        escapeHtml(tool.parameters.file_path) +
        "</div>";
      html += "</div>";
      html +=
        '<pre class="tool-params">' +
        escapeHtml(tool.parameters.content) +
        "</pre>";
    } else {
      // Fallback to JSON if no diff available
      html +=
        '<pre class="tool-params">' +
        escapeHtml(JSON.stringify(tool.parameters, null, 2)) +
        "</pre>";
    }

    return html;
  }

  /**
   * Render structured output with tool calls and thinking blocks
   * @param {Object} output - CLI output object with optional structured field
   * @returns {string} HTML string
   */
  function renderStructuredOutput(output) {
    let html = "";

    // Response text first (only if we don't have structured text OR they differ)
    // Usually response === structured.text, but render response for backward compat
    if (output.response) {
      html +=
        '<div class="output-response">' +
        escapeHtml(output.response) +
        "</div>";
    }

    // If no structured data, we're done
    if (!output.structured) {
      return html;
    }

    // Tool calls section
    if (output.structured.toolCalls && output.structured.toolCalls.length > 0) {
      html += '<div class="output-tool-calls">';
      html +=
        '<div class="tool-calls-header"><i class="codicon codicon-tools"></i> Tool Calls</div>';

      for (const tool of output.structured.toolCalls) {
        html += '<div class="tool-call-item">';
        html += '<div class="tool-name">' + escapeHtml(tool.name) + "</div>";

        // Check if this is a file modification tool
        if (isFileModificationTool(tool.name)) {
          html += renderToolWithDiff(tool);
        } else {
          html +=
            '<pre class="tool-params">' +
            escapeHtml(JSON.stringify(tool.parameters, null, 2)) +
            "</pre>";
        }

        if (tool.result) {
          const icon = tool.result.success ? "codicon-pass" : "codicon-error";
          const resultClass = tool.result.success ? "success" : "error";
          html += '<div class="tool-result ' + resultClass + '">';
          html += '<i class="codicon ' + icon + '"></i> ';
          html += escapeHtml(tool.result.output || tool.result.error || "");
          html += "</div>";
        }
        html += "</div>";
      }
      html += "</div>";
    }

    // Thinking blocks section
    if (
      output.structured.thinkingBlocks &&
      output.structured.thinkingBlocks.length > 0
    ) {
      html += '<div class="output-thinking">';
      html +=
        '<div class="thinking-header"><i class="codicon codicon-lightbulb"></i> Thinking</div>';

      for (const block of output.structured.thinkingBlocks) {
        html += '<div class="thinking-block">';
        if (block.label && block.label !== "Thinking") {
          html +=
            '<div class="thinking-label">' + escapeHtml(block.label) + "</div>";
        }
        html +=
          '<div class="thinking-text">' + escapeHtml(block.text) + "</div>";
        html += "</div>";
      }
      html += "</div>";
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

        if (output.response) {
          lines.push("### Response");
          lines.push("");
          lines.push("```");
          lines.push(output.response);
          lines.push("```");
          lines.push("");
        }

        // Export tool calls with diff formatting
        if (
          output.structured?.toolCalls &&
          output.structured.toolCalls.length > 0
        ) {
          lines.push("### Tool Calls");
          lines.push("");

          output.structured.toolCalls.forEach((tool) => {
            lines.push("**" + tool.name + "**");
            lines.push("");

            // Special handling for file modifications with diff
            if (tool.parameters.old_string && tool.parameters.new_string) {
              lines.push("```diff");
              tool.parameters.old_string.split("\n").forEach((line) => {
                lines.push("- " + line);
              });
              tool.parameters.new_string.split("\n").forEach((line) => {
                lines.push("+ " + line);
              });
              lines.push("```");
            } else if (tool.parameters.file_path && tool.parameters.content) {
              // Write tool - show file path
              lines.push("File: `" + tool.parameters.file_path + "`");
              lines.push("");
              lines.push("```");
              lines.push(tool.parameters.content);
              lines.push("```");
            } else {
              // Other tools - show JSON
              lines.push("```json");
              lines.push(JSON.stringify(tool.parameters, null, 2));
              lines.push("```");
            }

            if (tool.result) {
              const status = tool.result.success ? "✓ Success" : "✗ Failed";
              lines.push("");
              lines.push("*" + status + "*");
              if (tool.result.output || tool.result.error) {
                lines.push("```");
                lines.push(tool.result.output || tool.result.error);
                lines.push("```");
              }
            }
            lines.push("");
          });
        }

        // Export thinking blocks
        if (
          output.structured?.thinkingBlocks &&
          output.structured.thinkingBlocks.length > 0
        ) {
          lines.push("### Thinking");
          lines.push("");

          output.structured.thinkingBlocks.forEach((block) => {
            if (block.label) {
              lines.push("**" + block.label + "**");
              lines.push("");
            }
            lines.push("```");
            lines.push(block.text);
            lines.push("```");
            lines.push("");
          });
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
