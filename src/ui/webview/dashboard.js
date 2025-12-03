(function () {
  const vscode = acquireVsCodeApi();

  // Import constants from compiled DashboardConstants.js (loaded via script tag in HTML)
  // Single source of truth - these match src/types/DashboardConstants.ts
  // Only importing cross-file shared constants (not UI-specific strings)
  const { MESSAGE_TYPES, EXECUTION_STATES, STEP_STATUS } =
    window.FlightPathConstants;

  // State management
  let state = {
    fileName: null,
    prompts: [],
    executionState: EXECUTION_STATES.IDLE,
    currentStep: 0,
    totalSteps: 0,
    cliOutputs: {}, // Maps stepIndex -> array of outputs (including retries)
    retryStates: {}, // Maps stepIndex -> { currentRetry, maxRetries }
    statusMessages: {}, // Maps stepIndex -> array of status messages
  };

  // DOM elements
  const elements = {
    fileName: document.getElementById("file-name"),
    newPromptBtn: document.getElementById("new-prompt"),
    newWorkflowBtn: document.getElementById("new-workflow"),
    selectFileBtn: document.getElementById("select-file"),
    editFileBtn: document.getElementById("edit-file"),
    executionState: document.getElementById("execution-state"),
    runBtn: document.getElementById("btn-run"),
    pauseBtn: document.getElementById("btn-pause"),
    stopBtn: document.getElementById("btn-stop"),
    exportBtn: document.getElementById("btn-export"),
    promptCounter: document.getElementById("prompt-counter"),
    promptsList: document.getElementById("prompts-list"),
    outputSection: document.getElementById("output-section"),
    outputContent: document.getElementById("output-content"),
    autoscrollCheckbox: document.getElementById("autoscroll-checkbox"),
    // Modal elements
    modal: document.getElementById("new-workflow-modal"),
    modalOverlay: document.querySelector(".modal-overlay"),
    modalClose: document.querySelector(".modal-close"),
    templateSelect: document.getElementById("template-select"),
    setDefaultBtn: document.getElementById("set-default-btn"),
    defaultConfirmation: document.getElementById("default-confirmation"),
    templateDescription: document.getElementById("template-description"),
    variablesSection: document.getElementById("variables-section"),
    workflowName: document.getElementById("workflow-name"),
    savePathPreview: document.getElementById("save-path-preview"),
    filenameError: document.getElementById("filename-error"),
    modalCancel: document.getElementById("modal-cancel"),
    modalCreate: document.getElementById("modal-create"),
    modalCreateRun: document.getElementById("modal-create-run"),
  };

  // Modal state
  let modalState = {
    templates: [],
    currentTemplate: null,
    workflowsDir: ".flightpath/workflows",
    defaultTemplateId: "blank",
  };

  // Event listeners
  elements.newPromptBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_PROMPT });
  });

  elements.newWorkflowBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
  });

  elements.selectFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  });

  elements.editFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.EDIT_FILE });
  });

  elements.runBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.RUN });
  });

  elements.pauseBtn.addEventListener("click", () => {
    // Toggle between pause and resume based on current state
    if (state.executionState === EXECUTION_STATES.PAUSED) {
      vscode.postMessage({ type: MESSAGE_TYPES.RESUME });
    } else {
      vscode.postMessage({ type: MESSAGE_TYPES.PAUSE });
    }
  });

  elements.stopBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.STOP });
  });

  elements.exportBtn.addEventListener("click", () => {
    const markdownContent = generateMarkdownOutput();
    vscode.postMessage({
      type: MESSAGE_TYPES.EXPORT_OUTPUT,
      content: markdownContent,
      fileName: state.fileName,
    });
  });

  // Modal event listeners
  elements.modalOverlay.addEventListener("click", () => {
    closeModal();
  });

  elements.modalClose.addEventListener("click", () => {
    closeModal();
  });

  elements.templateSelect.addEventListener("change", () => {
    const templateId = elements.templateSelect.value;
    if (templateId === "__create_new__") {
      closeModal();
      vscode.postMessage({ type: MESSAGE_TYPES.CREATE_NEW_TEMPLATE });
    } else {
      vscode.postMessage({ type: MESSAGE_TYPES.TEMPLATE_SELECTED, templateId });
    }
  });

  elements.setDefaultBtn.addEventListener("click", () => {
    const templateId = elements.templateSelect.value;
    if (templateId && templateId !== "__create_new__") {
      vscode.postMessage({
        type: MESSAGE_TYPES.SET_DEFAULT_TEMPLATE,
        templateId,
      });
    }
  });

  elements.workflowName.addEventListener("input", () => {
    updatePathPreview();
    validateFilename();
  });

  elements.modalCancel.addEventListener("click", () => {
    closeModal();
  });

  elements.modalCreate.addEventListener("click", () => {
    submitWorkflow(false);
  });

  elements.modalCreateRun.addEventListener("click", () => {
    submitWorkflow(true);
  });

  // Keyboard handling for modal
  document.addEventListener("keydown", (e) => {
    if (!elements.modal.hidden) {
      if (e.key === "Escape") {
        closeModal();
      } else if (e.key === "Enter" && e.ctrlKey) {
        submitWorkflow(true);
      } else if (
        e.key === "Enter" &&
        !e.ctrlKey &&
        e.target.tagName !== "SELECT"
      ) {
        // Don't submit on Enter in select dropdown
        if (e.target.tagName !== "INPUT" || e.target.id === "workflow-name") {
          submitWorkflow(false);
        }
      }
    }
  });

  // Message handler
  window.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.type) {
      case MESSAGE_TYPES.INIT:
        handleInit(message.data);
        break;
      case MESSAGE_TYPES.FILE_SELECTED:
        handleFileSelected(message.fileName, message.prompts);
        break;
      case MESSAGE_TYPES.EXECUTION_STARTED:
        handleExecutionStarted(message.fileName, message.totalSteps);
        break;
      case MESSAGE_TYPES.EXECUTION_STATE_CHANGED:
        handleExecutionStateChanged(message.state);
        break;
      case MESSAGE_TYPES.PROGRESS_UPDATE:
        handleProgressUpdate(message.current, message.total);
        break;
      case MESSAGE_TYPES.STEP_STATUS_CHANGED:
        handleStepStatusChanged(
          message.stepIndex,
          message.status,
          message.details
        );
        break;
      case MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED:
        handleRetryAttemptChanged(
          message.stepIndex,
          message.currentRetry,
          message.maxRetries
        );
        break;
      case MESSAGE_TYPES.CLI_OUTPUT:
        handleCliOutput(message.stepIndex, message.output);
        break;
      case MESSAGE_TYPES.CLI_STREAMING_CHUNK:
        console.log(
          `🔍 Dashboard: Received CLI_STREAMING_CHUNK message, stepIndex=${message.stepIndex}, chunk length=${message.chunk?.length}`
        );
        handleCliStreamingChunk(message.stepIndex, message.chunk);
        break;
      case MESSAGE_TYPES.STATUS_MESSAGE:
        handleStatusMessage(message.stepIndex, message.message);
        break;
      case MESSAGE_TYPES.EXECUTION_COMPLETED:
        handleExecutionCompleted();
        break;
      case MESSAGE_TYPES.PROMPTS_EXTENDED:
        handlePromptsExtended(message.prompts);
        break;
      // Modal messages
      case MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL:
        handleOpenNewWorkflowModal(message);
        break;
      case MESSAGE_TYPES.TEMPLATE_INFO:
        handleTemplateInfo(message);
        break;
      case MESSAGE_TYPES.DEFAULT_TEMPLATE_SET:
        handleDefaultTemplateSet(message);
        break;
      case MESSAGE_TYPES.WORKFLOW_CREATED:
        handleWorkflowCreated(message);
        break;
      case MESSAGE_TYPES.CLOSE_MODAL:
        closeModal();
        break;
    }
  });

  function handleInit(data) {
    state = { ...state, ...data };
    render();
  }

  function handleFileSelected(fileName, prompts) {
    state.fileName = fileName;
    state.prompts = prompts.map((p, i) => ({
      index: i,
      text: p.prompt || p,
      status: STEP_STATUS.PENDING,
      details: {},
    }));
    // Reset execution state and progress when new file is selected
    state.executionState = EXECUTION_STATES.IDLE;
    state.currentStep = 0;
    state.totalSteps = 0;
    state.cliOutputs = {}; // Reset outputs
    state.retryStates = {}; // Reset retry states
    state.statusMessages = {}; // Reset status messages
    // Reset prompt counter
    elements.promptCounter.textContent = "";
    // Clear CLI output and show empty state
    elements.outputContent.innerHTML =
      '<p class="empty-state">CLI output will appear here during execution</p>';
    render();
  }

  function handleExecutionStarted(fileName, totalSteps) {
    state.executionState = EXECUTION_STATES.RUNNING;
    state.totalSteps = totalSteps;
    state.currentStep = 0;

    // Reset all prompts to pending state (for restart scenario)
    state.prompts.forEach((prompt) => {
      prompt.status = STEP_STATUS.PENDING;
      prompt.details = {};
    });

    // Clear outputs and retry states (for restart scenario)
    state.cliOutputs = {};
    state.retryStates = {};
    state.statusMessages = {};

    // Clear CLI output and show empty state
    elements.outputContent.innerHTML =
      '<p class="empty-state">CLI output will appear here during execution</p>';

    updateControls();
    updatePromptCounter();
    renderPromptsList();
  }

  function handleExecutionStateChanged(executionState) {
    state.executionState = executionState;
    render();
  }

  function handleProgressUpdate(current, total) {
    state.currentStep = current;
    state.totalSteps = total;
    updatePromptCounter();
  }

  function handleStepStatusChanged(stepIndex, status, details) {
    if (state.prompts[stepIndex]) {
      state.prompts[stepIndex].status = status.state;
      state.prompts[stepIndex].details = { ...status, ...details };
      renderPromptsList();
    }
  }

  function handleRetryAttemptChanged(stepIndex, currentRetry, maxRetries) {
    state.retryStates[stepIndex] = { currentRetry, maxRetries };
    renderPromptsList();
  }

  function handleStatusMessage(stepIndex, message) {
    console.log(
      "📝 Dashboard: Received status message for step",
      stepIndex,
      message
    );

    // Initialize array for this step if needed
    if (!state.statusMessages[stepIndex]) {
      state.statusMessages[stepIndex] = [];
    }

    // Add status message with timestamp
    const now = new Date();
    state.statusMessages[stepIndex].push({
      message,
      timestamp: now.toLocaleTimeString(),
      timestampMs: now.getTime(),
    });

    // Always render to show all accumulated messages
    renderAllCliOutputs();
  }

  function handleCliOutput(stepIndex, output) {
    console.log(
      "📊 Dashboard: Received CLI output for step",
      stepIndex,
      "isStreaming:",
      output.isStreaming,
      "outputCount before:",
      (state.cliOutputs[stepIndex] || []).length
    );

    // Initialize array for this step if needed
    if (!state.cliOutputs[stepIndex]) {
      state.cliOutputs[stepIndex] = [];
    }

    // Add timestamp to output if not present
    if (!output.timestampMs) {
      output.timestampMs = new Date().getTime();
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
    // Always render to show all accumulated outputs
    renderAllCliOutputs();
  }

  function handleCliStreamingChunk(stepIndex, chunk) {
    console.log(
      `🔍 Dashboard.handleCliStreamingChunk: stepIndex=${stepIndex}, chunk length=${chunk.length}, content (first 100): ${JSON.stringify(chunk.substring(0, 100))}`
    );

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
        timestampMs: new Date().getTime(),
      });
    }

    // Append chunk to the last (streaming) output's response
    outputs[outputs.length - 1].response += chunk;
    console.log(
      `🔍 Dashboard.handleCliStreamingChunk: Total response length now: ${outputs[outputs.length - 1].response.length}`
    );

    // Always render to show streaming updates
    renderAllCliOutputs();
  }

  function handleExecutionCompleted() {
    state.executionState = EXECUTION_STATES.COMPLETED;
    updateControls();
  }

  function handlePromptsExtended(prompts) {
    // Merge new prompts with existing ones, preserving status of existing prompts
    const existingCount = state.prompts.length;

    // Add new prompts (starting from existingCount index)
    const newPrompts = prompts.slice(existingCount).map((p, i) => ({
      index: existingCount + i,
      text: p.prompt || p,
      status: STEP_STATUS.PENDING,
      details: {},
    }));

    state.prompts.push(...newPrompts);
    state.totalSteps = state.prompts.length;

    // Re-render the prompts list to show all prompts
    renderPromptsList();
    updatePromptCounter();
  }

  function render() {
    elements.fileName.textContent = state.fileName || "No file selected";
    renderExecutionState();
    renderPromptsList();
    updateControls();
    updatePromptCounter();
  }

  function renderExecutionState() {
    // Remove all state classes
    elements.executionState.className = "";

    // Add new state class
    const stateClass = `execution-state-${state.executionState}`;
    elements.executionState.className = stateClass;

    // Update text based on state
    let stateText = "";
    switch (state.executionState) {
      case EXECUTION_STATES.IDLE:
        stateText = "Ready";
        break;
      case EXECUTION_STATES.RUNNING:
        stateText = "Running";
        break;
      case EXECUTION_STATES.PAUSED:
        stateText = "Paused";
        break;
      case EXECUTION_STATES.COMPLETED:
        stateText = "Completed";
        break;
      case EXECUTION_STATES.ERROR:
        stateText = "Error";
        break;
      default:
        stateText = state.executionState;
    }
    elements.executionState.textContent = stateText;
  }

  function renderPromptsList() {
    if (state.prompts.length === 0) {
      elements.promptsList.innerHTML =
        '<p class="empty-state">No prompts loaded</p>';
      return;
    }

    elements.promptsList.innerHTML = state.prompts
      .map((prompt) => {
        const icon = getStatusIcon(prompt.status);
        const statusClass = `prompt-item status-${prompt.status}`;

        let detailsHtml = "";

        // Show retry state if retrying
        const retryState = state.retryStates[prompt.index];
        if (retryState && retryState.currentRetry > 0) {
          detailsHtml += `<div class="prompt-retry">🔄 Retry ${retryState.currentRetry} of ${retryState.maxRetries}</div>`;
        }

        if (prompt.details.duration) {
          detailsHtml += `<div class="prompt-detail">Duration: ${prompt.details.duration}s</div>`;
        }
        if (prompt.details.endConditionResult) {
          const result = prompt.details.endConditionResult;
          const resultIcon = result.passed ? "✓" : "✗";
          detailsHtml += `<div class="prompt-detail">End condition: ${resultIcon} ${result.message || ""}</div>`;
        }
        if (prompt.details.message) {
          detailsHtml += `<div class="prompt-status-msg">${prompt.details.message}</div>`;
        }

        return `
        <div class="${statusClass}">
          <div class="prompt-header">
            <span class="prompt-icon">${icon}</span>
            <span class="prompt-text">${prompt.index + 1}. ${truncate(prompt.text, 60)}</span>
          </div>
          ${detailsHtml}
        </div>
      `;
      })
      .join("");
  }

  function renderAllCliOutputs() {
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
        html += '<div class="status-message">';
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

        if (output.response) {
          html += `<div class="output-response">${escapeHtml(output.response)}</div>`;
        }

        if (output.tokens) {
          html += `<div class="output-stats">📊 Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion</div>`;
        }

        if (!output.isStreaming && output.elapsed !== undefined) {
          html += `<div class="output-stats">⏱️ ${output.elapsed}s</div>`;
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

  function updateControls() {
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isPaused = state.executionState === EXECUTION_STATES.PAUSED;
    const hasFile = state.fileName !== null;
    const isCompleted = state.executionState === EXECUTION_STATES.COMPLETED;

    // Enable Edit button when a file is loaded
    elements.editFileBtn.disabled = !hasFile;

    // Enable Run button if: has file AND (not running OR is completed OR is paused)
    // When paused, Run button acts as "Restart from beginning"
    elements.runBtn.disabled =
      !hasFile || (isRunning && !isCompleted && !isPaused);
    // Change button text and class based on state
    // Show restart icon when paused or completed
    elements.runBtn.textContent = isCompleted || isPaused ? "↻" : "▶";
    elements.runBtn.title =
      isCompleted || isPaused ? "Restart from beginning" : "Run";
    elements.runBtn.className =
      isCompleted || isPaused ? "btn-rerun" : "btn-primary";

    // Pause button becomes resume button when paused
    if (isPaused) {
      elements.pauseBtn.textContent = "▶";
      elements.pauseBtn.title = "Resume";
      elements.pauseBtn.disabled = false;
    } else {
      elements.pauseBtn.textContent = "⏸";
      elements.pauseBtn.title = "Pause";
      elements.pauseBtn.disabled = !isRunning;
    }

    // Stop button enabled when running or paused
    elements.stopBtn.disabled = !isRunning && !isPaused;
  }

  function getStatusIcon(status) {
    const icons = {
      [STEP_STATUS.PENDING]: "⏸️",
      [STEP_STATUS.RUNNING]: "▶️",
      [STEP_STATUS.COMPLETED]: "✅",
      [STEP_STATUS.FAILED]: "❌",
    };
    return icons[status] || icons[STEP_STATUS.PENDING];
  }

  function truncate(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
  }

  function updatePromptCounter() {
    if (state.totalSteps > 0) {
      elements.promptCounter.textContent = `Completed ${state.currentStep} of ${state.totalSteps}`;
    } else {
      elements.promptCounter.textContent = "";
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Generate markdown-formatted output for export
   */
  function generateMarkdownOutput() {
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

        // Stats section
        const stats = [];
        if (output.tokens) {
          stats.push(
            `📊 Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion`
          );
        }
        if (output.elapsed !== undefined) {
          stats.push(`⏱️ ${output.elapsed}s`);
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

  // ============================================================================
  // Modal Functions
  // ============================================================================

  /**
   * Handle opening the new workflow modal
   */
  function handleOpenNewWorkflowModal(message) {
    modalState.templates = message.templates || [];
    modalState.workflowsDir = message.workflowsDir || ".flightpath/workflows";
    modalState.defaultTemplateId = message.defaultTemplateId || "blank";

    // Populate template dropdown
    populateTemplateDropdown();

    // Reset form
    elements.workflowName.value = "";
    elements.variablesSection.innerHTML = "";
    elements.variablesSection.hidden = true;
    elements.filenameError.hidden = true;
    elements.defaultConfirmation.hidden = true;

    // Select default template
    elements.templateSelect.value = modalState.defaultTemplateId;

    // Request info for default template
    const defaultTemplate = modalState.templates.find(
      (t) => t.id === modalState.defaultTemplateId
    );
    if (defaultTemplate) {
      updateTemplateUI(defaultTemplate);
    }

    // Update path preview
    updatePathPreview();

    // Show modal
    elements.modal.hidden = false;

    // Focus first input
    setTimeout(() => {
      elements.workflowName.focus();
    }, 100);
  }

  /**
   * Populate the template dropdown with groups
   */
  function populateTemplateDropdown() {
    elements.templateSelect.innerHTML = "";

    const builtIn = modalState.templates.filter((t) => t.isBuiltIn);
    const custom = modalState.templates.filter(
      (t) => !t.isBuiltIn && !t.isAction
    );
    const actions = modalState.templates.filter((t) => t.isAction);

    // Built-in templates
    if (builtIn.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "Built-in Templates";
      builtIn.forEach((template) => {
        const option = document.createElement("option");
        option.value = template.id;
        option.textContent = template.name;
        group.appendChild(option);
      });
      elements.templateSelect.appendChild(group);
    }

    // Custom templates
    if (custom.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "Custom Templates";
      custom.forEach((template) => {
        const option = document.createElement("option");
        option.value = template.id;
        option.textContent = template.name;
        group.appendChild(option);
      });
      elements.templateSelect.appendChild(group);
    }

    // Actions (Create New Template)
    if (actions.length > 0) {
      const group = document.createElement("optgroup");
      group.label = "Actions";
      actions.forEach((template) => {
        const option = document.createElement("option");
        option.value = template.id;
        option.textContent = template.name;
        option.dataset.action = "true";
        group.appendChild(option);
      });
      elements.templateSelect.appendChild(group);
    }
  }

  /**
   * Handle template info update from extension
   */
  function handleTemplateInfo(message) {
    const template = modalState.templates.find(
      (t) => t.id === message.templateId
    );
    if (template) {
      template.variables = message.variables || [];
      template.description = message.description || template.description;
      updateTemplateUI(template);
    }
  }

  /**
   * Update UI based on selected template
   */
  function updateTemplateUI(template) {
    modalState.currentTemplate = template;

    // Update description
    elements.templateDescription.textContent = template.description || "";

    // Update variables section
    if (template.variables && template.variables.length > 0) {
      elements.variablesSection.innerHTML = "";
      template.variables.forEach((variable) => {
        const div = document.createElement("div");
        div.className = "variable-input";
        div.innerHTML = `
          <label for="var-${variable}">${variable}</label>
          <input type="text" id="var-${variable}" data-variable="${variable}" placeholder="Enter ${variable}">
        `;
        elements.variablesSection.appendChild(div);
      });
      elements.variablesSection.hidden = false;
    } else {
      elements.variablesSection.innerHTML = "";
      elements.variablesSection.hidden = true;
    }
  }

  /**
   * Handle default template set confirmation
   */
  function handleDefaultTemplateSet(message) {
    if (message.success) {
      modalState.defaultTemplateId = message.templateId;
      elements.defaultConfirmation.hidden = false;
      setTimeout(() => {
        elements.defaultConfirmation.hidden = true;
      }, 2000);
    }
  }

  /**
   * Handle workflow created response
   */
  function handleWorkflowCreated(message) {
    if (message.success) {
      closeModal();
      // The extension will handle loading and optionally running the workflow
    } else {
      elements.filenameError.textContent =
        message.error || "Failed to create workflow";
      elements.filenameError.hidden = false;
    }
  }

  /**
   * Update the save path preview
   */
  function updatePathPreview() {
    const filename = elements.workflowName.value.trim();
    if (filename) {
      elements.savePathPreview.textContent = `${modalState.workflowsDir}/${filename}.flightpath.json`;
    } else {
      elements.savePathPreview.textContent = `${modalState.workflowsDir}/`;
    }
  }

  /**
   * Validate the filename input
   * @returns {boolean} True if valid
   */
  function validateFilename() {
    const filename = elements.workflowName.value.trim();

    // Check for empty
    if (!filename) {
      elements.filenameError.textContent = "Workflow name is required";
      elements.filenameError.hidden = false;
      return false;
    }

    // Check for invalid characters
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(filename)) {
      elements.filenameError.textContent = "Invalid characters in filename";
      elements.filenameError.hidden = false;
      return false;
    }

    // Check for reserved names (Windows)
    const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
    if (reserved.test(filename)) {
      elements.filenameError.textContent = "Reserved filename";
      elements.filenameError.hidden = false;
      return false;
    }

    elements.filenameError.hidden = true;
    return true;
  }

  /**
   * Submit the workflow creation form
   * @param {boolean} runAfter Whether to run the workflow after creation
   */
  function submitWorkflow(runAfter) {
    if (!validateFilename()) {
      return;
    }

    const templateId = elements.templateSelect.value;
    const filename = elements.workflowName.value.trim();

    // Collect variable values
    const variables = {};
    const variableInputs = elements.variablesSection.querySelectorAll(
      "input[data-variable]"
    );
    variableInputs.forEach((input) => {
      variables[input.dataset.variable] = input.value;
    });

    vscode.postMessage({
      type: MESSAGE_TYPES.CREATE_WORKFLOW,
      templateId,
      variables,
      filename,
      workflowsDir: modalState.workflowsDir,
      runAfter,
    });
  }

  /**
   * Close the modal
   */
  function closeModal() {
    elements.modal.hidden = true;
    modalState.currentTemplate = null;
  }

  // Signal ready
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
