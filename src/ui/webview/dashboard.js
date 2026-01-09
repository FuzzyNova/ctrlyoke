(function () {
  const vscode = acquireVsCodeApi();

  // Import constants from compiled DashboardConstants.js (loaded via script tag in HTML)
  // Single source of truth - these match src/types/DashboardConstants.ts
  // Only importing cross-file shared constants (not UI-specific strings)
  const {
    MESSAGE_TYPES,
    EXECUTION_STATES,
    STEP_STATUS,
    ACTION_TYPES,
    PROVIDER_IDS,
    DEFAULT_MODELS,
    CLAUDE_CLI_MODELS,
    CODEX_CLI_MODELS,
    PROMPT_PROPERTIES,
    END_CONDITION_PROPERTIES,
  } = window.FlightPathConstants;

  // Model options per provider - populated dynamically from ModelRegistry via INIT message
  // Chat models come from VS Code LM API (full list)
  // CLI models come from `copilot help config` (subset)
  // Claude CLI models are static (no programmatic way to query)
  // Codex CLI models are static (from codex /model command)
  let modelOptions = {
    [PROVIDER_IDS.COPILOT_CLI]: [],
    [PROVIDER_IDS.COPILOT_CHAT]: [],
    [PROVIDER_IDS.CLAUDE_CLI]: CLAUDE_CLI_MODELS,
    [PROVIDER_IDS.CODEX_CLI]: CODEX_CLI_MODELS,
  };

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
    savedNewPromptState: null, // Saved new prompt state when switching to edit mode
    hasActiveQueue: false, // Whether a workflow is currently loaded
    promptEditor: null, // PromptEditor instance (initialized after DOM load)
  };

  // State persistence (debounced to avoid excessive saves)
  let saveStateTimeout = null;
  const SAVE_STATE_DEBOUNCE_MS = 500;

  // Property control defaults (single source of truth)
  const PROPERTY_DEFAULTS = {
    PROVIDER: "default",
    MODEL: "default",
    AGENT: "",
    NEW_CHAT: "default",
    ALLOW_DYNAMIC: "default",
    END_SCRIPT: "",
    END_RETURNS: "",
    END_TIMEOUT: 30000,
    END_TIMEOUT_STRING: "30000",
    END_RETRIES: 0,
    END_RETRIES_STRING: "0",
    END_RETRY_PROMPT: "",
  };

  // DOM elements
  const elements = {
    workflowName: document.getElementById("workflow-name"),
    statusSeparator: document.getElementById("status-separator"),
    executionState: document.getElementById("execution-state"),
    loadFileBtn: document.getElementById("load-file"),
    appendFileBtn: document.getElementById("append-file"),
    newWorkflowBtn: document.getElementById("new-workflow"),
    fromTemplateBtn: document.getElementById("from-template"),
    runBtn: document.getElementById("btn-run"),
    pauseBtn: document.getElementById("btn-pause"),
    stopBtn: document.getElementById("btn-stop"),
    exportBtn: document.getElementById("btn-export"),
    promptCounter: document.getElementById("prompt-counter"),
    promptsList: document.getElementById("prompts-list"),
    promptsSection: document.getElementById("prompts-section"),
    outputSection: document.getElementById("output-section"),
    outputEditorContainer: document.getElementById("output-editor-container"),
    outputContent: document.getElementById("output-content"),
    autoscrollCheckbox: document.getElementById("autoscroll-checkbox"),
    btnCollapsePrompts: document.getElementById("btn-collapse-prompts"),
    btnCollapseOutput: document.getElementById("btn-collapse-output"),
    btnCollapseEditor: document.getElementById("btn-collapse-editor"),
    btnLayoutVertical: document.getElementById("btn-layout-vertical"),
    btnLayoutHorizontal: document.getElementById("btn-layout-horizontal"),
    btnSwapPanels: document.getElementById("btn-swap-panels"),
    editorSection: document.getElementById("editor-section"),
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
    // Editor elements
    editorModeIndicator: document.getElementById("editor-mode-indicator"),
    promptNameInput: document.getElementById("prompt-name-input"),
    btnNewPrompt: document.getElementById("btn-new-prompt"),
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
    // Properties drawer
    btnProperties: document.getElementById("btn-properties"),
    propertiesDrawer: document.getElementById("properties-drawer"),
    btnCloseDrawer: document.getElementById("btn-close-drawer"),
    // Editor action buttons
    btnEditorSend: document.getElementById("btn-editor-send"),
    btnEditorAdd: document.getElementById("btn-editor-add"),
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

  // ============================================================================
  // UTILITY HELPERS (extracted for reuse)
  // ============================================================================

  /**
   * Get current timestamp in milliseconds
   */
  function getTimestamp() {
    return new Date().getTime();
  }

  /**
   * Format timestamp as locale time string
   */
  function formatTime(timestampMs) {
    return new Date(timestampMs).toLocaleTimeString();
  }

  /**
   * Escape HTML special characters
   */
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Truncate string to maximum length
   */
  function truncate(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
  }

  /**
   * Get end condition value from object with fallback to default
   * @param {Object} endCondition - End condition object
   * @param {string} property - Property name from END_CONDITION_PROPERTIES
   * @param {any} defaultValue - Default value if not found
   */
  function getEndConditionValue(endCondition, property, defaultValue) {
    return endCondition && endCondition[property] !== undefined
      ? endCondition[property]
      : defaultValue;
  }

  /**
   * Create a prompt item with all properties preserved (DRY helper)
   * Used by handleFileSelected, handleSessionRestored, and handlePromptsExtended
   * @param {Object|string} prompt - Raw prompt object or string
   * @param {number} index - Prompt index in array
   * @param {string} status - Step status (pending, running, completed, failed)
   * @param {Object} details - Additional details object
   * @returns {Object} Prompt item with all properties
   */
  function createPromptItem(
    prompt,
    index,
    status = STEP_STATUS.PENDING,
    details = {}
  ) {
    return {
      index,
      text:
        typeof prompt === "string" ? prompt : prompt[PROMPT_PROPERTIES.PROMPT],
      status,
      details,
      // Preserve all prompt properties for editing using shared constants
      [PROMPT_PROPERTIES.PROVIDER]: prompt[PROMPT_PROPERTIES.PROVIDER],
      [PROMPT_PROPERTIES.MODEL]: prompt[PROMPT_PROPERTIES.MODEL],
      [PROMPT_PROPERTIES.AGENT]: prompt[PROMPT_PROPERTIES.AGENT],
      [PROMPT_PROPERTIES.NEW_CHAT_SESSION]:
        prompt[PROMPT_PROPERTIES.NEW_CHAT_SESSION],
      [PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION]:
        prompt[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION],
      [PROMPT_PROPERTIES.END_CONDITION]:
        prompt[PROMPT_PROPERTIES.END_CONDITION],
    };
  }

  /**
   * Build end condition object from current property control values
   * Only returns an object if BOTH required fields (script AND returns) are present
   * @returns {Object|undefined} End condition object or undefined if required fields missing
   */
  function buildEndConditionFromControls() {
    const script = elements.propEndScript.value.trim();
    const returns = elements.propEndReturns.value.trim();
    const retryPrompt = elements.propEndRetryPrompt.value.trim();
    const timeout = parseInt(elements.propEndTimeout.value, 10);
    const maxRetries = parseInt(elements.propEndRetries.value, 10);

    // Return undefined if required fields are missing (schema requires both script AND returns)
    if (!script || !returns) {
      return undefined;
    }

    // Build end condition with required fields and optional fields
    const endCondition = {
      [END_CONDITION_PROPERTIES.SCRIPT]: script,
      [END_CONDITION_PROPERTIES.RETURNS]: returns,
    };

    // Add optional fields only if they differ from defaults
    if (!isNaN(timeout) && timeout !== PROPERTY_DEFAULTS.END_TIMEOUT) {
      endCondition[END_CONDITION_PROPERTIES.TIMEOUT] = timeout;
    }
    if (!isNaN(maxRetries) && maxRetries !== PROPERTY_DEFAULTS.END_RETRIES) {
      endCondition[END_CONDITION_PROPERTIES.MAX_RETRIES] = maxRetries;
    }
    if (retryPrompt) {
      endCondition[END_CONDITION_PROPERTIES.RETRY_PROMPT] = retryPrompt;
    }

    return endCondition;
  }

  /**
   * Set end condition controls from end condition object
   * @param {Object} endCondition - End condition object or undefined
   */
  function setEndConditionControls(endCondition) {
    if (endCondition) {
      elements.propEndScript.value = getEndConditionValue(
        endCondition,
        END_CONDITION_PROPERTIES.SCRIPT,
        PROPERTY_DEFAULTS.END_SCRIPT
      );
      elements.propEndReturns.value = getEndConditionValue(
        endCondition,
        END_CONDITION_PROPERTIES.RETURNS,
        PROPERTY_DEFAULTS.END_RETURNS
      );
      elements.propEndTimeout.value = getEndConditionValue(
        endCondition,
        END_CONDITION_PROPERTIES.TIMEOUT,
        PROPERTY_DEFAULTS.END_TIMEOUT
      );
      elements.propEndRetries.value = getEndConditionValue(
        endCondition,
        END_CONDITION_PROPERTIES.MAX_RETRIES,
        PROPERTY_DEFAULTS.END_RETRIES
      );
      elements.propEndRetryPrompt.value = getEndConditionValue(
        endCondition,
        END_CONDITION_PROPERTIES.RETRY_PROMPT,
        PROPERTY_DEFAULTS.END_RETRY_PROMPT
      );
    } else {
      // Reset to defaults
      elements.propEndScript.value = PROPERTY_DEFAULTS.END_SCRIPT;
      elements.propEndReturns.value = PROPERTY_DEFAULTS.END_RETURNS;
      elements.propEndTimeout.value = PROPERTY_DEFAULTS.END_TIMEOUT_STRING;
      elements.propEndRetries.value = PROPERTY_DEFAULTS.END_RETRIES_STRING;
      elements.propEndRetryPrompt.value = PROPERTY_DEFAULTS.END_RETRY_PROMPT;
    }
  }

  // Event listeners
  elements.loadFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  });

  elements.appendFileBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
  });

  elements.newWorkflowBtn.addEventListener("click", () => {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  });

  elements.fromTemplateBtn.addEventListener("click", () => {
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

  // Properties drawer event listeners
  elements.btnProperties.addEventListener("click", () => {
    togglePropertiesDrawer();
  });

  elements.btnCloseDrawer.addEventListener("click", () => {
    closePropertiesDrawer();
  });

  // Provider dropdown change listener - update model dropdown dynamically
  elements.propProvider.addEventListener("change", (e) => {
    const selectedProvider = e.target.value;
    if (selectedProvider !== PROPERTY_DEFAULTS.PROVIDER) {
      updatePropertyModelDropdown(selectedProvider);
    }
  });

  // Section collapse event listeners
  elements.btnCollapsePrompts.addEventListener("click", () => {
    toggleSectionCollapse("prompts");
  });

  elements.btnCollapseOutput.addEventListener("click", () => {
    toggleSectionCollapse("output");
  });

  elements.btnCollapseEditor.addEventListener("click", () => {
    toggleSectionCollapse("editor");
  });

  // Layout toggle event listeners
  elements.btnLayoutVertical.addEventListener("click", () => {
    setLayoutMode("vertical");
  });

  elements.btnLayoutHorizontal.addEventListener("click", () => {
    setLayoutMode("horizontal");
  });

  elements.btnSwapPanels.addEventListener("click", () => {
    togglePanelSwap();
  });

  // Close drawer on overlay click (if we add one) or ESC key
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      elements.propertiesDrawer.classList.contains("open")
    ) {
      closePropertiesDrawer();
    }
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
      case MESSAGE_TYPES.MODEL_OPTIONS_UPDATE:
        handleModelOptionsUpdate(message.data);
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
        handleStatusMessage(message);
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
      // CodeMirror editor messages
      case MESSAGE_TYPES.COMPLETIONS_RESPONSE:
        console.log(
          `[Dashboard] Received COMPLETIONS_RESPONSE: ${message.items?.length} items, from=${message.from}`
        );
        if (
          editorState.promptEditor &&
          editorState.promptEditor.handleCompletionResponse
        ) {
          console.log(
            "[Dashboard] Calling promptEditor.handleCompletionResponse"
          );
          editorState.promptEditor.handleCompletionResponse(
            message.items,
            message.from
          );
        } else {
          console.log(
            "[Dashboard] Cannot handle completions - editor not ready or missing handler"
          );
        }
        break;
    }
  });

  function handleInit(data) {
    // Update model options from extension (dynamic from ModelRegistry)
    if (data.modelOptions) {
      modelOptions = { ...modelOptions, ...data.modelOptions };
    }

    state = { ...state, ...data };
    render();
  }

  /**
   * Handle model options update from extension (when ModelRegistry finishes loading)
   */
  function handleModelOptionsUpdate(data) {
    if (data.modelOptions) {
      modelOptions = { ...modelOptions, ...data.modelOptions };
      console.log(
        "[Dashboard] Model options updated:",
        Object.keys(modelOptions).map((k) => `${k}:${modelOptions[k].length}`)
      );
    }
  }

  function handleFileSelected(fileName, prompts) {
    // This handler is ONLY for IDLE state (user selects new file via Select button)
    // Queue extension during execution uses handleQueueExtended()
    console.log(`Dashboard: New file selected (${fileName}), resetting state`);

    state.fileName = fileName;
    state.prompts = prompts.map((p, i) => createPromptItem(p, i));

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
    state.prompts = prompts.map((p, i) =>
      createPromptItem(p, i, results[i]?.status || STEP_STATUS.PENDING, {})
    );

    // Reset outputs and retry states (not persisted in working file)
    state.cliOutputs = {};
    state.retryStates = {};
    state.statusMessages = {};

    // Update editor state - we have an active queue from restored session
    editorState.hasActiveQueue = prompts.length > 0;
    updateEditorMode();

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

    // Update editor state - we have an active queue now
    editorState.hasActiveQueue = true;
    updateEditorMode();

    // Update workflow status display
    updateWorkflowStatus(fileName, EXECUTION_STATES.RUNNING);
    updateLoadButtonState();
    updateAppendButtonState();
    updateButtonTooltips();

    updateControls();
    updatePromptCounter();
    renderPromptsList();
  }

  function handleExecutionStateChanged(executionState) {
    state.executionState = executionState;
    updateWorkflowStatus(state.fileName, executionState);
    updateLoadButtonState();
    updateButtonTooltips();
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

  function handleStatusMessage(messageData) {
    const stepIndex = messageData.stepIndex;
    console.log(
      "📝 Dashboard: Received status message for step",
      stepIndex,
      messageData
    );

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
        timestampMs: getTimestamp(),
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

    // Keep hasActiveQueue true - completed queue is still a queue
    // (Only set to false when queue is truly cleared/empty)

    updateWorkflowStatus(state.fileName, EXECUTION_STATES.COMPLETED);
    updateLoadButtonState();
    updateAppendButtonState();
    updateButtonTooltips();
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
      const text = typeof p === "string" ? p : p[PROMPT_PROPERTIES.PROMPT];
      const key = text.trim();
      const existing = existingStatusMap.get(key);

      return createPromptItem(
        p,
        i,
        existing?.status || STEP_STATUS.PENDING,
        existing?.details || {}
      );
    });

    state.totalSteps = state.prompts.length;

    // Update editor state - queue was extended so we definitely have an active queue
    editorState.hasActiveQueue = state.prompts.length > 0;
    updateEditorMode();

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

  function updatePromptCounter() {
    if (state.totalSteps > 0) {
      elements.promptCounter.textContent = `Completed ${state.currentStep} of ${state.totalSteps}`;
    } else {
      elements.promptCounter.textContent = "";
    }
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
  // PROPERTIES DRAWER FUNCTIONALITY
  // ============================================================================

  /**
   * Toggle properties drawer open/closed
   */
  function togglePropertiesDrawer() {
    if (elements.propertiesDrawer.classList.contains("open")) {
      closePropertiesDrawer();
    } else {
      openPropertiesDrawer();
    }
  }

  /**
   * Open properties drawer
   */
  function openPropertiesDrawer() {
    elements.propertiesDrawer.classList.add("open");
  }

  /**
   * Close properties drawer
   */
  function closePropertiesDrawer() {
    elements.propertiesDrawer.classList.remove("open");
  }

  // ============================================================================
  // SECTION COLLAPSE FUNCTIONALITY
  // ============================================================================

  /**
   * Toggle section collapse state (prompts, output, or editor)
   * @param {string} section - "prompts", "output", or "editor"
   */
  function toggleSectionCollapse(section) {
    let sectionElement, btn;

    if (section === "prompts") {
      sectionElement = elements.promptsSection;
      btn = elements.btnCollapsePrompts;
    } else if (section === "output") {
      sectionElement = elements.outputSection;
      btn = elements.btnCollapseOutput;
    } else if (section === "editor") {
      sectionElement = elements.editorSection;
      btn = elements.btnCollapseEditor;
    }

    const storageKey = `flightpath.section.${section}.collapsed`;

    // Toggle collapsed class
    const isCollapsed = sectionElement.classList.toggle("collapsed");

    // Save state to localStorage
    try {
      localStorage.setItem(storageKey, isCollapsed.toString());
    } catch (error) {
      console.warn(`Failed to save ${section} collapse state:`, error);
    }

    // Update button title
    btn.title = isCollapsed
      ? `Expand ${section} section`
      : `Collapse ${section} section`;
    btn.setAttribute(
      "aria-label",
      isCollapsed ? `Expand ${section}` : `Collapse ${section}`
    );
  }

  /**
   * Restore section collapse states from localStorage
   */
  function restoreSectionCollapseStates() {
    // Restore prompts section state
    try {
      const promptsCollapsed =
        localStorage.getItem("flightpath.section.prompts.collapsed") === "true";
      if (promptsCollapsed) {
        elements.promptsSection.classList.add("collapsed");
        elements.btnCollapsePrompts.title = "Expand prompts section";
        elements.btnCollapsePrompts.setAttribute(
          "aria-label",
          "Expand prompts"
        );
      }
    } catch (error) {
      console.warn("Failed to restore prompts collapse state:", error);
    }

    // Restore output section state
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

    // Restore editor section state
    try {
      const editorCollapsed =
        localStorage.getItem("flightpath.section.editor.collapsed") === "true";
      if (editorCollapsed) {
        elements.editorSection.classList.add("collapsed");
        elements.btnCollapseEditor.title = "Expand editor section";
        elements.btnCollapseEditor.setAttribute("aria-label", "Expand editor");
      }
    } catch (error) {
      console.warn("Failed to restore editor collapse state:", error);
    }
  }

  // ============================================================================
  // LAYOUT MODE FUNCTIONALITY
  // ============================================================================

  /**
   * Set the layout mode for output and editor sections
   * @param {string} mode - "vertical" or "horizontal"
   */
  function setLayoutMode(mode) {
    const storageKey = "flightpath.layout.mode";

    // Update container class
    if (mode === "horizontal") {
      elements.outputEditorContainer.classList.add("layout-horizontal");
    } else {
      elements.outputEditorContainer.classList.remove("layout-horizontal");
    }

    // Update button states
    if (mode === "horizontal") {
      elements.btnLayoutVertical.classList.remove("active");
      elements.btnLayoutHorizontal.classList.add("active");
    } else {
      elements.btnLayoutVertical.classList.add("active");
      elements.btnLayoutHorizontal.classList.remove("active");
    }

    // Save preference to localStorage
    try {
      localStorage.setItem(storageKey, mode);
    } catch (error) {
      console.warn("Failed to save layout mode:", error);
    }
  }

  /**
   * Restore layout mode from localStorage
   */
  function restoreLayoutMode() {
    const storageKey = "flightpath.layout.mode";

    try {
      const savedMode = localStorage.getItem(storageKey);
      if (savedMode === "horizontal") {
        setLayoutMode("horizontal");
      } else {
        // Default to vertical (no class needed)
        setLayoutMode("vertical");
      }
    } catch (error) {
      console.warn("Failed to restore layout mode:", error);
      // Default to vertical
      setLayoutMode("vertical");
    }
  }

  /**
   * Toggle the swap state of output and editor panels
   */
  function togglePanelSwap() {
    const storageKey = "flightpath.layout.swapped";
    const isCurrentlySwapped =
      elements.outputEditorContainer.classList.contains("swapped");

    if (isCurrentlySwapped) {
      elements.outputEditorContainer.classList.remove("swapped");
      elements.btnSwapPanels.classList.remove("active");
      try {
        localStorage.setItem(storageKey, "false");
      } catch (error) {
        console.warn("Failed to save panel swap state:", error);
      }
    } else {
      elements.outputEditorContainer.classList.add("swapped");
      elements.btnSwapPanels.classList.add("active");
      try {
        localStorage.setItem(storageKey, "true");
      } catch (error) {
        console.warn("Failed to save panel swap state:", error);
      }
    }
  }

  /**
   * Restore panel swap state from localStorage
   */
  function restorePanelSwap() {
    const storageKey = "flightpath.layout.swapped";

    try {
      const isSwapped = localStorage.getItem(storageKey) === "true";
      if (isSwapped) {
        elements.outputEditorContainer.classList.add("swapped");
        elements.btnSwapPanels.classList.add("active");
      }
    } catch (error) {
      console.warn("Failed to restore panel swap state:", error);
    }
  }

  // ============================================================================
  // STATE PERSISTENCE (using VS Code webview state API)
  // ============================================================================

  /**
   * Save current editor state to webview persistent storage
   * Debounced to avoid excessive saves during typing
   * Only saves when in new prompt mode (not when editing existing prompts)
   */
  function saveEditorState() {
    // Only save state for new prompt mode, not when editing existing prompts
    if (editorState.selectedPromptIndex !== null) {
      return;
    }

    if (saveStateTimeout) {
      clearTimeout(saveStateTimeout);
    }

    saveStateTimeout = setTimeout(() => {
      const currentText = editorState.promptEditor
        ? editorState.promptEditor.getText()
        : "";
      const promptName = elements.promptNameInput.value;

      const persistedState = {
        editorText: currentText,
        promptName: promptName,
        selectedPromptIndex: null, // Always null for new prompt state
        properties: getPropertyValues(),
      };

      vscode.setState(persistedState);
    }, SAVE_STATE_DEBOUNCE_MS);
  }

  /**
   * Restore editor state from webview persistent storage
   * Called during initialization
   */
  function restoreEditorState() {
    const persistedState = vscode.getState();

    if (!persistedState) {
      return;
    }

    // Restore editor text (only in new prompt mode)
    // Check for undefined/null explicitly, not truthiness, because empty string is valid
    if (
      persistedState.selectedPromptIndex === null &&
      persistedState.editorText !== undefined &&
      editorState.promptEditor
    ) {
      editorState.promptEditor.setText(persistedState.editorText);
    }

    // Restore prompt name
    if (persistedState.promptName) {
      elements.promptNameInput.value = persistedState.promptName;
    }

    // Restore property controls using shared constants
    if (persistedState.properties) {
      const props = persistedState.properties;
      const provider =
        props[PROMPT_PROPERTIES.PROVIDER] || PROPERTY_DEFAULTS.PROVIDER;
      elements.propProvider.value = provider;

      // Update model dropdown based on provider BEFORE setting the model value
      if (provider !== PROPERTY_DEFAULTS.PROVIDER) {
        updatePropertyModelDropdown(provider);
      }

      if (props[PROMPT_PROPERTIES.MODEL])
        elements.propModel.value =
          props[PROMPT_PROPERTIES.MODEL] || PROPERTY_DEFAULTS.MODEL;
      if (props[PROMPT_PROPERTIES.AGENT])
        elements.propAgent.value =
          props[PROMPT_PROPERTIES.AGENT] || PROPERTY_DEFAULTS.AGENT;

      const newChatSession = props[PROMPT_PROPERTIES.NEW_CHAT_SESSION];
      elements.propNewChat.value =
        newChatSession === undefined
          ? PROPERTY_DEFAULTS.NEW_CHAT
          : newChatSession
            ? "yes"
            : "no";

      const allowDynamic = props[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION];
      elements.propAllowDynamic.value =
        allowDynamic === undefined
          ? PROPERTY_DEFAULTS.ALLOW_DYNAMIC
          : allowDynamic
            ? "yes"
            : "no";

      // Use extracted helper for end condition controls
      const endCondition = props[PROMPT_PROPERTIES.END_CONDITION];
      setEndConditionControls(endCondition);
    }

    // Update metadata
    updateEditorMetadata();
  }

  // ============================================================================
  // EDITOR TAB FUNCTIONALITY
  // ============================================================================

  /**
   * Initialize the prompt editor with spell checking
   */
  function initializeEditor() {
    // Get dictionary file URIs from body data attributes
    const affUri = document.body.getAttribute("data-aff-uri");
    const dicUri = document.body.getAttribute("data-dic-uri");
    console.log("[Dashboard] .aff URI from data attribute:", affUri);
    console.log("[Dashboard] .dic URI from data attribute:", dicUri);
    console.log(
      "[Dashboard] window.Typo available:",
      typeof window.Typo !== "undefined"
    );
    console.log(
      "[Dashboard] window.CodeMirrorPromptEditor available:",
      typeof window.CodeMirrorPromptEditor !== "undefined"
    );

    // Initialize CodeMirror editor with spell checking
    // Wait for CodeMirror to be ready
    window.addEventListener(
      "codemirror-ready",
      () => {
        if (window.CodeMirrorPromptEditor) {
          console.log("[Dashboard] Initializing CodeMirror editor...");
          editorState.promptEditor = new window.CodeMirrorPromptEditor(
            elements.promptEditor,
            affUri,
            dicUri,
            vscode // Pass cached VS Code API instance
          );

          // Set up onChange callback for character/word count and state persistence
          editorState.promptEditor.onChange((text) => {
            updateEditorMetadata(text);
            saveEditorState(); // Persist editor state on every change
          });

          // Restore persisted state after editor is ready
          restoreEditorState();

          console.log(
            "[Dashboard] CodeMirror editor initialized:",
            !!editorState.promptEditor
          );
        }
      },
      { once: true }
    );

    // Handle CodeMirror loading error
    window.addEventListener(
      "codemirror-error",
      () => {
        console.error("[Dashboard] CodeMirror failed to load");
        showErrorMessage("Failed to initialize editor");
      },
      { once: true }
    );

    // New Prompt button (returns to new prompt mode from editing mode)
    elements.btnNewPrompt.addEventListener("click", () => {
      cancelEdit();
    });

    // Editor action buttons
    elements.btnEditorSend.addEventListener("click", () => {
      executePrompt(ACTION_TYPES.SEND);
    });

    elements.btnEditorAdd.addEventListener("click", () => {
      executePrompt(ACTION_TYPES.ADD);
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

    // Save state when prompt name changes
    elements.promptNameInput.addEventListener("input", () => {
      saveEditorState();
    });

    // Save state when property controls change
    elements.propProvider.addEventListener("change", saveEditorState);
    elements.propModel.addEventListener("change", saveEditorState);
    elements.propAgent.addEventListener("input", saveEditorState);
    elements.propNewChat.addEventListener("change", saveEditorState);
    elements.propAllowDynamic.addEventListener("change", saveEditorState);
    elements.propEndScript.addEventListener("input", saveEditorState);
    elements.propEndReturns.addEventListener("input", saveEditorState);
    elements.propEndTimeout.addEventListener("input", saveEditorState);
    elements.propEndRetries.addEventListener("input", saveEditorState);
    elements.propEndRetryPrompt.addEventListener("input", saveEditorState);

    // Update editor metadata initially
    updateEditorMetadata();
  }

  /**
   * Update character and word count in editor metadata
   */
  function updateEditorMetadata(text) {
    // If no text provided, get it from the editor
    if (text === undefined) {
      text = editorState.promptEditor ? editorState.promptEditor.getText() : "";
    }

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

    // Only include non-default values - use shared property name constants
    if (elements.propProvider.value !== PROPERTY_DEFAULTS.PROVIDER) {
      properties[PROMPT_PROPERTIES.PROVIDER] = elements.propProvider.value;
    }

    if (elements.propModel.value !== PROPERTY_DEFAULTS.MODEL) {
      properties[PROMPT_PROPERTIES.MODEL] = elements.propModel.value;
    }

    const agent = elements.propAgent.value.trim();
    if (agent && agent !== PROPERTY_DEFAULTS.AGENT) {
      properties[PROMPT_PROPERTIES.AGENT] = agent;
    }

    if (elements.propNewChat.value !== PROPERTY_DEFAULTS.NEW_CHAT) {
      properties[PROMPT_PROPERTIES.NEW_CHAT_SESSION] =
        elements.propNewChat.value === "yes";
    }

    if (elements.propAllowDynamic.value !== PROPERTY_DEFAULTS.ALLOW_DYNAMIC) {
      properties[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION] =
        elements.propAllowDynamic.value === "yes";
    }

    // Build end condition from controls (extracted helper)
    const endCondition = buildEndConditionFromControls();
    if (endCondition) {
      properties[PROMPT_PROPERTIES.END_CONDITION] = endCondition;
    }

    return properties;
  }

  /**
   * Reset property controls to default values
   */
  function resetPropertyControls() {
    elements.propProvider.value = PROPERTY_DEFAULTS.PROVIDER;
    elements.propModel.value = PROPERTY_DEFAULTS.MODEL;
    elements.propAgent.value = PROPERTY_DEFAULTS.AGENT;
    elements.propNewChat.value = PROPERTY_DEFAULTS.NEW_CHAT;
    elements.propAllowDynamic.value = PROPERTY_DEFAULTS.ALLOW_DYNAMIC;
    setEndConditionControls(undefined); // Use extracted helper
  }

  /**
   * Update the model dropdown in properties drawer based on selected provider
   * @param {string} provider - Provider ID (copilot-cli, copilot-chat, claude-cli, codex-cli)
   */
  function updatePropertyModelDropdown(provider) {
    const options = modelOptions[provider] || [];

    // Always show "Default" option first
    let optionsHtml = `<option value="${PROPERTY_DEFAULTS.MODEL}">Default</option>`;

    // Show loading state if no models yet (only for providers that need to load models)
    if (
      options.length === 0 &&
      (provider === PROVIDER_IDS.COPILOT_CLI ||
        provider === PROVIDER_IDS.COPILOT_CHAT)
    ) {
      optionsHtml += '<option value="" disabled>Loading models...</option>';
    } else {
      // Add all available models for this provider
      optionsHtml += options
        .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
        .join("");
    }

    elements.propModel.innerHTML = optionsHtml;
  }

  /**
   * Set property controls from a prompt object
   * @param {Object} prompt - PromptItem object
   */
  function setPropertyControls(prompt) {
    // Use shared property name constants for type safety
    const provider =
      prompt[PROMPT_PROPERTIES.PROVIDER] || PROPERTY_DEFAULTS.PROVIDER;
    elements.propProvider.value = provider;

    // Update model dropdown based on provider BEFORE setting the model value
    if (provider !== PROPERTY_DEFAULTS.PROVIDER) {
      updatePropertyModelDropdown(provider);
    }

    elements.propModel.value =
      prompt[PROMPT_PROPERTIES.MODEL] || PROPERTY_DEFAULTS.MODEL;
    elements.propAgent.value =
      prompt[PROMPT_PROPERTIES.AGENT] || PROPERTY_DEFAULTS.AGENT;

    const newChatSession = prompt[PROMPT_PROPERTIES.NEW_CHAT_SESSION];
    elements.propNewChat.value =
      newChatSession === undefined
        ? PROPERTY_DEFAULTS.NEW_CHAT
        : newChatSession
          ? "yes"
          : "no";

    const allowDynamic = prompt[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION];
    elements.propAllowDynamic.value =
      allowDynamic === undefined
        ? PROPERTY_DEFAULTS.ALLOW_DYNAMIC
        : allowDynamic
          ? "yes"
          : "no";

    // Use extracted helper for end condition controls
    const endCondition = prompt[PROMPT_PROPERTIES.END_CONDITION];
    setEndConditionControls(endCondition);
  }

  /**
   * Update editor mode indicator and button visibility
   */
  function updateEditorMode() {
    const isNewMode = editorState.selectedPromptIndex === null;

    if (isNewMode) {
      elements.editorModeIndicator.textContent = "New Prompt";
      elements.promptNameInput.style.display = ""; // Show name input in new mode
      elements.btnNewPrompt.style.display = "none"; // Hide New Prompt button

      // Show Send/Add buttons (always enabled)
      elements.btnEditorSend.style.display = "";
      elements.btnEditorSend.disabled = false;

      elements.btnEditorAdd.style.display = "";
      elements.btnEditorAdd.disabled = false;

      // Update tooltips based on workflow state
      updateButtonTooltips();

      // Hide editing buttons
      elements.btnEditorCancel.style.display = "none";
      elements.btnEditorUpdate.style.display = "none";
      elements.btnEditorDelete.style.display = "none";
    } else {
      const totalPrompts = state.prompts.length;
      elements.editorModeIndicator.textContent = `Editing: Prompt ${editorState.selectedPromptIndex + 1} of ${totalPrompts}`;
      elements.promptNameInput.style.display = "none"; // Hide name input in edit mode
      elements.btnNewPrompt.style.display = ""; // Show New Prompt button

      // Hide Send/Add buttons
      elements.btnEditorSend.style.display = "none";
      elements.btnEditorAdd.style.display = "none";

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
   * Update button tooltips based on current workflow state
   */
  function updateButtonTooltips() {
    const hasWorkflow = editorState.hasActiveQueue;
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isCompleted = state.executionState === EXECUTION_STATES.COMPLETED;
    const isIdle =
      state.executionState === EXECUTION_STATES.IDLE ||
      state.executionState === EXECUTION_STATES.READY;

    if (!hasWorkflow) {
      // No workflow: Send creates new and runs, Add creates new without running
      elements.btnEditorSend.title = "Send to new workflow";
      elements.btnEditorAdd.title = "Add to new workflow";
    } else if (isIdle) {
      // Idle workflow: Send appends and starts from beginning, Add just appends
      elements.btnEditorSend.title = "Send and run workflow";
      elements.btnEditorAdd.title = "Add to queue";
    } else if (isRunning) {
      // Running: Send appends and continues, Add just appends
      elements.btnEditorSend.title = "Send to current workflow";
      elements.btnEditorAdd.title = "Add to queue";
    } else if (isCompleted) {
      // Completed: Send appends and resumes, Add just appends
      elements.btnEditorSend.title = "Send and resume workflow";
      elements.btnEditorAdd.title = "Add to queue";
    }
  }

  /**
   * Execute a prompt (Send/Add)
   * @param {string} action - ACTION_TYPES.SEND or ACTION_TYPES.ADD
   */
  function executePrompt(action) {
    const text = editorState.promptEditor
      ? editorState.promptEditor.getText().trim()
      : "";

    if (!text) {
      return; // Don't execute empty prompts
    }

    const properties = getPropertyValues();
    const promptName = elements.promptNameInput.value.trim();

    vscode.postMessage({
      type: MESSAGE_TYPES.EXECUTE_PROMPT,
      text,
      properties,
      action,
      promptName, // Include user-entered prompt name
    });

    // Clear editor after all actions (Run/Append/AppendNext)
    // User can click the prompt in the queue to edit it further
    if (editorState.promptEditor) {
      editorState.promptEditor.clear();
    }
    elements.promptNameInput.value = ""; // Clear prompt name input
    resetPropertyControls();
    updateEditorMetadata();

    // Clear persisted state since prompt was submitted
    vscode.setState(null);
  }

  /**
   * Update an existing prompt in the queue
   */
  function updateExistingPrompt() {
    if (editorState.selectedPromptIndex === null) return;

    const text = editorState.promptEditor
      ? editorState.promptEditor.getText().trim()
      : "";

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
    const wasEditingExisting = editorState.selectedPromptIndex !== null;

    editorState.selectedPromptIndex = null;
    editorState.originalPromptData = null;

    if (wasEditingExisting) {
      // Cancelled editing an existing prompt - restore the saved new prompt state
      if (editorState.savedNewPromptState) {
        // Restore editor text
        if (editorState.promptEditor) {
          editorState.promptEditor.setText(
            editorState.savedNewPromptState.editorText || ""
          );
        }

        // Restore prompt name
        elements.promptNameInput.value =
          editorState.savedNewPromptState.promptName || "";

        // Restore properties
        const props = editorState.savedNewPromptState.properties || {};

        // If no saved properties (all were defaults), reset to defaults
        if (Object.keys(props).length === 0) {
          resetPropertyControls();
        } else {
          // Restore saved property values
          const provider =
            props[PROMPT_PROPERTIES.PROVIDER] || PROPERTY_DEFAULTS.PROVIDER;
          elements.propProvider.value = provider;

          // Update model dropdown based on provider BEFORE setting the model value
          if (provider !== PROPERTY_DEFAULTS.PROVIDER) {
            updatePropertyModelDropdown(provider);
          }

          elements.propModel.value =
            props[PROMPT_PROPERTIES.MODEL] || PROPERTY_DEFAULTS.MODEL;
          elements.propAgent.value =
            props[PROMPT_PROPERTIES.AGENT] || PROPERTY_DEFAULTS.AGENT;

          const newChatSession = props[PROMPT_PROPERTIES.NEW_CHAT_SESSION];
          elements.propNewChat.value =
            newChatSession === undefined
              ? PROPERTY_DEFAULTS.NEW_CHAT
              : newChatSession
                ? "yes"
                : "no";

          const allowDynamic = props[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION];
          elements.propAllowDynamic.value =
            allowDynamic === undefined
              ? PROPERTY_DEFAULTS.ALLOW_DYNAMIC
              : allowDynamic
                ? "yes"
                : "no";

          const endCondition = props[PROMPT_PROPERTIES.END_CONDITION];
          setEndConditionControls(endCondition);
        }

        // Clear the saved state after restoring
        editorState.savedNewPromptState = null;
      } else {
        // No saved state, fall back to defaults
        resetPropertyControls();
        if (editorState.promptEditor) {
          editorState.promptEditor.setText("");
        }
        elements.promptNameInput.value = "";
      }
    }
    // If already in new prompt mode, editor state is already current

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

    // ONLY save new prompt state if we're currently in new prompt mode
    // If we're already editing a prompt, don't overwrite the saved new prompt state
    if (editorState.selectedPromptIndex === null) {
      editorState.savedNewPromptState = {
        editorText: editorState.promptEditor
          ? editorState.promptEditor.getText()
          : "",
        promptName: elements.promptNameInput.value,
        properties: getPropertyValues(),
      };
    }

    // Store original data for cancel functionality
    editorState.selectedPromptIndex = index;
    editorState.originalPromptData = { ...prompt };

    // Load prompt text into editor
    // Note: onChange will fire but saveEditorState will skip since we're in edit mode
    if (editorState.promptEditor) {
      editorState.promptEditor.setText(prompt.text || "");
    }

    // Load property controls
    setPropertyControls(prompt);

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

  // Restore section collapse states from localStorage
  restoreSectionCollapseStates();

  // Restore layout mode from localStorage
  restoreLayoutMode();

  // Restore panel swap state from localStorage
  restorePanelSwap();

  // Signal ready
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
