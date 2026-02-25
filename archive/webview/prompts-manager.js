/**
 * FlightPath Dashboard Prompts Manager Module
 *
 * Manages prompts list rendering, selection, and state tracking.
 *
 * Exports:
 * - init: Initialize with dependencies
 * - renderPromptsList: Render all prompts with status icons
 * - updatePromptCounter: Update prompt counter text
 * - handleMessageFileSelected: Handle new file selected
 * - handleMessageSessionRestored: Handle session restored
 * - handleMessagePromptsExtended: Handle queue extension
 * - handleMessagePromptDeleted: Handle prompt deletion
 * - togglePromptsSection: Toggle prompts section collapse
 * - restorePromptsCollapseState: Restore collapse state from localStorage
 */
(function () {
  // Import constants and utilities from global scope
  const { MESSAGE_TYPES, EXECUTION_STATES, STEP_STATUS, PROMPT_PROPERTIES } =
    window.FlightPathConstants;
  const { truncate, createPromptItem, getStatusIcon } =
    window.FlightPathUtilities;

  // Dependencies (injected via init)
  let vscode = null;
  let elements = null;
  let stateManager = null;
  let editorManager = null; // Need reference to trigger edit mode

  /**
   * Initialize prompts manager with dependencies
   * @param {Object} _vscode - VS Code API instance
   * @param {Object} _elements - DOM elements object
   * @param {Object} _stateManager - State manager instance
   * @param {Object} _editorManager - Editor manager instance (for selectPromptForEdit)
   */
  function init(_vscode, _elements, _stateManager, _editorManager) {
    vscode = _vscode;
    elements = _elements;
    stateManager = _stateManager;
    editorManager = _editorManager;

    setupEventListeners();
  }

  /**
   * Set up event listeners for prompts section
   */
  function setupEventListeners() {
    // Section collapse button
    elements.btnCollapsePrompts.addEventListener("click", () => {
      togglePromptsSection();
    });

    // Make prompts in the list clickable for editing
    elements.promptsList.addEventListener("click", (e) => {
      const promptItem = e.target.closest(".prompt-item");
      if (promptItem && promptItem.dataset.promptIndex !== undefined) {
        const index = parseInt(promptItem.dataset.promptIndex, 10);
        if (editorManager && editorManager.selectPromptForEdit) {
          editorManager.selectPromptForEdit(index);
        }
      }
    });
  }

  /**
   * Render the prompts list with status icons and details
   */
  function renderPromptsList() {
    const state = stateManager.getState();

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

  /**
   * Update the prompt counter text
   */
  function updatePromptCounter() {
    const state = stateManager.getState();

    if (state.totalSteps > 0) {
      elements.promptCounter.textContent = `Completed ${state.currentStep} of ${state.totalSteps}`;
    } else {
      elements.promptCounter.textContent = "";
    }
  }

  /**
   * Handle FILE_SELECTED message - new file selected (IDLE state only)
   * @param {string} fileName - File name
   * @param {Array} prompts - Array of prompts
   * @param {string} workflowName - Custom workflow name (optional)
   */
  function handleMessageFileSelected(fileName, prompts, workflowName) {
    console.log(`Dashboard: New file selected (${fileName}), resetting state`);

    const state = stateManager.getState();
    stateManager.updateState({
      fileName,
      workflowName: workflowName || null,
      prompts: prompts.map((p, i) => createPromptItem(p, i)),
      executionState: EXECUTION_STATES.IDLE,
      currentStep: 0,
      totalSteps: prompts.length,
      cliOutputs: {},
      retryStates: {},
      statusMessages: {},
    });

    // Update editor state
    stateManager.updateEditorState({
      hasActiveQueue: prompts.length > 0,
    });

    // Reset editor to new prompt mode (workflow context changed)
    if (editorManager && editorManager.cancelEdit) {
      editorManager.cancelEdit();
    }

    // Reset prompt counter
    elements.promptCounter.textContent = "";

    // Render prompts
    renderPromptsList();
  }

  /**
   * Handle SESSION_RESTORED message - restore previous session with runtime state
   * @param {string} fileName - File name
   * @param {Array} prompts - Array of prompts
   * @param {Array} results - Array of results with status
   * @param {string} executionState - Execution state
   * @param {number} currentIndex - Current step index
   * @param {string} workflowName - Custom workflow name (optional)
   */
  function handleMessageSessionRestored(
    fileName,
    prompts,
    results,
    executionState,
    currentIndex,
    workflowName
  ) {
    console.log(
      `Dashboard: Session restored (${fileName}), ${prompts.length} prompts, state: ${executionState}, currentIndex: ${currentIndex}`
    );

    // Map prompts with their runtime status from results
    const mappedPrompts = prompts.map((p, i) =>
      createPromptItem(p, i, results[i]?.status || STEP_STATUS.PENDING, {})
    );

    stateManager.updateState({
      fileName,
      workflowName: workflowName || null,
      executionState,
      currentStep: currentIndex,
      totalSteps: prompts.length,
      prompts: mappedPrompts,
      cliOutputs: {},
      retryStates: {},
      statusMessages: {},
    });

    // Update editor state - we have an active queue from restored session
    stateManager.updateEditorState({
      hasActiveQueue: prompts.length > 0,
    });

    // Reset editor to new prompt mode (workflow context changed)
    if (editorManager && editorManager.cancelEdit) {
      editorManager.cancelEdit();
    }

    // Update prompt counter
    updatePromptCounter();

    // Render prompts
    renderPromptsList();
  }

  /**
   * Handle PROMPTS_EXTENDED message - queue was extended during execution
   * @param {Array} prompts - New prompts array from disk
   */
  function handleMessagePromptsExtended(prompts) {
    const state = stateManager.getState();
    const oldLength = state.prompts.length;
    const newLength = prompts.length;

    console.log(
      `Dashboard: Prompts extended from ${oldLength} to ${newLength} prompts`
    );

    // Build map of existing prompts by index to preserve ALL state
    const existingPromptsMap = new Map();
    state.prompts.forEach((p, idx) => {
      existingPromptsMap.set(idx, p);
    });

    // Replace entire array, preserving existing prompts and creating new ones for appended items
    const newPrompts = prompts.map((p, i) => {
      const existing = existingPromptsMap.get(i);

      if (existing && i < oldLength) {
        // Existing prompt - preserve runtime state (status, details, outputs, etc.)
        // but merge in ALL updated properties from backend (text, provider, model, etc.)
        // MCP only adds new prompts (never updates existing ones), so we don't need to
        // worry about undefined properties accidentally clearing overrides.
        const text = typeof p === "string" ? p : p[PROMPT_PROPERTIES.PROMPT];

        // Extract all properties from incoming prompt (including undefined to clear overrides)
        const updatedProps =
          typeof p === "string"
            ? {}
            : {
                [PROMPT_PROPERTIES.PROVIDER]: p[PROMPT_PROPERTIES.PROVIDER],
                [PROMPT_PROPERTIES.MODEL]: p[PROMPT_PROPERTIES.MODEL],
                [PROMPT_PROPERTIES.AGENT]: p[PROMPT_PROPERTIES.AGENT],
                [PROMPT_PROPERTIES.RESUME_SESSION]:
                  p[PROMPT_PROPERTIES.RESUME_SESSION],
                [PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION]:
                  p[PROMPT_PROPERTIES.ALLOW_DYNAMIC_EXTENSION],
                [PROMPT_PROPERTIES.END_CONDITION]:
                  p[PROMPT_PROPERTIES.END_CONDITION],
              };

        return {
          ...existing,
          text, // Update text to reflect any edits
          ...updatedProps, // Merge in all updated properties
        };
      } else {
        // New prompt (appended) - create fresh item
        return createPromptItem(p, i, STEP_STATUS.PENDING, {});
      }
    });

    stateManager.updateState({
      prompts: newPrompts,
      totalSteps: newPrompts.length,
    });

    // Update editor state - queue was extended so we definitely have an active queue
    stateManager.updateEditorState({
      hasActiveQueue: newPrompts.length > 0,
    });

    // Re-render the prompts list to show all prompts in correct order
    renderPromptsList();
    updatePromptCounter();

    console.log(
      `Dashboard: Preserved ${oldLength} existing prompts, added ${newLength - oldLength} new prompts`
    );
  }

  /**
   * Handle PROMPT_DELETED message - a prompt was removed from the queue
   * @param {string} fileName - File name
   * @param {Array} prompts - Remaining prompts
   */
  function handleMessagePromptDeleted(fileName, prompts) {
    const state = stateManager.getState();

    console.log(
      `[Dashboard] handlePromptDeleted: Received PROMPT_DELETED message, ${prompts.length} prompts remaining`,
      { fileName, promptsCount: prompts.length }
    );

    // Update prompts list, preserving statuses for remaining prompts
    const existingStatusMap = new Map();
    state.prompts.forEach((p) => {
      const key = p.text.trim();
      existingStatusMap.set(key, {
        status: p.status,
        details: p.details,
      });
    });

    const newPrompts = prompts.map((p, i) => {
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

    stateManager.updateState({
      prompts: newPrompts,
      totalSteps: newPrompts.length,
    });

    // Update editor state
    stateManager.updateEditorState({
      hasActiveQueue: newPrompts.length > 0,
    });

    // Update UI
    renderPromptsList();
    updatePromptCounter();

    // Note: We intentionally DON'T reset execution state, cliOutputs, or retryStates
    // because the workflow might still be running. Those are preserved.
  }

  /**
   * Toggle prompts section collapse state
   */
  function togglePromptsSection() {
    const sectionElement = elements.promptsSection;
    const btn = elements.btnCollapsePrompts;
    const storageKey = "flightpath.section.prompts.collapsed";

    // Toggle collapsed class
    const isCollapsed = sectionElement.classList.toggle("collapsed");

    // Save state to localStorage
    try {
      localStorage.setItem(storageKey, isCollapsed.toString());
    } catch (error) {
      console.warn("Failed to save prompts collapse state:", error);
    }

    // Update button title
    btn.title = isCollapsed
      ? "Expand prompts section"
      : "Collapse prompts section";
    btn.setAttribute(
      "aria-label",
      isCollapsed ? "Expand prompts" : "Collapse prompts"
    );
  }

  /**
   * Restore prompts section collapse state from localStorage
   */
  function restorePromptsCollapseState() {
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
  }

  // Export public API to global scope
  window.FlightPathPromptsManager = {
    init,
    renderPromptsList,
    updatePromptCounter,
    handleMessageFileSelected,
    handleMessageSessionRestored,
    handleMessagePromptsExtended,
    handleMessagePromptDeleted,
    togglePromptsSection,
    restorePromptsCollapseState,
  };
})();
