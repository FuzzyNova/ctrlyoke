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

  // Editor state
  let editorState = {
    selectedPromptIndex: null, // null = new prompt mode, number = editing existing
    originalPromptData: null, // For Cancel/revert functionality
    hasActiveQueue: false, // Whether a workflow is currently loaded
    activeTab: "output", // 'output' or 'editor'
    promptEditor: null, // PromptEditor instance (initialized after DOM load)
  };

  // DOM elements
  const elements = {
    workflowName: document.getElementById("workflow-name"),
    statusSeparator: document.getElementById("status-separator"),
    executionState: document.getElementById("execution-state"),
    loadFileBtn: document.getElementById("load-file"),
    appendFileBtn: document.getElementById("append-file"),
    newWorkflowBtn: document.getElementById("new-workflow"),
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
    workflowNameInput: document.getElementById("workflow-name"),
    savePathPreview: document.getElementById("save-path-preview"),
    filenameError: document.getElementById("filename-error"),
    modalCancel: document.getElementById("modal-cancel"),
    modalCreate: document.getElementById("modal-create"),
    modalCreateRun: document.getElementById("modal-create-run"),
    // Tab elements
    tabButtons: document.querySelectorAll(".tab-btn"),
    outputPanel: document.getElementById("output-panel"),
    editorPanel: document.getElementById("editor-panel"),
    // Editor elements
    editorModeIndicator: document.getElementById("editor-mode-indicator"),
    promptEditor: document.getElementById("prompt-editor"),
    editorCharCount: document.getElementById("editor-char-count"),
    editorWordCount: document.getElementById("editor-word-count"),
    // Property controls
    propProvider: document.getElementById("prop-provider"),
    propModel: document.getElementById("prop-model"),
    propAgent: document.getElementById("prop-agent"),
    propNewChat: document.getElementById("prop-new-chat"),
    propAllowDynamic: document.getElementById("prop-allow-dynamic"),
    propEndScript: document.getElementById("prop-end-script"),
    propEndReturns: document.getElementById("prop-end-returns"),
    propEndTimeout: document.getElementById("prop-end-timeout"),
    propEndRetries: document.getElementById("prop-end-retries"),
    propEndRetryPrompt: document.getElementById("prop-end-retry-prompt"),
    // Editor action buttons
    btnEditorRun: document.getElementById("btn-editor-run"),
    btnEditorAppend: document.getElementById("btn-editor-append"),
    btnEditorAppendNext: document.getElementById("btn-editor-append-next"),
    btnEditorCancel: document.getElementById("btn-editor-cancel"),
    btnEditorUpdate: document.getElementById("btn-editor-update"),
    btnEditorDelete: document.getElementById("btn-editor-delete"),
  };

  // Modal state
  let modalState = {
    templates: [],
    currentTemplate: null,
    workflowsDir: ".flightpath/workflows",
    defaultTemplateId: "blank",
  };

  // Event listeners
  elements.loadFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  });

  elements.appendFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
  });

  elements.newWorkflowBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
  });

  elements.runBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.RUN });
  });

  elements.pauseBtn.addEventListener("click", () => {
    // Toggle between pause/resume based on current state
    // PAUSED or STOPPED: Resume execution
    // RUNNING: Pause execution
    if (
      state.executionState === EXECUTION_STATES.PAUSED ||
      state.executionState === EXECUTION_STATES.STOPPED
    ) {
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

  elements.workflowNameInput.addEventListener("input", () => {
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

  // Helper: Extract workflow name from file path
  function getWorkflowName(filePath) {
    if (!filePath) return "No workflow loaded";
    const fileName = filePath.split(/[/\\]/).pop(); // Get last segment
    return fileName.replace(/\.(flightpath\.(json|yaml|yml)|prompt\.md)$/, ""); // Remove extension
  }

  // Update workflow name and state display
  function updateWorkflowStatus(filePath, executionState) {
    if (!filePath) {
      // No workflow loaded - hide state separator and execution state
      elements.workflowName.textContent = "No workflow loaded";
      elements.statusSeparator.style.display = "none";
      elements.executionState.style.display = "none";
    } else {
      // Workflow loaded - show name, separator, and state
      elements.workflowName.textContent = getWorkflowName(filePath);
      elements.statusSeparator.style.display = "inline";
      elements.executionState.style.display = "inline";
    }
  }

  // Update Load button state (disable when running/paused)
  function updateLoadButtonState() {
    if (
      state.executionState === EXECUTION_STATES.RUNNING ||
      state.executionState === EXECUTION_STATES.PAUSED
    ) {
      elements.loadFileBtn.disabled = true;
      elements.loadFileBtn.title =
        "Cannot load while workflow is running (stop first)";
    } else {
      elements.loadFileBtn.disabled = false;
      elements.loadFileBtn.title = "Load a prompt file to start a new workflow";
    }
  }

  // Update Append button state (disable when no queue)
  function updateAppendButtonState() {
    const hasQueue = state.fileName !== null;
    elements.appendFileBtn.disabled = !hasQueue;

    if (!hasQueue) {
      elements.appendFileBtn.title = "No workflow loaded (load a file first)";
    } else {
      elements.appendFileBtn.title =
        "Append prompts from a file to the current queue";
    }
  }

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
      case MESSAGE_TYPES.SESSION_RESTORED:
        handleSessionRestored(
          message.fileName,
          message.prompts,
          message.results,
          message.executionState,
          message.currentIndex
        );
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
    // This handler is ONLY for IDLE state (user selects new file via Select button)
    // Queue extension during execution uses handleQueueExtended()
    console.log(`Dashboard: New file selected (${fileName}), resetting state`);

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

    // Update editor state
    editorState.hasActiveQueue = prompts.length > 0;
    updateEditorMode();

    // Update workflow status display
    updateWorkflowStatus(fileName, EXECUTION_STATES.IDLE);
    updateLoadButtonState();
    updateAppendButtonState();

    // Reset prompt counter
    elements.promptCounter.textContent = "";

    // Clear CLI output and show empty state
    elements.outputContent.innerHTML =
      '<p class="empty-state">CLI output will appear here during execution</p>';

    render();
  }

  function handleSessionRestored(
    fileName,
    prompts,
    results,
    executionState,
    currentIndex
  ) {
    // This handler is for restoring a previous session with runtime state preserved
    console.log(
      `Dashboard: Session restored (${fileName}), ${prompts.length} prompts, state: ${executionState}, currentIndex: ${currentIndex}`
    );

    state.fileName = fileName;
    state.executionState = executionState;
    state.currentStep = currentIndex;
    state.totalSteps = prompts.length;

    // Map prompts with their runtime status from results
    state.prompts = prompts.map((p, i) => {
      const result = results[i];
      return {
        index: i,
        text: p.prompt || p,
        status: result?.status || STEP_STATUS.PENDING,
        details: {},
      };
    });

    // Reset outputs and retry states (not persisted in working file)
    state.cliOutputs = {};
    state.retryStates = {};
    state.statusMessages = {};

    // Update workflow status display
    updateWorkflowStatus(fileName, executionState);
    updateLoadButtonState();
    updateAppendButtonState();

    // Update prompt counter to reflect restored state
    updatePromptCounter();

    // Clear CLI output and show empty state
    elements.outputContent.innerHTML =
      '<p class="empty-state">CLI output will appear here during execution</p>';

    render();
  }

  function handleExecutionStarted(fileName, totalSteps) {
    state.fileName = fileName;
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

    // Update workflow status display
    updateWorkflowStatus(fileName, EXECUTION_STATES.RUNNING);
    updateLoadButtonState();
    updateAppendButtonState();

    updateControls();
    updatePromptCounter();
    renderPromptsList();
  }

  function handleExecutionStateChanged(executionState) {
    state.executionState = executionState;
    updateWorkflowStatus(state.fileName, executionState);
    updateLoadButtonState();
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
    updateWorkflowStatus(state.fileName, EXECUTION_STATES.COMPLETED);
    updateLoadButtonState();
    updateAppendButtonState();
    updateControls();
  }

  function handlePromptsExtended(prompts) {
    // Replace entire prompts array with new disk order (preserves MCP insertion positions)
    // Map existing prompts by text to preserve their status/details
    console.log(
      `Dashboard: Prompts extended, replacing with ${prompts.length} prompts in disk order`
    );

    const existingStatusMap = new Map();
    state.prompts.forEach((p) => {
      // Use prompt text as key (trim for consistency)
      const key = p.text.trim();
      existingStatusMap.set(key, {
        status: p.status,
        details: p.details,
      });
    });

    // Replace entire array, preserving statuses for matching prompts
    state.prompts = prompts.map((p, i) => {
      const text = p.prompt || p;
      const key = text.trim();
      const existing = existingStatusMap.get(key);

      return {
        index: i,
        text: text,
        status: existing ? existing.status : STEP_STATUS.PENDING,
        details: existing ? existing.details : {},
      };
    });

    state.totalSteps = state.prompts.length;

    // Re-render the prompts list to show all prompts in correct order
    renderPromptsList();
    updatePromptCounter();
  }

  function render() {
    updateWorkflowStatus(state.fileName, state.executionState);
    renderExecutionState();
    renderPromptsList();
    updateControls();
    updateLoadButtonState();
    updateAppendButtonState();
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
      case EXECUTION_STATES.STOPPED:
        stateText = "Stopped";
        break;
      case EXECUTION_STATES.CANCELLING:
        stateText = "Stopping...";
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
          detailsHtml += `<div class="prompt-retry"><i class="codicon codicon-refresh"></i> Retry ${retryState.currentRetry} of ${retryState.maxRetries}</div>`;
        }

        if (prompt.details.duration) {
          detailsHtml += `<div class="prompt-detail">Duration: ${prompt.details.duration}s</div>`;
        }
        if (prompt.details.endConditionResult) {
          const result = prompt.details.endConditionResult;
          const resultIcon = result.passed
            ? '<i class="codicon codicon-pass"></i>'
            : '<i class="codicon codicon-error"></i>';
          detailsHtml += `<div class="prompt-detail">End condition: ${resultIcon} ${result.message || ""}</div>`;
        }
        if (prompt.details.message) {
          detailsHtml += `<div class="prompt-status-msg">${prompt.details.message}</div>`;
        }

        return `
        <div class="${statusClass}" data-prompt-index="${prompt.index}" style="cursor: pointer;" title="Click to edit">
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

  function updateControls() {
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isPaused = state.executionState === EXECUTION_STATES.PAUSED;
    const isStopped = state.executionState === EXECUTION_STATES.STOPPED;
    const isCancelling = state.executionState === EXECUTION_STATES.CANCELLING;
    const hasFile = state.fileName !== null;
    const isCompleted = state.executionState === EXECUTION_STATES.COMPLETED;

    // Enable Run button if: has file AND (not running OR is completed OR is paused OR is stopped)
    // Disable during cancellation - must wait for process to fully stop
    // When paused/stopped/completed, Run button acts as "Restart from beginning"
    elements.runBtn.disabled =
      !hasFile ||
      isCancelling ||
      (isRunning && !isCompleted && !isPaused && !isStopped);
    // Change button text and class based on state
    // Show restart icon when paused, stopped, or completed
    elements.runBtn.textContent =
      isCompleted || isPaused || isStopped ? "↻" : "▶";
    elements.runBtn.title =
      isCompleted || isPaused || isStopped ? "Restart from beginning" : "Run";
    elements.runBtn.className =
      isCompleted || isPaused || isStopped ? "btn-rerun" : "btn-primary";

    // Pause button becomes resume button when paused or stopped
    // Disable during cancellation
    // PAUSED: Resumes to next prompt (current one completed)
    // STOPPED: Resumes to restart current prompt (cancelled)
    if (isPaused || isStopped) {
      elements.pauseBtn.textContent = "▶";
      elements.pauseBtn.title = isStopped
        ? "Resume (restart current prompt)"
        : "Resume";
      elements.pauseBtn.disabled = false;
    } else {
      elements.pauseBtn.textContent = "⏸";
      elements.pauseBtn.title = "Pause";
      elements.pauseBtn.disabled = !isRunning || isCancelling;
    }

    // Stop button enabled when running, paused, or cancelling (allow re-pressing Stop to see status)
    // Disable when stopped (already stopped)
    elements.stopBtn.disabled = !isRunning && !isPaused && !isCancelling;
  }

  function getStatusIcon(status) {
    // Use codicons for proper VS Code theme integration
    const icons = {
      [STEP_STATUS.PENDING]: '<i class="codicon codicon-circle-outline"></i>',
      [STEP_STATUS.RUNNING]: '<i class="codicon codicon-play"></i>',
      [STEP_STATUS.COMPLETED]: '<i class="codicon codicon-pass"></i>',
      [STEP_STATUS.FAILED]: '<i class="codicon codicon-error"></i>',
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
    elements.workflowNameInput.value = "";
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
      elements.workflowNameInput.focus();
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
    const filename = elements.workflowNameInput.value.trim();
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
    const filename = elements.workflowNameInput.value.trim();

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
    const filename = elements.workflowNameInput.value.trim();

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

  // ============================================================================
  // EDITOR TAB FUNCTIONALITY
  // ============================================================================

  /**
   * Initialize the prompt editor with spell checking
   */
  function initializeEditor() {
    // Get dictionary path from template placeholder (replaced by FlightPathDashboardProvider)
    const dictionaryPath = "{{dictionaryPath}}";

    // Initialize PromptEditor with spell checking
    if (window.PromptEditor) {
      editorState.promptEditor = new window.PromptEditor(
        elements.promptEditor,
        dictionaryPath
      );
    }

    // Update character/word count on input
    elements.promptEditor.addEventListener("input", updateEditorMetadata);

    // Tab switching
    elements.tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tabName = btn.dataset.tab;
        switchTab(tabName);
      });
    });

    // Editor action buttons
    elements.btnEditorRun.addEventListener("click", () => {
      executePrompt("run");
    });

    elements.btnEditorAppend.addEventListener("click", () => {
      executePrompt("append");
    });

    elements.btnEditorAppendNext.addEventListener("click", () => {
      executePrompt("appendNext");
    });

    elements.btnEditorUpdate.addEventListener("click", updateExistingPrompt);

    elements.btnEditorCancel.addEventListener("click", cancelEdit);

    elements.btnEditorDelete.addEventListener("click", deletePrompt);

    // Make prompts in the list clickable for editing
    elements.promptsList.addEventListener("click", (e) => {
      const promptItem = e.target.closest(".prompt-item");
      if (promptItem && promptItem.dataset.promptIndex !== undefined) {
        const index = parseInt(promptItem.dataset.promptIndex, 10);
        selectPromptForEdit(index);
      }
    });

    // Update editor metadata initially
    updateEditorMetadata();
  }

  /**
   * Switch between Output and Editor tabs
   * @param {string} tabName - 'output' or 'editor'
   */
  function switchTab(tabName) {
    editorState.activeTab = tabName;

    // Update tab buttons
    elements.tabButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    // Update tab panels
    elements.outputPanel.classList.toggle("active", tabName === "output");
    elements.editorPanel.classList.toggle("active", tabName === "editor");
  }

  /**
   * Update character and word count in editor metadata
   */
  function updateEditorMetadata() {
    const text = elements.promptEditor.textContent || "";
    const charCount = text.length;
    const wordCount = text
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0).length;

    elements.editorCharCount.textContent = `${charCount} character${charCount !== 1 ? "s" : ""}`;
    elements.editorWordCount.textContent = `${wordCount} word${wordCount !== 1 ? "s" : ""}`;
  }

  /**
   * Get current property values from the UI
   * @returns {Object} Property values
   */
  function getPropertyValues() {
    const properties = {};

    // Only include non-default values
    if (elements.propProvider.value !== "default") {
      properties.provider = elements.propProvider.value;
    }

    if (elements.propModel.value !== "default") {
      properties.model = elements.propModel.value;
    }

    const agent = elements.propAgent.value.trim();
    if (agent && agent !== "default") {
      properties.agent = agent;
    }

    if (elements.propNewChat.value !== "default") {
      properties.newChatSession = elements.propNewChat.value === "yes";
    }

    if (elements.propAllowDynamic.value !== "default") {
      properties.allowDynamicExtension =
        elements.propAllowDynamic.value === "yes";
    }

    // End condition (if any fields are filled)
    const script = elements.propEndScript.value.trim();
    const returns = elements.propEndReturns.value.trim();

    if (script || returns) {
      properties.endCondition = {};

      if (script) properties.endCondition.script = script;
      if (returns) properties.endCondition.returns = returns;

      const timeout = parseInt(elements.propEndTimeout.value, 10);
      if (!isNaN(timeout) && timeout !== 30000) {
        properties.endCondition.timeout = timeout;
      }

      const maxRetries = parseInt(elements.propEndRetries.value, 10);
      if (!isNaN(maxRetries) && maxRetries !== 0) {
        properties.endCondition.maxRetries = maxRetries;
      }

      const retryPrompt = elements.propEndRetryPrompt.value.trim();
      if (retryPrompt) {
        properties.endCondition.retryPrompt = retryPrompt;
      }
    }

    return properties;
  }

  /**
   * Reset property controls to default values
   */
  function resetPropertyControls() {
    elements.propProvider.value = "default";
    elements.propModel.value = "default";
    elements.propAgent.value = "";
    elements.propNewChat.value = "default";
    elements.propAllowDynamic.value = "default";
    elements.propEndScript.value = "";
    elements.propEndReturns.value = "";
    elements.propEndTimeout.value = "30000";
    elements.propEndRetries.value = "0";
    elements.propEndRetryPrompt.value = "";
  }

  /**
   * Set property controls from a prompt object
   * @param {Object} prompt - PromptItem object
   */
  function setPropertyControls(prompt) {
    elements.propProvider.value = prompt.provider || "default";
    elements.propModel.value = prompt.model || "default";
    elements.propAgent.value = prompt.agent || "";
    elements.propNewChat.value =
      prompt.newChatSession === undefined
        ? "default"
        : prompt.newChatSession
          ? "yes"
          : "no";
    elements.propAllowDynamic.value =
      prompt.allowDynamicExtension === undefined
        ? "default"
        : prompt.allowDynamicExtension
          ? "yes"
          : "no";

    if (prompt.endCondition) {
      elements.propEndScript.value = prompt.endCondition.script || "";
      elements.propEndReturns.value = prompt.endCondition.returns || "";
      elements.propEndTimeout.value = prompt.endCondition.timeout || 30000;
      elements.propEndRetries.value = prompt.endCondition.maxRetries || 0;
      elements.propEndRetryPrompt.value = prompt.endCondition.retryPrompt || "";
    } else {
      elements.propEndScript.value = "";
      elements.propEndReturns.value = "";
      elements.propEndTimeout.value = "30000";
      elements.propEndRetries.value = "0";
      elements.propEndRetryPrompt.value = "";
    }
  }

  /**
   * Update editor mode indicator and button visibility
   */
  function updateEditorMode() {
    const isNewMode = editorState.selectedPromptIndex === null;
    const hasQueue = editorState.hasActiveQueue;

    if (isNewMode) {
      elements.editorModeIndicator.textContent = "New Prompt";

      // Show new prompt buttons
      elements.btnEditorRun.style.display = "";
      elements.btnEditorRun.disabled = false;

      elements.btnEditorAppend.style.display = "";
      elements.btnEditorAppend.disabled = !hasQueue;

      elements.btnEditorAppendNext.style.display = "";
      elements.btnEditorAppendNext.disabled = !hasQueue;

      // Hide editing buttons
      elements.btnEditorCancel.style.display = "none";
      elements.btnEditorUpdate.style.display = "none";
      elements.btnEditorDelete.style.display = "none";
    } else {
      const totalPrompts = state.prompts.length;
      elements.editorModeIndicator.textContent = `Editing: Prompt ${editorState.selectedPromptIndex + 1} of ${totalPrompts}`;

      // Hide new prompt buttons
      elements.btnEditorRun.style.display = "none";
      elements.btnEditorAppend.style.display = "none";
      elements.btnEditorAppendNext.style.display = "none";

      // Show editing buttons
      elements.btnEditorCancel.style.display = "";
      elements.btnEditorCancel.disabled = false;

      elements.btnEditorUpdate.style.display = "";
      elements.btnEditorUpdate.disabled = false;

      elements.btnEditorDelete.style.display = "";
      elements.btnEditorDelete.disabled = false;
    }
  }

  /**
   * Execute a prompt (Run/Append/AppendNext)
   * @param {string} action - 'run', 'append', or 'appendNext'
   */
  function executePrompt(action) {
    const text = elements.promptEditor.textContent.trim();

    if (!text) {
      return; // Don't execute empty prompts
    }

    const properties = getPropertyValues();

    vscode.postMessage({
      type: MESSAGE_TYPES.EXECUTE_PROMPT,
      text,
      properties,
      action,
    });

    // Clear editor after Run (but not after Append - user may want to add more)
    if (action === "run") {
      if (editorState.promptEditor) {
        editorState.promptEditor.clear();
      } else {
        elements.promptEditor.textContent = "";
      }
      resetPropertyControls();
      updateEditorMetadata();
    }
  }

  /**
   * Update an existing prompt in the queue
   */
  function updateExistingPrompt() {
    if (editorState.selectedPromptIndex === null) return;

    const text = elements.promptEditor.textContent.trim();

    if (!text) {
      return; // Don't save empty prompts
    }

    const properties = getPropertyValues();

    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_PROMPT,
      index: editorState.selectedPromptIndex,
      text,
      properties,
    });

    // Return to new prompt mode after updating
    cancelEdit();
  }

  /**
   * Cancel editing and return to new prompt mode
   */
  function cancelEdit() {
    editorState.selectedPromptIndex = null;
    editorState.originalPromptData = null;

    // Clear editor
    if (editorState.promptEditor) {
      editorState.promptEditor.clear();
    } else {
      elements.promptEditor.textContent = "";
    }

    // Reset property controls
    resetPropertyControls();

    // Update UI
    updateEditorMode();
    updateEditorMetadata();
  }

  /**
   * Delete a prompt from the queue
   */
  function deletePrompt() {
    if (editorState.selectedPromptIndex === null) return;

    // Confirm deletion
    const confirmed = confirm(
      `Delete prompt ${editorState.selectedPromptIndex + 1}?`
    );

    if (confirmed) {
      vscode.postMessage({
        type: MESSAGE_TYPES.DELETE_PROMPT,
        index: editorState.selectedPromptIndex,
      });

      // Return to new prompt mode
      cancelEdit();
    }
  }

  /**
   * Select a prompt from the queue for editing
   * @param {number} index - Prompt index
   */
  function selectPromptForEdit(index) {
    if (index < 0 || index >= state.prompts.length) return;

    const prompt = state.prompts[index];

    // Store original data for cancel functionality
    editorState.selectedPromptIndex = index;
    editorState.originalPromptData = { ...prompt };

    // Load prompt text into editor
    if (editorState.promptEditor) {
      editorState.promptEditor.setText(prompt.prompt || "");
    } else {
      elements.promptEditor.textContent = prompt.prompt || "";
    }

    // Load property controls
    setPropertyControls(prompt);

    // Switch to editor tab
    switchTab("editor");

    // Update UI
    updateEditorMode();
    updateEditorMetadata();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  // Initialize editor when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeEditor);
  } else {
    initializeEditor();
  }

  // Signal ready
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
