/**
 * FlightPath Dashboard - Main Orchestrator
 *
 * Coordinates all dashboard modules and handles global UI concerns.
 * Modules are loaded via script tags in dashboard.html in dependency order:
 * 1. utilities.js - Pure helper functions
 * 2. state-manager.js - Centralized state management
 * 3. output-manager.js, workflow-manager.js, editor-manager.js, prompts-manager.js - Feature managers
 * 4. message-router.js - Message routing and orchestration
 * 5. dashboard.js (this file) - Initialization and global event handlers
 */
(function () {
  // Acquire VS Code API (call once, cache result)
  const vscode = acquireVsCodeApi();

  // Import constants from compiled DashboardConstants.js (loaded via script tag)
  const { MESSAGE_TYPES } = window.FlightPathConstants;

  // Import all manager modules from global scope
  const stateManager = window.FlightPathStateManager;
  const utilities = window.FlightPathUtilities;
  const workflowManager = window.FlightPathWorkflowManager;
  const promptsManager = window.FlightPathPromptsManager;
  const outputManager = window.FlightPathOutputManager;
  const editorManager = window.FlightPathEditorManager;
  const messageRouter = window.FlightPathMessageRouter;

  // ============================================================================
  // DOM ELEMENTS (Single source of truth for all element references)
  // ============================================================================

  const elements = {
    // Workflow header
    workflowName: document.getElementById("workflow-name"),
    executionState: document.getElementById("execution-state"),

    // Split button elements (New Workflow dropdown)
    btnNewWorkflowMain: document.getElementById("btn-new-workflow-main"),
    btnWorkflowDropdown: document.getElementById("btn-workflow-dropdown"),
    workflowDropdownMenu: document.getElementById("workflow-dropdown-menu"),

    // Workflow status split button elements
    workflowSplitButton: document.querySelector(".workflow-split-button"),
    workflowEmptyState: document.getElementById("workflow-empty-state"),
    btnWorkflowMain: document.getElementById("btn-workflow-main"),
    btnWorkflowStatusDropdown: document.getElementById(
      "btn-workflow-status-dropdown"
    ),
    workflowDisplay: document.getElementById("workflow-display"),
    workflowNameEdit: document.getElementById("workflow-name-edit"),
    workflowRecentMenu: document.getElementById("workflow-recent-menu"),
    workflowMenuItems: document.getElementById("workflow-menu-items"),

    // Control buttons
    runBtn: document.getElementById("btn-run"),
    pauseBtn: document.getElementById("btn-pause"),
    stopBtn: document.getElementById("btn-stop"),
    exportBtn: document.getElementById("btn-export"),

    // Prompts section
    promptCounter: document.getElementById("prompt-counter"),
    promptsList: document.getElementById("prompts-list"),
    promptsSection: document.getElementById("prompts-section"),
    btnCollapsePrompts: document.getElementById("btn-collapse-prompts"),

    // Output section
    outputSection: document.getElementById("output-section"),
    outputEditorContainer: document.getElementById("output-editor-container"),
    outputContent: document.getElementById("output-content"),
    autoscrollCheckbox: document.getElementById("autoscroll-checkbox"),
    btnCollapseOutput: document.getElementById("btn-collapse-output"),

    // Editor section
    editorSection: document.getElementById("editor-section"),
    btnCollapseEditor: document.getElementById("btn-collapse-editor"),
    editorModeIndicator: document.getElementById("editor-mode-indicator"),
    promptNameInput: document.getElementById("prompt-name-input"),
    btnNewPrompt: document.getElementById("btn-new-prompt"),
    promptEditor: document.getElementById("prompt-editor"),
    editorTokenCount: document.getElementById("editor-token-count"),

    // Property controls
    propProvider: document.getElementById("prop-provider"),
    propModel: document.getElementById("prop-model"),
    propAgent: document.getElementById("prop-agent"),
    propNewChat: document.getElementById("prop-new-chat"),
    propSessionId: document.getElementById("prop-session-id"),
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
    btnEditorRun: document.getElementById("btn-editor-run"),
    btnEditorQueue: document.getElementById("btn-editor-queue"),
    btnEditorCancel: document.getElementById("btn-editor-cancel"),
    btnEditorUpdate: document.getElementById("btn-editor-update"),
    btnEditorDelete: document.getElementById("btn-editor-delete"),

    // Layout controls
    btnLayoutVertical: document.getElementById("btn-layout-vertical"),
    btnLayoutHorizontal: document.getElementById("btn-layout-horizontal"),
    btnSwapPanels: document.getElementById("btn-swap-panels"),

    // New Workflow checkbox (deprecated toggle UI)
    newWorkflowCheckbox: document.getElementById("new-workflow-checkbox"),
    newWorkflowToggle: document.getElementById("new-workflow-toggle"),

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

    // Confirmation modal
    confirmModal: document.getElementById("confirm-modal"),
    confirmTitle: document.getElementById("confirm-title"),
    confirmMessage: document.getElementById("confirm-message"),
    confirmOk: document.getElementById("confirm-ok"),
    confirmCancel: document.getElementById("confirm-cancel"),
  };

  // ============================================================================
  // LAYOUT MODE FUNCTIONALITY (Global UI concerns - not manager-specific)
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
  // GLOBAL EVENT LISTENERS (Layout toggles and ESC key handling)
  // ============================================================================

  /**
   * Set up global event listeners (layout toggles, keyboard shortcuts)
   */
  function setupGlobalEventListeners() {
    // Layout toggle buttons
    elements.btnLayoutVertical.addEventListener("click", () => {
      setLayoutMode("vertical");
    });

    elements.btnLayoutHorizontal.addEventListener("click", () => {
      setLayoutMode("horizontal");
    });

    elements.btnSwapPanels.addEventListener("click", () => {
      togglePanelSwap();
    });

    // Global ESC key handling (properties drawer)
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        elements.propertiesDrawer.classList.contains("open")
      ) {
        editorManager.closePropertiesDrawer();
      }
    });
  }

  // ============================================================================
  // INITIALIZATION (Module wiring and startup)
  // ============================================================================

  /**
   * Initialize all managers in dependency order
   */
  function initializeManagers() {
    // Get dictionary URIs from data attributes
    const affUri = document.body.dataset.affUri;
    const dicUri = document.body.dataset.dicUri;

    // 1. Initialize state manager (no dependencies)
    stateManager.init(vscode, elements);

    // 2. Initialize managers that only need state (no interdependencies)
    outputManager.init(vscode, elements, stateManager);
    workflowManager.init(vscode, elements, stateManager);

    // 3. Initialize editor (no dependencies on other managers)
    editorManager.init(vscode, elements, stateManager, affUri, dicUri);

    // 4. Initialize prompts manager (depends on editorManager for selectPromptForEdit)
    promptsManager.init(vscode, elements, stateManager, editorManager);

    // 5. Initialize message router (depends on all managers)
    messageRouter.init(
      vscode,
      elements,
      stateManager,
      outputManager,
      promptsManager,
      workflowManager,
      editorManager
    );
  }

  /**
   * Restore UI state from localStorage
   */
  function restoreUIState() {
    // Restore section collapse states
    promptsManager.restorePromptsCollapseState();
    outputManager.restoreOutputCollapseState();
    editorManager.restoreEditorCollapseState();

    // Restore layout mode and panel swap
    restoreLayoutMode();
    restorePanelSwap();
  }

  /**
   * Main initialization entry point
   */
  function initialize() {
    // Initialize managers in dependency order
    initializeManagers();

    // Set up global event listeners
    setupGlobalEventListeners();

    // Restore UI state from localStorage
    restoreUIState();

    // Signal ready to extension
    vscode.postMessage({ type: MESSAGE_TYPES.READY });
  }

  // ============================================================================
  // STARTUP
  // ============================================================================

  // Run initialization when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
