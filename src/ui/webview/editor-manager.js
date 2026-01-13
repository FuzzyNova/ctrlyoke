/**
 * FlightPath Dashboard Editor Manager Module
 *
 * Manages the CodeMirror prompt editor, properties drawer, prompt CRUD operations,
 * and editor state management.
 *
 * Exports:
 * - init: Initialize with dependencies
 * - selectPromptForEdit: Load a prompt into the editor for editing
 * - handleMessageCompletionsResponse: Handle completion suggestions from extension
 * - hasPendingPrompts: Check if there are pending prompts in the queue
 * - updateEditorButtons: Update Run/Queue button text based on queue state
 * - updateNewWorkflowCheckbox: Update checkbox visibility and state
 * - updateButtonTooltips: Update button tooltips based on workflow state
 * - updateAppendButtonState: Update append button state
 * - updateEditorMode: Update editor mode indicator and button visibility
 * - togglePropertiesDrawer: Toggle properties drawer open/closed
 * - toggleEditorSection: Toggle editor section collapse
 * - restoreEditorCollapseState: Restore collapse state from localStorage
 * - refreshModelDropdown: Refresh model dropdown with current provider's models
 * - cancelEdit: Cancel editing and return to new prompt mode (also used when workflow changes)
 */
(function () {
  // Import constants and utilities from global scope
  const {
    MESSAGE_TYPES,
    EXECUTION_STATES,
    STEP_STATUS,
    ACTION_TYPES,
    PROMPT_PROPERTIES,
    END_CONDITION_PROPERTIES,
    PROVIDER_IDS,
  } = window.FlightPathConstants;
  const {
    getEndConditionValue,
    buildEndConditionFromControls,
    setEndConditionControls,
  } = window.FlightPathUtilities;

  // Import gpt-tokenizer from global scope (loaded via script tag)
  const { encode } = window.gptTokenizer;

  // Dependencies (injected via init)
  let vscode = null;
  let elements = null;
  let stateManager = null;

  // State persistence
  let saveStateTimeout = null;
  const SAVE_STATE_DEBOUNCE_MS = 500;

  /**
   * Initialize editor manager with dependencies
   * @param {Object} _vscode - VS Code API instance
   * @param {Object} _elements - DOM elements object
   * @param {Object} _stateManager - State manager instance
   */
  function init(_vscode, _elements, _stateManager) {
    vscode = _vscode;
    elements = _elements;
    stateManager = _stateManager;

    // Initialize the editor when DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initializeEditor);
    } else {
      initializeEditor();
    }
  }

  /**
   * Initialize the prompt editor with spell checking and event listeners
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
          const editorState = stateManager.getEditorState();
          const editor = new window.CodeMirrorPromptEditor(
            elements.promptEditor,
            affUri,
            dicUri,
            vscode // Pass cached VS Code API instance
          );

          stateManager.updateEditorState({ promptEditor: editor });

          // Set up onChange callback for character/word count and state persistence
          editor.onChange((text) => {
            updateEditorMetadata(text);
            saveEditorState(); // Persist editor state on every change
          });

          // Restore persisted state after editor is ready
          restoreEditorState();

          console.log("[Dashboard] CodeMirror editor initialized:", !!editor);
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

    // Set up event listeners
    setupEventListeners();

    // Update editor metadata initially
    updateEditorMetadata();
  }

  /**
   * Set up event listeners for editor section
   */
  function setupEventListeners() {
    // New Prompt button (returns to new prompt mode from editing mode)
    elements.btnNewPrompt.addEventListener("click", () => {
      cancelEdit();
    });

    // Editor action buttons
    elements.btnEditorRun.addEventListener("click", () => {
      executePrompt(ACTION_TYPES.RUN);
    });

    elements.btnEditorQueue.addEventListener("click", () => {
      executePrompt(ACTION_TYPES.QUEUE);
    });

    elements.btnEditorUpdate.addEventListener("click", updateExistingPrompt);

    elements.btnEditorCancel.addEventListener("click", cancelEdit);

    console.log(
      "[Dashboard] Attaching delete button listener, button element:",
      elements.btnEditorDelete
    );
    elements.btnEditorDelete.addEventListener("click", () => {
      console.log("[Dashboard] Delete button clicked!");
      deletePrompt();
    });

    // Save state when prompt name changes
    elements.promptNameInput.addEventListener("input", () => {
      saveEditorState();
    });

    // Properties drawer toggle
    elements.btnProperties.addEventListener("click", () => {
      togglePropertiesDrawer();
    });

    elements.btnCloseDrawer.addEventListener("click", () => {
      closePropertiesDrawer();
    });

    // Provider dropdown change listener - update model dropdown dynamically
    elements.propProvider.addEventListener("change", (e) => {
      const selectedProvider = e.target.value;
      const propertyDefaults = stateManager.getPropertyDefaults();
      if (selectedProvider !== propertyDefaults.PROVIDER) {
        updatePropertyModelDropdown(selectedProvider);
      }
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

    // Section collapse button
    elements.btnCollapseEditor.addEventListener("click", () => {
      toggleEditorSection();
    });

    // Close drawer on ESC key
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        elements.propertiesDrawer.classList.contains("open")
      ) {
        closePropertiesDrawer();
      }
    });
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
  // STATE PERSISTENCE
  // ============================================================================

  /**
   * Save current editor state to webview persistent storage
   * Debounced to avoid excessive saves during typing
   * Only saves when in new prompt mode (not when editing existing prompts)
   */
  function saveEditorState() {
    const editorState = stateManager.getEditorState();

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
    const editorState = stateManager.getEditorState();

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
      const propertyDefaults = stateManager.getPropertyDefaults();
      const provider =
        props[PROMPT_PROPERTIES.PROVIDER] || propertyDefaults.PROVIDER;
      elements.propProvider.value = provider;

      // Update model dropdown based on provider BEFORE setting the model value
      if (provider !== propertyDefaults.PROVIDER) {
        updatePropertyModelDropdown(provider);
      }

      if (props[PROMPT_PROPERTIES.MODEL])
        elements.propModel.value =
          props[PROMPT_PROPERTIES.MODEL] || propertyDefaults.MODEL;
      if (props[PROMPT_PROPERTIES.AGENT])
        elements.propAgent.value =
          props[PROMPT_PROPERTIES.AGENT] || propertyDefaults.AGENT;

      const newChatSession = props[PROMPT_PROPERTIES.NEW_CHAT_SESSION];
      elements.propNewChat.value =
        newChatSession === undefined
          ? propertyDefaults.NEW_CHAT
          : newChatSession
            ? "yes"
            : "no";

      const allowDynamic = props[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION];
      elements.propAllowDynamic.value =
        allowDynamic === undefined
          ? propertyDefaults.ALLOW_DYNAMIC
          : allowDynamic
            ? "yes"
            : "no";

      // Use extracted helper for end condition controls
      const endCondition = props[PROMPT_PROPERTIES.END_CONDITION];
      setEndConditionControls(elements, propertyDefaults, endCondition);
    }

    // Update metadata
    updateEditorMetadata();
  }

  // ============================================================================
  // EDITOR METADATA
  // ============================================================================

  /**
   * Update token count in editor metadata
   */
  function updateEditorMetadata(text) {
    const editorState = stateManager.getEditorState();

    // If no text provided, get it from the editor
    if (text === undefined) {
      text = editorState.promptEditor ? editorState.promptEditor.getText() : "";
    }

    // Count tokens using gpt-tokenizer (works for GPT-4, Claude models use similar tokenization)
    const tokenCount = text.length > 0 ? encode(text).length : 0;

    elements.editorTokenCount.textContent = `${tokenCount.toLocaleString()} token${tokenCount !== 1 ? "s" : ""}`;
  }

  // ============================================================================
  // PROPERTY CONTROLS
  // ============================================================================

  /**
   * Get current property values from the UI
   * @returns {Object} Property values
   */
  function getPropertyValues() {
    const properties = {};
    const propertyDefaults = stateManager.getPropertyDefaults();

    // Only include non-default values - use shared property name constants
    if (elements.propProvider.value !== propertyDefaults.PROVIDER) {
      properties[PROMPT_PROPERTIES.PROVIDER] = elements.propProvider.value;
    }

    if (elements.propModel.value !== propertyDefaults.MODEL) {
      properties[PROMPT_PROPERTIES.MODEL] = elements.propModel.value;
    }

    const agent = elements.propAgent.value.trim();
    if (agent && agent !== propertyDefaults.AGENT) {
      properties[PROMPT_PROPERTIES.AGENT] = agent;
    }

    if (elements.propNewChat.value !== propertyDefaults.NEW_CHAT) {
      properties[PROMPT_PROPERTIES.NEW_CHAT_SESSION] =
        elements.propNewChat.value === "yes";
    }

    if (elements.propAllowDynamic.value !== propertyDefaults.ALLOW_DYNAMIC) {
      properties[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION] =
        elements.propAllowDynamic.value === "yes";
    }

    // Build end condition from controls (extracted helper)
    const endCondition = buildEndConditionFromControls(
      elements,
      propertyDefaults
    );
    if (endCondition) {
      properties[PROMPT_PROPERTIES.END_CONDITION] = endCondition;
    }

    return properties;
  }

  /**
   * Reset property controls to default values
   */
  function resetPropertyControls() {
    const propertyDefaults = stateManager.getPropertyDefaults();
    elements.propProvider.value = propertyDefaults.PROVIDER;
    elements.propModel.value = propertyDefaults.MODEL;
    elements.propAgent.value = propertyDefaults.AGENT;
    elements.propNewChat.value = propertyDefaults.NEW_CHAT;
    elements.propAllowDynamic.value = propertyDefaults.ALLOW_DYNAMIC;
    setEndConditionControls(elements, propertyDefaults, undefined);
  }

  /**
   * Update the model dropdown in properties drawer based on selected provider
   * @param {string} provider - Provider ID (copilot-cli, copilot-chat, claude-cli, codex-cli)
   */
  function updatePropertyModelDropdown(provider) {
    const modelOptions = stateManager.getModelOptions();
    const propertyDefaults = stateManager.getPropertyDefaults();
    const options = modelOptions[provider] || [];

    // Always show "Default" option first
    let optionsHtml = `<option value="${propertyDefaults.MODEL}">Default</option>`;

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
    const propertyDefaults = stateManager.getPropertyDefaults();

    // Use shared property name constants for type safety
    const provider =
      prompt[PROMPT_PROPERTIES.PROVIDER] || propertyDefaults.PROVIDER;
    elements.propProvider.value = provider;

    // Update model dropdown based on provider BEFORE setting the model value
    if (provider !== propertyDefaults.PROVIDER) {
      updatePropertyModelDropdown(provider);
    }

    elements.propModel.value =
      prompt[PROMPT_PROPERTIES.MODEL] || propertyDefaults.MODEL;
    elements.propAgent.value =
      prompt[PROMPT_PROPERTIES.AGENT] || propertyDefaults.AGENT;

    const newChatSession = prompt[PROMPT_PROPERTIES.NEW_CHAT_SESSION];
    elements.propNewChat.value =
      newChatSession === undefined
        ? propertyDefaults.NEW_CHAT
        : newChatSession
          ? "yes"
          : "no";

    const allowDynamic = prompt[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION];
    elements.propAllowDynamic.value =
      allowDynamic === undefined
        ? propertyDefaults.ALLOW_DYNAMIC
        : allowDynamic
          ? "yes"
          : "no";

    // Use extracted helper for end condition controls
    const endCondition = prompt[PROMPT_PROPERTIES.END_CONDITION];
    setEndConditionControls(elements, propertyDefaults, endCondition);
  }

  // ============================================================================
  // EDITOR MODE AND UI UPDATES
  // ============================================================================

  /**
   * Update editor mode indicator and button visibility
   */
  function updateEditorMode() {
    const editorState = stateManager.getEditorState();
    const state = stateManager.getState();
    const isNewMode = editorState.selectedPromptIndex === null;

    if (isNewMode) {
      elements.editorModeIndicator.textContent = "New Prompt";
      elements.promptNameInput.style.display = ""; // Show name input in new mode
      elements.btnNewPrompt.style.display = "none"; // Hide New Prompt button

      // Show Run/Queue buttons (always enabled)
      elements.btnEditorRun.style.display = "";
      elements.btnEditorRun.disabled = false;

      elements.btnEditorQueue.style.display = "";
      elements.btnEditorQueue.disabled = false;

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

      // Hide Run/Queue buttons
      elements.btnEditorRun.style.display = "none";
      elements.btnEditorQueue.style.display = "none";

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
   * Check if there are pending prompts in the queue
   * @returns {boolean} True if there are prompts that haven't run yet
   */
  function hasPendingPrompts() {
    const state = stateManager.getState();

    // If no prompts or not running, no pending prompts
    if (state.prompts.length === 0) {
      return false;
    }

    // Check if any prompts after currentStep are pending
    for (let i = state.currentStep; i < state.prompts.length; i++) {
      if (state.prompts[i].status === STEP_STATUS.PENDING) {
        return true;
      }
    }

    return false;
  }

  /**
   * Update editor button text and behavior based on execution state
   * Called on state changes to show "Run" vs "Run Next" based on pending prompts
   */
  function updateEditorButtons() {
    const pendingPrompts = hasPendingPrompts();

    if (pendingPrompts) {
      // When there are pending prompts: Run button shows "Run Next" (insert next, run ASAP)
      elements.btnEditorRun.innerHTML =
        '<i class="codicon codicon-send"></i>\n                  Run Next';
      elements.btnEditorRun.title = "Insert next in queue and run immediately";

      // Queue button stays the same (append to end)
      elements.btnEditorQueue.innerHTML =
        '<i class="codicon codicon-add"></i>\n                  Queue';
      elements.btnEditorQueue.title = "Add prompt to end of queue";
    } else {
      // No pending prompts: Run button shows "Run" (create/append to end + run)
      elements.btnEditorRun.innerHTML =
        '<i class="codicon codicon-send"></i>\n                  Run';

      // Update tooltip based on state (handled by updateButtonTooltips)
      // Queue button stays the same
      elements.btnEditorQueue.innerHTML =
        '<i class="codicon codicon-add"></i>\n                  Queue';

      // Let updateButtonTooltips handle the detailed tooltip text
      updateButtonTooltips();
    }
  }

  /**
   * Update New Workflow checkbox visibility and enabled state
   * Called on state changes to show/hide/enable/disable checkbox
   */
  function updateNewWorkflowCheckbox() {
    const state = stateManager.getState();
    const editorState = stateManager.getEditorState();
    const hasWorkflow = state.prompts.length > 0;
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isNew = !editorState.hasActiveQueue || state.prompts.length === 0;

    if (!hasWorkflow) {
      // Hidden when no workflow
      elements.newWorkflowToggle.hidden = true;
    } else if (isRunning || isNew) {
      // Visible but disabled when running or workflow is new/empty
      elements.newWorkflowToggle.hidden = false;
      elements.newWorkflowCheckbox.disabled = true;
      elements.newWorkflowCheckbox.checked = false;

      // Set tooltip explaining why disabled
      if (isRunning) {
        elements.newWorkflowToggle.title =
          "Can't create new workflow while running";
      } else {
        elements.newWorkflowToggle.title = "No workflow loaded yet";
      }
    } else {
      // Enabled when workflow exists, has content, and not running
      elements.newWorkflowToggle.hidden = false;
      elements.newWorkflowCheckbox.disabled = false;
      elements.newWorkflowToggle.title =
        "Create new workflow instead of appending to current one";
    }
  }

  /**
   * Update button tooltips based on current workflow state
   */
  function updateButtonTooltips() {
    const editorState = stateManager.getEditorState();
    const state = stateManager.getState();
    const hasWorkflow = editorState.hasActiveQueue;
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isCompleted = state.executionState === EXECUTION_STATES.COMPLETED;
    const isIdle =
      state.executionState === EXECUTION_STATES.IDLE ||
      state.executionState === EXECUTION_STATES.READY;

    if (!hasWorkflow) {
      // No workflow: Run creates new and runs, Queue creates new without running
      elements.btnEditorRun.title = "Queue to new workflow and run";
      elements.btnEditorQueue.title = "Queue to new workflow";
    } else if (isIdle) {
      // Idle workflow: Run queues and starts from beginning, Queue just queues
      elements.btnEditorRun.title = "Queue and run workflow";
      elements.btnEditorQueue.title = "Add prompt to execution queue";
    } else if (isRunning) {
      // Running: Run queues and continues, Queue just queues
      elements.btnEditorRun.title = "Queue to current workflow";
      elements.btnEditorQueue.title = "Add prompt to execution queue";
    } else if (isCompleted) {
      // Completed: Run queues and resumes, Queue just queues
      elements.btnEditorRun.title = "Queue and resume workflow";
      elements.btnEditorQueue.title = "Add prompt to execution queue";
    }
  }

  /**
   * Update append button state (placeholder for compatibility)
   * This might be needed by message-router
   */
  function updateAppendButtonState() {
    // Placeholder - implementation depends on if there's a separate append button
    // or if this functionality is merged into other buttons
  }

  // ============================================================================
  // PROMPT CRUD OPERATIONS
  // ============================================================================

  /**
   * Execute a prompt (Run/Queue)
   * @param {string} action - ACTION_TYPES.RUN or ACTION_TYPES.QUEUE
   */
  function executePrompt(action) {
    const editorState = stateManager.getEditorState();
    const state = stateManager.getState();

    const text = editorState.promptEditor
      ? editorState.promptEditor.getText().trim()
      : "";

    if (!text) {
      return; // Don't execute empty prompts
    }

    const properties = getPropertyValues();
    const promptName = elements.promptNameInput.value.trim();

    // Determine final action based on state:
    // - STOPPED: Always RUN_BEFORE_CURRENT (current prompt was cancelled, hasn't run yet)
    // - IDLE (currentStep === 0): RUN_BEFORE_CURRENT (no prompts have run)
    // - PAUSED/RUNNING (with remaining): RUN_NEXT (insert after current)
    // - COMPLETED: RUN (append to end)
    // - No pending prompts: RUN (create new or append to end)
    let finalAction = action;

    if (action === ACTION_TYPES.RUN && hasPendingPrompts()) {
      const isIdle = state.executionState === EXECUTION_STATES.IDLE;
      const isStopped = state.executionState === EXECUTION_STATES.STOPPED;
      const isPaused = state.executionState === EXECUTION_STATES.PAUSED;
      const isRunning = state.executionState === EXECUTION_STATES.RUNNING;

      if (isStopped) {
        // STOPPED: Current prompt was cancelled (not completed), insert before it
        finalAction = ACTION_TYPES.RUN_BEFORE_CURRENT;
      } else if (isIdle && state.currentStep === 0) {
        // IDLE with no prompts executed: Insert at position 0
        finalAction = ACTION_TYPES.RUN_BEFORE_CURRENT;
      } else if (isPaused || isRunning) {
        // PAUSED/RUNNING: Insert after current (current is running/ran)
        finalAction = ACTION_TYPES.RUN_NEXT;
      } else {
        // Other states (shouldn't happen but fallback to RUN_NEXT)
        finalAction = ACTION_TYPES.RUN_NEXT;
      }
    }
    // Queue always appends to end (no change needed for QUEUE action)

    // Check if user wants to force new workflow
    const forceNewWorkflow =
      elements.newWorkflowCheckbox.checked &&
      !elements.newWorkflowCheckbox.disabled;

    vscode.postMessage({
      type: MESSAGE_TYPES.EXECUTE_PROMPT,
      text,
      properties,
      action: finalAction,
      promptName, // Include user-entered prompt name
      forceNewWorkflow, // Include new workflow flag
    });

    // Clear editor after all actions (Run/Queue/RunNext)
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
    const editorState = stateManager.getEditorState();

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
    const editorState = stateManager.getEditorState();
    const wasEditingExisting = editorState.selectedPromptIndex !== null;

    stateManager.updateEditorState({
      selectedPromptIndex: null,
      originalPromptData: null,
    });

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
          const propertyDefaults = stateManager.getPropertyDefaults();
          const provider =
            props[PROMPT_PROPERTIES.PROVIDER] || propertyDefaults.PROVIDER;
          elements.propProvider.value = provider;

          // Update model dropdown based on provider BEFORE setting the model value
          if (provider !== propertyDefaults.PROVIDER) {
            updatePropertyModelDropdown(provider);
          }

          elements.propModel.value =
            props[PROMPT_PROPERTIES.MODEL] || propertyDefaults.MODEL;
          elements.propAgent.value =
            props[PROMPT_PROPERTIES.AGENT] || propertyDefaults.AGENT;

          const newChatSession = props[PROMPT_PROPERTIES.NEW_CHAT_SESSION];
          elements.propNewChat.value =
            newChatSession === undefined
              ? propertyDefaults.NEW_CHAT
              : newChatSession
                ? "yes"
                : "no";

          const allowDynamic = props[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION];
          elements.propAllowDynamic.value =
            allowDynamic === undefined
              ? propertyDefaults.ALLOW_DYNAMIC
              : allowDynamic
                ? "yes"
                : "no";

          const endCondition = props[PROMPT_PROPERTIES.END_CONDITION];
          setEndConditionControls(elements, propertyDefaults, endCondition);
        }

        // Clear the saved state after restoring
        stateManager.updateEditorState({ savedNewPromptState: null });
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
    const editorState = stateManager.getEditorState();

    console.log(
      "[Dashboard] deletePrompt called, selectedPromptIndex:",
      editorState.selectedPromptIndex
    );

    if (editorState.selectedPromptIndex === null) {
      console.warn(
        "[Dashboard] Cannot delete - no prompt selected (selectedPromptIndex is null)"
      );
      return;
    }

    // Show custom confirmation modal
    showConfirmModal(
      "Delete Prompt",
      `Are you sure you want to delete prompt ${editorState.selectedPromptIndex + 1}?`,
      () => {
        // Confirmed - delete the prompt
        console.log(
          "[Dashboard] Delete confirmed, sending DELETE_PROMPT message for index:",
          editorState.selectedPromptIndex
        );
        vscode.postMessage({
          type: MESSAGE_TYPES.DELETE_PROMPT,
          index: editorState.selectedPromptIndex,
        });

        // Return to new prompt mode
        cancelEdit();
      }
    );
  }

  /**
   * Show custom confirmation modal
   * @param {string} title - Modal title
   * @param {string} message - Confirmation message
   * @param {Function} onConfirm - Callback when user clicks OK
   */
  function showConfirmModal(title, message, onConfirm) {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmModal.hidden = false;

    // Remove previous listeners to avoid duplicates
    const newOkBtn = elements.confirmOk.cloneNode(true);
    const newCancelBtn = elements.confirmCancel.cloneNode(true);
    elements.confirmOk.replaceWith(newOkBtn);
    elements.confirmCancel.replaceWith(newCancelBtn);
    elements.confirmOk = newOkBtn;
    elements.confirmCancel = newCancelBtn;

    // OK button handler
    elements.confirmOk.addEventListener("click", () => {
      elements.confirmModal.hidden = true;
      onConfirm();
    });

    // Cancel button handler
    elements.confirmCancel.addEventListener("click", () => {
      elements.confirmModal.hidden = true;
    });

    // Close on overlay click
    elements.confirmModal.querySelector(".modal-overlay").addEventListener(
      "click",
      () => {
        elements.confirmModal.hidden = true;
      },
      { once: true }
    );
  }

  /**
   * Select a prompt from the queue for editing
   * @param {number} index - Prompt index
   */
  function selectPromptForEdit(index) {
    const state = stateManager.getState();
    const editorState = stateManager.getEditorState();

    if (index < 0 || index >= state.prompts.length) return;

    const prompt = state.prompts[index];

    // ONLY save new prompt state if we're currently in new prompt mode
    // If we're already editing a prompt, don't overwrite the saved new prompt state
    if (editorState.selectedPromptIndex === null) {
      stateManager.updateEditorState({
        savedNewPromptState: {
          editorText: editorState.promptEditor
            ? editorState.promptEditor.getText()
            : "",
          promptName: elements.promptNameInput.value,
          properties: getPropertyValues(),
        },
      });
    }

    // Store original data for cancel functionality
    stateManager.updateEditorState({
      selectedPromptIndex: index,
      originalPromptData: { ...prompt },
    });

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

  /**
   * Handle completions response from extension
   * @param {Array} items - Completion items
   * @param {string} from - Completion source
   */
  function handleMessageCompletionsResponse(items, from) {
    const editorState = stateManager.getEditorState();

    console.log(
      `[Dashboard] Received COMPLETIONS_RESPONSE: ${items?.length} items, from=${from}`
    );
    if (
      editorState.promptEditor &&
      editorState.promptEditor.handleCompletionResponse
    ) {
      console.log("[Dashboard] Calling promptEditor.handleCompletionResponse");
      editorState.promptEditor.handleCompletionResponse(items, from);
    } else {
      console.log(
        "[Dashboard] Cannot handle completions - editor not ready or missing handler"
      );
    }
  }

  /**
   * Show error message (placeholder for compatibility)
   */
  function showErrorMessage(message) {
    console.error("[Dashboard]", message);
    // Could be enhanced with a UI notification in the future
  }

  // ============================================================================
  // SECTION COLLAPSE FUNCTIONALITY
  // ============================================================================

  /**
   * Toggle editor section collapse state
   */
  function toggleEditorSection() {
    const sectionElement = elements.editorSection;
    const btn = elements.btnCollapseEditor;
    const storageKey = "flightpath.section.editor.collapsed";

    // Toggle collapsed class
    const isCollapsed = sectionElement.classList.toggle("collapsed");

    // Save state to localStorage
    try {
      localStorage.setItem(storageKey, isCollapsed.toString());
    } catch (error) {
      console.warn("Failed to save editor collapse state:", error);
    }

    // Update button title
    btn.title = isCollapsed
      ? "Expand editor section"
      : "Collapse editor section";
    btn.setAttribute(
      "aria-label",
      isCollapsed ? "Expand editor" : "Collapse editor"
    );
  }

  /**
   * Restore editor section collapse state from localStorage
   */
  function restoreEditorCollapseState() {
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

  /**
   * Refresh the model dropdown for the currently selected provider
   * Called when MODEL_OPTIONS_UPDATE arrives from extension
   */
  function refreshModelDropdown() {
    const currentProvider = elements.propProvider.value;

    // Always update the dropdown to replace "Loading models..." with actual models
    // This is especially important for copilot-cli and copilot-chat which load async
    updatePropertyModelDropdown(currentProvider);
  }

  // Export public API to global scope
  window.FlightPathEditorManager = {
    init,
    selectPromptForEdit,
    handleMessageCompletionsResponse,
    hasPendingPrompts,
    updateEditorButtons,
    updateNewWorkflowCheckbox,
    updateButtonTooltips,
    updateAppendButtonState,
    updateEditorMode,
    togglePropertiesDrawer,
    toggleEditorSection,
    restoreEditorCollapseState,
    refreshModelDropdown,
    cancelEdit,
  };
})();
