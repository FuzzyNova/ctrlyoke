/**
 * FlightPath Dashboard Message Router Module
 *
 * Central message handler that routes messages from the extension to appropriate managers.
 * Implements handler registry pattern to eliminate switch/case statements.
 *
 * Exports:
 * - init: Initialize with dependencies and set up message listener
 * - renderExecutionState: Render execution state indicator
 * - renderAll: Full render of all UI components
 * - updateControls: Update control button states
 */
(function () {
  // Import constants from global scope
  const { MESSAGE_TYPES, EXECUTION_STATES, STEP_STATUS } =
    window.FlightPathConstants;

  // Dependencies (injected via init)
  let vscode = null;
  let elements = null;
  let stateManager = null;
  let outputManager = null;
  let promptsManager = null;
  let workflowManager = null;
  let editorManager = null;

  // Message handler registry
  const messageHandlers = {};

  /**
   * Initialize message router with dependencies
   * @param {Object} _vscode - VS Code API instance
   * @param {Object} _elements - DOM elements object
   * @param {Object} _stateManager - State manager instance
   * @param {Object} _outputManager - Output manager instance
   * @param {Object} _promptsManager - Prompts manager instance
   * @param {Object} _workflowManager - Workflow manager instance
   * @param {Object} _editorManager - Editor manager instance
   */
  function init(
    _vscode,
    _elements,
    _stateManager,
    _outputManager,
    _promptsManager,
    _workflowManager,
    _editorManager
  ) {
    vscode = _vscode;
    elements = _elements;
    stateManager = _stateManager;
    outputManager = _outputManager;
    promptsManager = _promptsManager;
    workflowManager = _workflowManager;
    editorManager = _editorManager;

    // Register message handlers
    registerMessageHandlers();

    // Set up global message listener
    window.addEventListener("message", handleMessage);

    // Set up control button listeners
    setupControlListeners();
  }

  /**
   * Register all message handlers in the registry
   */
  function registerMessageHandlers() {
    // Global state messages
    messageHandlers[MESSAGE_TYPES.INIT] = handleInit;
    messageHandlers[MESSAGE_TYPES.MODEL_OPTIONS_UPDATE] =
      handleModelOptionsUpdate;
    messageHandlers[MESSAGE_TYPES.EXECUTION_STARTED] = handleExecutionStarted;
    messageHandlers[MESSAGE_TYPES.EXECUTION_STATE_CHANGED] =
      handleExecutionStateChanged;
    messageHandlers[MESSAGE_TYPES.PROGRESS_UPDATE] = handleProgressUpdate;
    messageHandlers[MESSAGE_TYPES.EXECUTION_COMPLETED] =
      handleExecutionCompleted;
    messageHandlers[MESSAGE_TYPES.STEP_STATUS_CHANGED] =
      handleStepStatusChanged;
    messageHandlers[MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED] =
      handleRetryAttemptChanged;

    // Prompts-related messages
    messageHandlers[MESSAGE_TYPES.FILE_SELECTED] = (message) =>
      promptsManager.handleMessageFileSelected(
        message.fileName,
        message.prompts
      );
    messageHandlers[MESSAGE_TYPES.SESSION_RESTORED] = (message) =>
      promptsManager.handleMessageSessionRestored(
        message.fileName,
        message.prompts,
        message.results,
        message.executionState,
        message.currentIndex
      );
    messageHandlers[MESSAGE_TYPES.PROMPTS_EXTENDED] = (message) =>
      promptsManager.handleMessagePromptsExtended(message.prompts);
    messageHandlers[MESSAGE_TYPES.PROMPT_DELETED] = (message) =>
      promptsManager.handleMessagePromptDeleted(
        message.fileName,
        message.prompts
      );

    // Output-related messages
    messageHandlers[MESSAGE_TYPES.CLI_OUTPUT] = (message) =>
      outputManager.handleCliOutput(message.stepIndex, message.output);
    messageHandlers[MESSAGE_TYPES.CLI_STREAMING_CHUNK] = (message) => {
      console.log(
        `🔍 Dashboard: Received CLI_STREAMING_CHUNK message, stepIndex=${message.stepIndex}, chunk length=${message.chunk?.length}`
      );
      outputManager.handleCliStreamingChunk(message.stepIndex, message.chunk);
    };
    messageHandlers[MESSAGE_TYPES.STATUS_MESSAGE] = (message) =>
      outputManager.handleStatusMessage(message);

    // Workflow-related messages
    messageHandlers[MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL] = (message) =>
      workflowManager.handleMessageOpenNewWorkflowModal(message);
    messageHandlers[MESSAGE_TYPES.TEMPLATE_INFO] = (message) =>
      workflowManager.handleMessageTemplateInfo(message);
    messageHandlers[MESSAGE_TYPES.DEFAULT_TEMPLATE_SET] = (message) =>
      workflowManager.handleMessageDefaultTemplateSet(message);
    messageHandlers[MESSAGE_TYPES.WORKFLOW_CREATED] = (message) =>
      workflowManager.handleMessageWorkflowCreated(message);
    messageHandlers[MESSAGE_TYPES.CLOSE_MODAL] = () =>
      workflowManager.handleMessageCloseModal();

    // Editor-related messages
    messageHandlers[MESSAGE_TYPES.COMPLETIONS_RESPONSE] = (message) => {
      console.log(
        `[Dashboard] Received COMPLETIONS_RESPONSE: ${message.items?.length} items, from=${message.from}`
      );
      editorManager.handleMessageCompletionsResponse(
        message.items,
        message.from
      );
    };
  }

  /**
   * Handle incoming messages from extension
   */
  function handleMessage(event) {
    const message = event.data;

    // Look up handler in registry
    const handler = messageHandlers[message.type];

    if (handler) {
      handler(message);
    } else {
      console.warn(`Unknown message type: ${message.type}`);
    }
  }

  /**
   * Set up control button event listeners
   */
  function setupControlListeners() {
    elements.runBtn.addEventListener("click", () => {
      vscode.postMessage({ type: MESSAGE_TYPES.RUN });
    });

    elements.pauseBtn.addEventListener("click", () => {
      const state = stateManager.getState();
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
  }

  // ============================================================================
  // MESSAGE HANDLERS
  // ============================================================================

  /**
   * Handle INIT message - initial state from extension
   */
  function handleInit(data) {
    // Update model options from extension (dynamic from ModelRegistry)
    if (data.modelOptions) {
      stateManager.setModelOptions(data.modelOptions);
    }

    // Update state
    stateManager.updateState(data);

    // Initialize UI
    editorManager.updateEditorButtons();
    editorManager.updateNewWorkflowCheckbox();
    renderAll();
  }

  /**
   * Handle MODEL_OPTIONS_UPDATE message
   */
  function handleModelOptionsUpdate(data) {
    if (data.modelOptions) {
      stateManager.setModelOptions(data.modelOptions);
      const modelOptions = stateManager.getModelOptions();
      console.log(
        "[Dashboard] Model options updated:",
        Object.keys(modelOptions).map((k) => `${k}:${modelOptions[k].length}`)
      );
    }
  }

  /**
   * Handle EXECUTION_STARTED message
   */
  function handleExecutionStarted(message) {
    const state = stateManager.getState();

    stateManager.updateState({
      fileName: message.fileName,
      executionState: EXECUTION_STATES.RUNNING,
      totalSteps: message.totalSteps,
      currentStep: 0,
    });

    // Reset all prompts to pending state (for restart scenario)
    const resetPrompts = state.prompts.map((prompt) => ({
      ...prompt,
      status: STEP_STATUS.PENDING,
      details: {},
    }));

    stateManager.updateState({
      prompts: resetPrompts,
      cliOutputs: {},
      retryStates: {},
      statusMessages: {},
    });

    // Clear CLI output
    elements.outputContent.innerHTML =
      '<p class="empty-state">CLI output will appear here during execution</p>';

    // Update editor state - we have an active queue now
    stateManager.updateEditorState({ hasActiveQueue: true });
    editorManager.updateEditorMode();

    // Update workflow status display
    workflowManager.updateWorkflowStatus(
      message.fileName,
      EXECUTION_STATES.RUNNING
    );
    workflowManager.updateNewWorkflowButtonState();
    editorManager.updateButtonTooltips();

    updateControls();
    promptsManager.updatePromptCounter();
    promptsManager.renderPromptsList();
  }

  /**
   * Handle EXECUTION_STATE_CHANGED message
   */
  function handleExecutionStateChanged(message) {
    const state = stateManager.getState();

    stateManager.updateState({ executionState: message.state });

    workflowManager.updateWorkflowStatus(state.fileName, message.state);
    workflowManager.updateNewWorkflowButtonState();
    editorManager.updateEditorButtons();
    editorManager.updateNewWorkflowCheckbox();
    editorManager.updateButtonTooltips();
    renderAll();
  }

  /**
   * Handle PROGRESS_UPDATE message
   */
  function handleProgressUpdate(message) {
    stateManager.updateState({
      currentStep: message.current,
      totalSteps: message.total,
    });
    promptsManager.updatePromptCounter();
  }

  /**
   * Handle STEP_STATUS_CHANGED message
   */
  function handleStepStatusChanged(message) {
    const state = stateManager.getState();

    if (state.prompts[message.stepIndex]) {
      const updatedPrompts = [...state.prompts];
      updatedPrompts[message.stepIndex] = {
        ...updatedPrompts[message.stepIndex],
        status: message.status.state,
        details: { ...message.status, ...message.details },
      };

      stateManager.updateState({ prompts: updatedPrompts });
      promptsManager.renderPromptsList();
    }
  }

  /**
   * Handle RETRY_ATTEMPT_CHANGED message
   */
  function handleRetryAttemptChanged(message) {
    const state = stateManager.getState();
    const retryStates = { ...state.retryStates };
    retryStates[message.stepIndex] = {
      currentRetry: message.currentRetry,
      maxRetries: message.maxRetries,
    };

    stateManager.updateState({ retryStates });
    promptsManager.renderPromptsList();
  }

  /**
   * Handle EXECUTION_COMPLETED message
   */
  function handleExecutionCompleted() {
    stateManager.updateState({ executionState: EXECUTION_STATES.COMPLETED });

    const state = stateManager.getState();

    // Keep hasActiveQueue true - completed queue is still a queue
    // (Only set to false when queue is truly cleared/empty)

    workflowManager.updateWorkflowStatus(
      state.fileName,
      EXECUTION_STATES.COMPLETED
    );
    editorManager.updateAppendButtonState();
    editorManager.updateButtonTooltips();
    updateControls();
  }

  // ============================================================================
  // RENDERING FUNCTIONS
  // ============================================================================

  /**
   * Render the execution state indicator
   */
  function renderExecutionState() {
    const state = stateManager.getState();

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

  /**
   * Full render of all UI components
   */
  function renderAll() {
    const state = stateManager.getState();

    workflowManager.updateWorkflowStatus(state.fileName, state.executionState);
    renderExecutionState();
    promptsManager.renderPromptsList();
    updateControls();
    editorManager.updateAppendButtonState();
    promptsManager.updatePromptCounter();
  }

  /**
   * Update control button states based on current execution state
   */
  function updateControls() {
    const state = stateManager.getState();
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

  // Export public API to global scope
  window.FlightPathMessageRouter = {
    init,
    renderExecutionState,
    renderAll,
    updateControls,
  };
})();
