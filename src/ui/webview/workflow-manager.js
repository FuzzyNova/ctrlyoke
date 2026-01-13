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

  // Workflow status state
  let workflowStatusState = {
    isEditing: false,
    originalName: "",
    recentWorkflows: [], // { filePath, workflowName, executionState, startedAt }
    currentFilePath: null,
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
      e.stopPropagation(); // Prevent clicks inside menu from closing it

      const item = e.target.closest(".dropdown-item");
      if (!item || item.disabled) return;

      const action = item.dataset.action;
      handleDropdownAction(action);
      closeWorkflowDropdown();
    });

    // === Workflow Status Split Button Events ===

    // Main button click (Edit Workflow Name)
    if (elements.btnWorkflowMain) {
      elements.btnWorkflowMain.addEventListener("click", () => {
        startEditingWorkflowName();
      });
    }

    // Workflow status dropdown trigger click
    if (elements.btnWorkflowStatusDropdown) {
      elements.btnWorkflowStatusDropdown.addEventListener(
        "click",
        async (e) => {
          e.stopPropagation();

          // Prevent opening if disabled (workflow is running)
          if (elements.btnWorkflowStatusDropdown.disabled) {
            return;
          }

          await toggleRecentWorkflowsDropdown();
        }
      );
    }

    // Inline edit input events
    if (elements.workflowNameEdit) {
      elements.workflowNameEdit.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          saveWorkflowName();
        } else if (e.key === "Escape") {
          cancelEditingWorkflowName();
        }
      });

      elements.workflowNameEdit.addEventListener("blur", () => {
        if (workflowStatusState.isEditing) {
          saveWorkflowName();
        }
      });
    }

    // Workflow dropdown menu item clicks
    if (elements.workflowRecentMenu) {
      elements.workflowRecentMenu.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent clicks inside menu from closing it

        // Check for clear history action
        const actionBtn = e.target.closest(".workflow-menu-action");
        if (actionBtn && actionBtn.dataset.action === "clear-history") {
          handleClearWorkflowHistory();
          return;
        }

        // Check for workflow item click
        const item = e.target.closest(".workflow-menu-item");
        if (!item) return;

        const filePath = item.dataset.filePath;
        if (filePath) {
          loadWorkflowFromHistory(filePath);
          closeRecentWorkflowsDropdown();
        }
      });
    }

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

    // Window resize handler - reposition dropdown if open
    window.addEventListener("resize", () => {
      if (
        elements.workflowRecentMenu &&
        !elements.workflowRecentMenu.hidden
      ) {
        positionDropdown();
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

    // Close dropdown when clicking outside (use setTimeout to avoid immediate closure)
    setTimeout(() => {
      document.addEventListener("click", handleDropdownClickOutside);
    }, 0);
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
   * @param {string} workflowName - Custom workflow name (optional)
   */
  function updateWorkflowStatus(filePath, executionState, workflowName) {
    workflowStatusState.currentFilePath = filePath;

    if (!filePath) {
      // No workflow loaded
      if (elements.workflowSplitButton) {
        elements.workflowSplitButton.style.display = "none";
      }
      if (elements.workflowEmptyState) {
        elements.workflowEmptyState.style.display = "inline";
      }
      if (elements.statusSeparator) {
        elements.statusSeparator.style.display = "none";
      }
      if (elements.btnWorkflowStatusDropdown) {
        elements.btnWorkflowStatusDropdown.disabled = true;
      }
      return;
    }

    // Workflow loaded
    if (elements.workflowEmptyState) {
      elements.workflowEmptyState.style.display = "none";
    }
    if (elements.workflowSplitButton) {
      elements.workflowSplitButton.style.display = "inline-flex";
    }

    // Update workflow name
    const displayName = workflowName || getWorkflowName(filePath);
    if (elements.workflowName) {
      elements.workflowName.textContent = displayName;
    }

    // Update execution state
    if (executionState && executionState !== EXECUTION_STATES.IDLE) {
      if (elements.statusSeparator) {
        elements.statusSeparator.style.display = "inline";
      }
      if (elements.executionState) {
        elements.executionState.style.display = "inline";
        elements.executionState.textContent = executionState;
        elements.executionState.className = `execution-state-${executionState.toLowerCase()}`;
      }
    } else {
      if (elements.statusSeparator) {
        elements.statusSeparator.style.display = "none";
      }
      if (elements.executionState) {
        elements.executionState.style.display = "none";
      }
    }

    // Disable dropdown trigger when workflow is RUNNING
    // (matches "New Workflow" button behavior - prevent interrupting active workflow)
    const isRunning = executionState === EXECUTION_STATES.RUNNING;
    if (elements.btnWorkflowStatusDropdown) {
      elements.btnWorkflowStatusDropdown.disabled = isRunning;

      if (isRunning) {
        elements.btnWorkflowStatusDropdown.title =
          "Cannot switch workflows while running";
      } else {
        elements.btnWorkflowStatusDropdown.title = "Show recent workflows";
      }
    }
  }

  // ============================================================================
  // WORKFLOW STATUS SPLIT BUTTON FUNCTIONS
  // ============================================================================

  /**
   * Start editing workflow name
   */
  function startEditingWorkflowName() {
    const state = stateManager.getState();
    if (!state.fileName) return;

    workflowStatusState.isEditing = true;
    workflowStatusState.originalName = elements.workflowName.textContent;

    // Hide split button, show input
    if (elements.workflowSplitButton) {
      elements.workflowSplitButton.style.display = "none";
    }
    if (elements.workflowNameEdit) {
      elements.workflowNameEdit.style.display = "inline-block";
      elements.workflowNameEdit.value = workflowStatusState.originalName;
      elements.workflowNameEdit.focus();
      elements.workflowNameEdit.select();
    }
  }

  /**
   * Cancel editing workflow name
   */
  function cancelEditingWorkflowName() {
    workflowStatusState.isEditing = false;

    // Hide input, show split button
    if (elements.workflowNameEdit) {
      elements.workflowNameEdit.style.display = "none";
    }
    if (elements.workflowSplitButton) {
      elements.workflowSplitButton.style.display = "inline-flex";
    }
  }

  /**
   * Save workflow name
   */
  function saveWorkflowName() {
    if (!elements.workflowNameEdit) return;

    const newName = elements.workflowNameEdit.value.trim();

    // Validate
    if (!newName) {
      cancelEditingWorkflowName();
      return;
    }

    // Check if changed
    if (newName === workflowStatusState.originalName) {
      cancelEditingWorkflowName();
      return;
    }

    // Send to backend
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_WORKFLOW_NAME,
      workflowName: newName,
    });

    // Update UI optimistically
    if (elements.workflowName) {
      elements.workflowName.textContent = newName;
    }
    cancelEditingWorkflowName();
  }

  /**
   * Toggle recent workflows dropdown
   */
  async function toggleRecentWorkflowsDropdown() {
    if (!elements.workflowRecentMenu) return;

    const isOpen = !elements.workflowRecentMenu.hidden;

    if (isOpen) {
      closeRecentWorkflowsDropdown();
    } else {
      await openRecentWorkflowsDropdown();
    }
  }

  /**
   * Open recent workflows dropdown
   */
  async function openRecentWorkflowsDropdown() {
    if (!elements.workflowRecentMenu || !elements.btnWorkflowStatusDropdown)
      return;

    // Request recent workflows from backend
    vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_WORKFLOWS });

    // Show dropdown (will be populated when backend responds)
    elements.workflowRecentMenu.hidden = false;
    elements.btnWorkflowStatusDropdown.setAttribute("aria-expanded", "true");

    // Position dropdown relative to button
    positionDropdown();

    // Add click-outside listener
    setTimeout(() => {
      document.addEventListener("click", handleRecentWorkflowsClickOutside);
    }, 0);
  }

  /**
   * Position the dropdown menu to stay within viewport bounds
   */
  function positionDropdown() {
    if (!elements.workflowRecentMenu || !elements.workflowSplitButton) return;

    const dropdown = elements.workflowRecentMenu;
    const button = elements.workflowSplitButton;

    // Get button position relative to viewport
    const buttonRect = button.getBoundingClientRect();

    // Calculate available space
    const spaceBelow = window.innerHeight - buttonRect.bottom;
    const spaceAbove = buttonRect.top;
    const viewportWidth = window.innerWidth;

    // Determine if dropdown should appear above or below button
    const dropdownHeight = Math.min(400, window.innerHeight * 0.7);
    const showAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;

    // Position vertically
    if (showAbove) {
      // Position above button
      dropdown.style.top = "auto";
      dropdown.style.bottom = `${window.innerHeight - buttonRect.top + 4}px`;
      dropdown.style.maxHeight = `${Math.min(400, spaceAbove - 8)}px`;
    } else {
      // Position below button (default)
      dropdown.style.top = `${buttonRect.bottom + 4}px`;
      dropdown.style.bottom = "auto";
      dropdown.style.maxHeight = `${Math.min(400, spaceBelow - 8)}px`;
    }

    // Position horizontally - center on button
    const buttonCenter = buttonRect.left + buttonRect.width / 2;
    const dropdownWidth = Math.min(500, viewportWidth * 0.9);

    // Calculate left position to center dropdown
    let leftPosition = buttonCenter;

    // Adjust if dropdown would go off screen
    const halfWidth = dropdownWidth / 2;
    if (leftPosition - halfWidth < 8) {
      // Too far left
      leftPosition = halfWidth + 8;
    } else if (leftPosition + halfWidth > viewportWidth - 8) {
      // Too far right
      leftPosition = viewportWidth - halfWidth - 8;
    }

    dropdown.style.left = `${leftPosition}px`;
    dropdown.style.width = `${dropdownWidth}px`;
  }

  /**
   * Close recent workflows dropdown
   */
  function closeRecentWorkflowsDropdown() {
    if (!elements.workflowRecentMenu || !elements.btnWorkflowStatusDropdown)
      return;

    elements.workflowRecentMenu.hidden = true;
    elements.btnWorkflowStatusDropdown.setAttribute("aria-expanded", "false");

    // Remove click-outside listener
    document.removeEventListener("click", handleRecentWorkflowsClickOutside);
  }

  /**
   * Handle clicks outside the recent workflows dropdown
   */
  function handleRecentWorkflowsClickOutside(e) {
    if (!elements.workflowRecentMenu || !elements.btnWorkflowStatusDropdown)
      return;

    const dropdown = elements.workflowRecentMenu;
    const trigger = elements.btnWorkflowStatusDropdown;

    // Close if click is outside dropdown and trigger button
    if (!dropdown.contains(e.target) && !trigger.contains(e.target)) {
      closeRecentWorkflowsDropdown();
    }
  }

  /**
   * Populate recent workflows dropdown
   * @param {Array} workflows - Array of workflow metadata
   */
  function populateRecentWorkflows(workflows) {
    if (!elements.workflowMenuItems) return;

    workflowStatusState.recentWorkflows = workflows;

    // Clear existing items
    elements.workflowMenuItems.innerHTML = "";

    if (workflows.length === 0) {
      elements.workflowMenuItems.innerHTML = `
        <div class="workflow-menu-empty">
          No recent workflows
        </div>
      `;
      return;
    }

    // Helper to escape HTML
    const escapeHtml = (str) => {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    };

    // Add workflow items (sorted by most recent)
    workflows.forEach((workflow) => {
      const isCurrent =
        workflow.filePath === workflowStatusState.currentFilePath;
      const stateClass = `state-${workflow.executionState.toLowerCase()}`;

      const item = document.createElement("button");
      item.className = `workflow-menu-item ${isCurrent ? "current" : ""}`;
      item.dataset.filePath = workflow.filePath;
      item.title = workflow.filePath;
      item.innerHTML = `
        <span class="workflow-menu-item-name">${escapeHtml(
          workflow.workflowName
        )}</span>
        <span class="workflow-menu-item-state ${stateClass}">
          ${workflow.executionState}
        </span>
      `;

      elements.workflowMenuItems.appendChild(item);
    });
  }

  /**
   * Load workflow from history
   * @param {string} filePath - Path to working file
   */
  function loadWorkflowFromHistory(filePath) {
    vscode.postMessage({
      type: MESSAGE_TYPES.LOAD_WORKFLOW,
      filePath: filePath,
    });
  }

  /**
   * Clear workflow history
   */
  async function handleClearWorkflowHistory() {
    vscode.postMessage({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY,
    });
  }

  /**
   * Handle workflow name updated message
   * @param {string} workflowName - Updated workflow name
   */
  function handleWorkflowNameUpdated(workflowName) {
    if (elements.workflowName) {
      elements.workflowName.textContent = workflowName;
    }
  }

  /**
   * Handle recent workflows message
   * @param {Array} workflows - Array of workflow metadata
   */
  function handleRecentWorkflows(workflows) {
    populateRecentWorkflows(workflows);
  }

  // ============================================================================
  // WORKFLOW STATUS DISPLAY (LEGACY - for backward compatibility)
  // ============================================================================

  /**
   * Update workflow name and state display (legacy function)
   * @param {string} filePath - Workflow file path
   * @param {string} executionState - Current execution state
   * @deprecated Use updateWorkflowStatus with workflowName parameter instead
   */
  function updateWorkflowStatusLegacy(filePath, executionState) {
    updateWorkflowStatus(filePath, executionState, null);
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
    handleWorkflowNameUpdated,
    handleRecentWorkflows,
  };
})();
