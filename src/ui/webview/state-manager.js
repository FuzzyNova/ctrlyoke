/**
 * FlightPath Dashboard State Manager Module
 *
 * Centralized state management with immutable accessors and computed properties.
 * Prevents direct mutations and provides single source of truth for all state.
 *
 * Exports:
 * - State access: getState, updateState, getEditorState, updateEditorState, getModalState, updateModalState
 * - Model options: getModelOptions, setModelOptions
 * - State persistence: saveEditorState, restoreEditorState
 * - State queries: hasPendingPrompts, getCurrentPrompt, getPromptByIndex, getExecutionState, isWorkflowRunning
 * - Property defaults: getPropertyDefaults
 */
(function () {
  // Import constants from global scope (loaded via script tag in HTML)
  const {
    EXECUTION_STATES,
    STEP_STATUS,
    PROMPT_PROPERTIES,
    PROVIDER_IDS,
    CLAUDE_CLI_MODELS,
    CODEX_CLI_MODELS,
  } = window.FlightPathConstants;

  // Private state (closure prevents direct mutation)
  let state = {
    fileName: null,
    workflowName: null, // Custom workflow name (from working file)
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

  // Modal state
  let modalState = {
    templates: [],
    currentTemplate: null,
    workflowsDir: ".flightpath/workflows",
    defaultTemplateId: "blank",
  };

  // Model options per provider - populated dynamically from ModelRegistry via INIT message
  let modelOptions = {
    [PROVIDER_IDS.COPILOT_CLI]: [],
    [PROVIDER_IDS.COPILOT_CHAT]: [],
    [PROVIDER_IDS.CLAUDE_CLI]: CLAUDE_CLI_MODELS,
    [PROVIDER_IDS.CODEX_CLI]: CODEX_CLI_MODELS,
  };

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

  // State persistence
  let vscode = null;
  let elements = null;
  let saveStateTimeout = null;
  const SAVE_STATE_DEBOUNCE_MS = 500;

  /**
   * Initialize state manager with dependencies
   * @param {Object} _vscode - VS Code API instance
   * @param {Object} _elements - DOM elements object
   */
  function init(_vscode, _elements) {
    vscode = _vscode;
    elements = _elements;
  }

  /**
   * Get immutable copy of main state
   * @returns {Object} Copy of state to prevent direct mutations
   */
  function getState() {
    return { ...state };
  }

  /**
   * Update main state (single source of truth for updates)
   * @param {Object} updates - Partial state object to merge
   */
  function updateState(updates) {
    state = { ...state, ...updates };
  }

  /**
   * Get immutable copy of editor state
   * @returns {Object} Copy of editor state
   */
  function getEditorState() {
    return { ...editorState };
  }

  /**
   * Update editor state
   * @param {Object} updates - Partial editor state object to merge
   */
  function updateEditorState(updates) {
    editorState = { ...editorState, ...updates };
  }

  /**
   * Get immutable copy of modal state
   * @returns {Object} Copy of modal state
   */
  function getModalState() {
    return { ...modalState };
  }

  /**
   * Update modal state
   * @param {Object} updates - Partial modal state object to merge
   */
  function updateModalState(updates) {
    modalState = { ...modalState, ...updates };
  }

  /**
   * Get model options for all providers
   * @returns {Object} Model options per provider
   */
  function getModelOptions() {
    return modelOptions;
  }

  /**
   * Set model options from ModelRegistry
   * @param {Object} options - Model options per provider
   */
  function setModelOptions(options) {
    modelOptions = { ...modelOptions, ...options };
  }

  /**
   * Get property defaults
   * @returns {Object} Property defaults
   */
  function getPropertyDefaults() {
    return { ...PROPERTY_DEFAULTS };
  }

  /**
   * Check if there are pending prompts in the queue
   * Returns true if there are prompts that haven't been executed yet
   * Used to determine whether Run button should say "Run" or "Run Next"
   * @returns {boolean} True if there are pending prompts
   */
  function hasPendingPrompts() {
    if (state.prompts.length === 0) {
      return false;
    }

    // If we're idle, check if this is a fresh workflow or resumed workflow
    if (state.executionState === EXECUTION_STATES.IDLE) {
      // Fresh workflow (not started yet) - no pending prompts, just "Run"
      if (state.currentStep === 0) {
        return false;
      }
      // Resumed workflow (some prompts completed) - has pending prompts, show "Run Next"
      return state.currentStep < state.totalSteps;
    }

    // If stopped, there are pending prompts (current was cancelled, may have more after)
    if (state.executionState === EXECUTION_STATES.STOPPED) {
      return state.currentStep < state.totalSteps;
    }

    // If running/paused, check if there are prompts after current step
    if (
      state.executionState === EXECUTION_STATES.RUNNING ||
      state.executionState === EXECUTION_STATES.PAUSED
    ) {
      return state.currentStep < state.totalSteps;
    }

    // If completed, no pending prompts
    return false;
  }

  /**
   * Get current prompt being executed
   * @returns {Object|null} Current prompt or null
   */
  function getCurrentPrompt() {
    if (state.currentStep >= 0 && state.currentStep < state.prompts.length) {
      return state.prompts[state.currentStep];
    }
    return null;
  }

  /**
   * Get prompt by index
   * @param {number} index - Prompt index
   * @returns {Object|null} Prompt at index or null
   */
  function getPromptByIndex(index) {
    if (index >= 0 && index < state.prompts.length) {
      return state.prompts[index];
    }
    return null;
  }

  /**
   * Get current execution state
   * @returns {string} Execution state
   */
  function getExecutionState() {
    return state.executionState;
  }

  /**
   * Check if workflow is currently running
   * @returns {boolean} True if running
   */
  function isWorkflowRunning() {
    return state.executionState === EXECUTION_STATES.RUNNING;
  }

  /**
   * Save current editor state to webview persistent storage
   * Debounced to avoid excessive saves during typing
   * Only saves when in new prompt mode (not when editing existing prompts)
   *
   * Note: Requires getPropertyValues callback to be set via setGetPropertyValuesCallback
   */
  let getPropertyValuesCallback = null;

  function setGetPropertyValuesCallback(callback) {
    getPropertyValuesCallback = callback;
  }

  function saveEditorState() {
    // Only save state for new prompt mode, not when editing existing prompts
    if (editorState.selectedPromptIndex !== null) {
      return;
    }

    if (!vscode || !elements) {
      console.warn("State manager not initialized with vscode/elements");
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
        properties: getPropertyValuesCallback
          ? getPropertyValuesCallback()
          : {},
      };

      vscode.setState(persistedState);
    }, SAVE_STATE_DEBOUNCE_MS);
  }

  /**
   * Restore editor state from webview persistent storage
   * Called during initialization
   *
   * Note: Requires setPropertyControls and updatePropertyModelDropdown callbacks to be set
   */
  let setPropertyControlsCallback = null;
  let updatePropertyModelDropdownCallback = null;
  let updateEditorMetadataCallback = null;

  function setSetPropertyControlsCallback(callback) {
    setPropertyControlsCallback = callback;
  }

  function setUpdatePropertyModelDropdownCallback(callback) {
    updatePropertyModelDropdownCallback = callback;
  }

  function setUpdateEditorMetadataCallback(callback) {
    updateEditorMetadataCallback = callback;
  }

  function restoreEditorState() {
    if (!vscode || !elements) {
      console.warn("State manager not initialized with vscode/elements");
      return;
    }

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
      if (
        provider !== PROPERTY_DEFAULTS.PROVIDER &&
        updatePropertyModelDropdownCallback
      ) {
        updatePropertyModelDropdownCallback(provider);
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

      // Use callback for end condition controls
      const endCondition = props[PROMPT_PROPERTIES.END_CONDITION];
      if (setPropertyControlsCallback) {
        setPropertyControlsCallback(endCondition);
      }
    }

    // Update metadata
    if (updateEditorMetadataCallback) {
      updateEditorMetadataCallback();
    }
  }

  // Export public API to global scope
  window.FlightPathStateManager = {
    init,
    getState,
    updateState,
    getEditorState,
    updateEditorState,
    getModalState,
    updateModalState,
    getModelOptions,
    setModelOptions,
    getPropertyDefaults,
    hasPendingPrompts,
    getCurrentPrompt,
    getPromptByIndex,
    getExecutionState,
    isWorkflowRunning,
    saveEditorState,
    restoreEditorState,
    setGetPropertyValuesCallback,
    setSetPropertyControlsCallback,
    setUpdatePropertyModelDropdownCallback,
    setUpdateEditorMetadataCallback,
  };
})();
