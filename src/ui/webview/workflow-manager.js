/**
 * FlightPath Dashboard Workflow Manager Module
 *
 * Manages workflow actions (new, load, queue), split button UI, and modal workflow creation.
 *
 * Exports:
 * - init: Initialize with dependencies
 * - handleMessageOpenNewWorkflowModal: Open workflow creation modal
 * - handleMessageTemplateInfo: Update template info in modal
 * - handleMessageDefaultTemplateSet: Confirm default template set
 * - handleMessageWorkflowCreated: Handle workflow creation response
 * - handleMessageCloseModal: Close modal
 * - updateWorkflowStatus: Update workflow name and state display
 * - updateNewWorkflowButtonState: Update split button state
 */
(function () {
  // Import constants and utilities from global scope
  const { MESSAGE_TYPES, EXECUTION_STATES } = window.FlightPathConstants;
  const { getWorkflowName } = window.FlightPathUtilities;

  // Dependencies (injected via init)
  let vscode = null;
  let elements = null;
  let stateManager = null;

  // Modal state
  let modalState = {
    templates: [],
    currentTemplate: null,
    workflowsDir: ".flightpath/workflows",
    defaultTemplateId: "blank",
  };

  /**
   * Initialize workflow manager with dependencies
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
   * Set up event listeners for workflow actions
   */
  function setupEventListeners() {
    // Main button click (New Workflow action)
    elements.btnNewWorkflowMain.addEventListener("click", () => {
      handleNewWorkflowAction();
    });

    // Dropdown trigger click
    elements.btnWorkflowDropdown.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent click-outside handler from firing immediately
      toggleWorkflowDropdown();
    });

    // Dropdown menu item clicks
    elements.workflowDropdownMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".dropdown-item");
      if (!item || item.disabled) return;

      const action = item.dataset.action;
      handleDropdownAction(action);
      closeWorkflowDropdown();
    });

    // Keyboard navigation for dropdown
    elements.workflowDropdownMenu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeWorkflowDropdown();
        elements.btnWorkflowDropdown.focus();
      }

      // Arrow key navigation between items
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        navigateDropdownItems(e.key === "ArrowDown" ? 1 : -1);
      }

      // Enter or Space to activate item
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const focusedItem = document.activeElement;
        if (
          focusedItem.classList.contains("dropdown-item") &&
          !focusedItem.disabled
        ) {
          focusedItem.click();
        }
      }
    });

    // Keyboard shortcuts for workflow actions
    document.addEventListener("keydown", (e) => {
      // Only trigger if Ctrl+Shift is pressed (or Cmd+Shift on Mac)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        // Ctrl+Shift+N: New Workflow
        if (e.key === "N") {
          e.preventDefault();
          handleNewWorkflowAction();
        }

        // Ctrl+Shift+T: From Template
        if (e.key === "T") {
          e.preventDefault();
          vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
        }

        // Ctrl+Shift+L: Load from File
        if (e.key === "L") {
          e.preventDefault();
          handleLoadFileAction();
        }

        // Ctrl+Shift+Q: Queue from File
        if (e.key === "Q") {
          e.preventDefault();
          const state = stateManager.getState();
          if (state.fileName !== null) {
            vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
          }
        }
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
        vscode.postMessage({
          type: MESSAGE_TYPES.TEMPLATE_SELECTED,
          templateId,
        });
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
  }

  // ============================================================================
  // SPLIT BUTTON FUNCTIONS
  // ============================================================================

  /**
   * Toggle the workflow dropdown menu
   */
  function toggleWorkflowDropdown() {
    const isOpen = !elements.workflowDropdownMenu.hidden;

    if (isOpen) {
      closeWorkflowDropdown();
    } else {
      openWorkflowDropdown();
    }
  }

  /**
   * Open the workflow dropdown menu
   */
  function openWorkflowDropdown() {
    elements.workflowDropdownMenu.hidden = false;
    elements.btnWorkflowDropdown.setAttribute("aria-expanded", "true");

    // Update dropdown item states based on current workflow state
    updateWorkflowDropdownItems();

    // Focus first enabled item
    const firstItem = elements.workflowDropdownMenu.querySelector(
      ".dropdown-item:not(:disabled)"
    );
    firstItem?.focus();

    // Close dropdown when clicking outside
    document.addEventListener("click", handleDropdownClickOutside);
  }

  /**
   * Close the workflow dropdown menu
   */
  function closeWorkflowDropdown() {
    elements.workflowDropdownMenu.hidden = true;
    elements.btnWorkflowDropdown.setAttribute("aria-expanded", "false");

    // Remove click-outside listener
    document.removeEventListener("click", handleDropdownClickOutside);
  }

  /**
   * Handle clicks outside the dropdown to close it
   */
  function handleDropdownClickOutside(e) {
    const dropdown = elements.workflowDropdownMenu;
    const trigger = elements.btnWorkflowDropdown;

    // Close if click is outside dropdown and trigger button
    if (!dropdown.contains(e.target) && !trigger.contains(e.target)) {
      closeWorkflowDropdown();
    }
  }

  /**
   * Update dropdown menu item states based on current workflow state
   */
  function updateWorkflowDropdownItems() {
    const state = stateManager.getState();
    const hasQueue = state.fileName !== null;
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isPaused = state.executionState === EXECUTION_STATES.PAUSED;
    const isExecuting = isRunning || isPaused;

    // Get dropdown items by data-action attribute
    const items = {
      newWorkflow: elements.workflowDropdownMenu.querySelector(
        '[data-action="new-workflow"]'
      ),
      fromTemplate: elements.workflowDropdownMenu.querySelector(
        '[data-action="from-template"]'
      ),
      loadFile: elements.workflowDropdownMenu.querySelector(
        '[data-action="load-file"]'
      ),
      queueFile: elements.workflowDropdownMenu.querySelector(
        '[data-action="queue-file"]'
      ),
    };

    // Disable destructive actions during execution
    items.newWorkflow.disabled = isExecuting;
    items.fromTemplate.disabled = isExecuting;
    items.loadFile.disabled = isExecuting;

    // Queue file only enabled when queue exists and not during execution
    items.queueFile.disabled = !hasQueue || isExecuting;
  }

  /**
   * Update main button state based on workflow state
   */
  function updateNewWorkflowButtonState() {
    const state = stateManager.getState();
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isPaused = state.executionState === EXECUTION_STATES.PAUSED;
    const isExecuting = isRunning || isPaused;

    // Disable main button during execution
    elements.btnNewWorkflowMain.disabled = isExecuting;

    if (isExecuting) {
      elements.btnNewWorkflowMain.title =
        "Cannot clear workflow while running (stop first)";
    } else {
      elements.btnNewWorkflowMain.title =
        "Clear current workflow and start blank";
    }

    // Dropdown trigger always enabled (can still queue during execution)
    elements.btnWorkflowDropdown.disabled = false;
  }

  /**
   * Navigate dropdown items with keyboard
   */
  function navigateDropdownItems(direction) {
    const items = Array.from(
      elements.workflowDropdownMenu.querySelectorAll(
        ".dropdown-item:not(:disabled)"
      )
    );
    const currentIndex = items.indexOf(document.activeElement);

    let nextIndex = currentIndex + direction;

    // Wrap around
    if (nextIndex < 0) nextIndex = items.length - 1;
    if (nextIndex >= items.length) nextIndex = 0;

    items[nextIndex]?.focus();
  }

  /**
   * Handle "New Workflow" main button click (zero friction - no confirmation)
   */
  function handleNewWorkflowAction() {
    // Clear workflow directly without confirmation
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  }

  /**
   * Handle dropdown menu item clicks
   */
  function handleDropdownAction(action) {
    switch (action) {
      case "new-workflow":
        handleNewWorkflowAction();
        break;

      case "from-template":
        vscode.postMessage({ type: MESSAGE_TYPES.NEW_WORKFLOW });
        break;

      case "load-file":
        handleLoadFileAction();
        break;

      case "queue-file":
        vscode.postMessage({ type: MESSAGE_TYPES.APPEND_FILE });
        break;

      default:
        console.warn("Unknown dropdown action:", action);
    }
  }

  /**
   * Handle "Load from File..." action (zero friction - no confirmation)
   */
  function handleLoadFileAction() {
    const state = stateManager.getState();
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const isPaused = state.executionState === EXECUTION_STATES.PAUSED;

    if (isRunning || isPaused) {
      // This shouldn't happen (button should be disabled), but extra safety
      console.warn("Cannot load file while workflow is running");
      return;
    }

    // Load file directly without confirmation
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  }

  // ============================================================================
  // WORKFLOW STATUS DISPLAY
  // ============================================================================

  /**
   * Update workflow name and state display
   * @param {string} filePath - Workflow file path
   * @param {string} executionState - Current execution state
   */
  function updateWorkflowStatus(filePath, executionState) {
    if (!filePath || filePath === "New Workflow") {
      // Empty workflow - hide state separator and execution state
      elements.workflowName.textContent = "New Workflow";
      elements.statusSeparator.style.display = "none";
      elements.executionState.style.display = "none";
    } else {
      // Workflow loaded - show name, separator, and state
      elements.workflowName.textContent = getWorkflowName(filePath);
      elements.statusSeparator.style.display = "inline";
      elements.executionState.style.display = "inline";
    }
  }

  // ============================================================================
  // MODAL FUNCTIONS
  // ============================================================================

  /**
   * Handle opening the new workflow modal
   */
  function handleMessageOpenNewWorkflowModal(message) {
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
  function handleMessageTemplateInfo(message) {
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
  function handleMessageDefaultTemplateSet(message) {
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
  function handleMessageWorkflowCreated(message) {
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
   * Handle close modal message from extension
   */
  function handleMessageCloseModal() {
    closeModal();
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

  // Export public API to global scope
  window.FlightPathWorkflowManager = {
    init,
    handleMessageOpenNewWorkflowModal,
    handleMessageTemplateInfo,
    handleMessageDefaultTemplateSet,
    handleMessageWorkflowCreated,
    handleMessageCloseModal,
    updateWorkflowStatus,
    updateNewWorkflowButtonState,
  };
})();
