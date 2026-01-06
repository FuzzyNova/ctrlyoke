(function () {
  const vscode = acquireVsCodeApi();

  // Import constants from compiled DashboardConstants.js (loaded via script tag in HTML)
  // Single source of truth - these match src/types/DashboardConstants.ts
  const {
    MESSAGE_TYPES,
    PROVIDER_IDS,
    PROVIDER_INFO,
    DEFAULT_MODELS,
    CLAUDE_CLI_MODELS,
    CODEX_CLI_MODELS,
    PROVIDER_STATUS_STRINGS,
    UI_STRINGS,
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

  // Provider availability status
  let providerStatus = {
    [PROVIDER_IDS.COPILOT_CLI]: {
      available: false,
      status: PROVIDER_STATUS_STRINGS.CHECKING,
    },
    [PROVIDER_IDS.COPILOT_CHAT]: {
      available: true,
      status: PROVIDER_STATUS_STRINGS.AVAILABLE,
    },
    [PROVIDER_IDS.CLAUDE_CLI]: {
      available: false,
      status: PROVIDER_STATUS_STRINGS.CHECKING,
    },
    [PROVIDER_IDS.CODEX_CLI]: {
      available: false,
      status: PROVIDER_STATUS_STRINGS.CHECKING,
    },
  };

  let state = {
    provider: PROVIDER_IDS.COPILOT_CLI,
    model: DEFAULT_MODELS[PROVIDER_IDS.COPILOT_CLI],
    agent: "default",
    executionMode: "interactive",
    newChatSessionPerPrompt: true,
    dynamicQueueEnabled: false,
  };

  const elements = {
    providerDropdown: document.getElementById("provider-dropdown"),
    modelDropdown: document.getElementById("model-dropdown"),
    agentDropdown: document.getElementById("agent-dropdown"),
    executionModeDropdown: document.getElementById("execution-mode-dropdown"),
    executionModeGroup: document.getElementById("execution-mode-group"),
    newChatSessionCheckbox: document.getElementById(
      "new-chat-session-checkbox"
    ),
    dynamicQueueCheckbox: document.getElementById("dynamic-queue-checkbox"),
  };

  // Event listeners
  elements.providerDropdown.addEventListener("change", (e) => {
    state.provider = e.target.value;
    updateModelDropdownOptions(state.provider);
    updateExecutionModeVisibility(state.provider);
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_PROVIDER,
      provider: state.provider,
    });
  });

  elements.modelDropdown.addEventListener("change", (e) => {
    state.model = e.target.value;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_MODEL,
      model: state.model,
      provider: state.provider,
    });
  });

  elements.agentDropdown.addEventListener("change", (e) => {
    state.agent = e.target.value;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_AGENT,
      agent: state.agent,
    });
  });

  elements.executionModeDropdown.addEventListener("change", (e) => {
    state.executionMode = e.target.value;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_EXECUTION_MODE,
      executionMode: state.executionMode,
    });
  });

  elements.newChatSessionCheckbox.addEventListener("change", (e) => {
    state.newChatSessionPerPrompt = e.target.checked;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_NEW_CHAT_SESSION,
      enabled: state.newChatSessionPerPrompt,
    });
  });

  elements.dynamicQueueCheckbox.addEventListener("change", (e) => {
    state.dynamicQueueEnabled = e.target.checked;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHANGE_DYNAMIC_QUEUE,
      enabled: state.dynamicQueueEnabled,
    });
  });

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
      case MESSAGE_TYPES.PROVIDER_STATUS_UPDATE:
        handleProviderStatusUpdate(message.data);
        break;
    }
  });

  function handleInit(data) {
    // Update model options from extension (dynamic from ModelRegistry)
    if (data.modelOptions) {
      modelOptions = { ...modelOptions, ...data.modelOptions };
    }

    // Update provider status
    if (data.providerStatus) {
      providerStatus = { ...providerStatus, ...data.providerStatus };
    }

    state = { ...state, ...data };

    // Update provider dropdown with availability status
    updateProviderDropdownOptions();
    elements.providerDropdown.value = state.provider;

    updateModelDropdownOptions(state.provider);
    elements.modelDropdown.value = state.model;
    elements.agentDropdown.value = state.agent || "default";
    elements.executionModeDropdown.value = state.executionMode;
    updateExecutionModeVisibility(state.provider);
    elements.newChatSessionCheckbox.checked = state.newChatSessionPerPrompt;
    elements.dynamicQueueCheckbox.checked = state.dynamicQueueEnabled;
  }

  /**
   * Handle model options update from extension (when ModelRegistry finishes loading)
   */
  function handleModelOptionsUpdate(data) {
    if (data.modelOptions) {
      modelOptions = { ...modelOptions, ...data.modelOptions };
      // Refresh current provider's model dropdown
      updateModelDropdownOptions(state.provider);
      // Try to restore selected model if still valid
      const options = modelOptions[state.provider] || [];
      const matchingOption = options.find((opt) => opt.value === state.model);
      if (matchingOption) {
        elements.modelDropdown.value = state.model;
      } else if (options.length > 0) {
        elements.modelDropdown.value = options[0].value;
      }
    }
  }

  /**
   * Handle provider status update from extension
   */
  function handleProviderStatusUpdate(data) {
    if (data.providerStatus) {
      providerStatus = { ...providerStatus, ...data.providerStatus };
      updateProviderDropdownOptions();
      elements.providerDropdown.value = state.provider;
    }
  }

  /**
   * Update provider dropdown to show availability status
   */
  function updateProviderDropdownOptions() {
    const providers = [
      PROVIDER_IDS.COPILOT_CLI,
      PROVIDER_IDS.COPILOT_CHAT,
      PROVIDER_IDS.CLAUDE_CLI,
      PROVIDER_IDS.CODEX_CLI,
    ];

    elements.providerDropdown.innerHTML = providers
      .map((id) => {
        const info = PROVIDER_INFO[id];
        const status = providerStatus[id];
        const isAvailable = status?.available !== false;
        const isChecking = status?.status === PROVIDER_STATUS_STRINGS.CHECKING;

        let label = info.name;
        if (isChecking) {
          label += ` (${UI_STRINGS.CHECKING_STATUS})`;
        } else if (!isAvailable) {
          label += ` (${UI_STRINGS.NOT_AVAILABLE})`;
        }

        return `<option value="${id}" ${!isAvailable ? "disabled" : ""}>${label}</option>`;
      })
      .join("");
  }

  function updateModelDropdownOptions(provider) {
    const options = modelOptions[provider] || [];

    // Show loading state if no models yet
    if (options.length === 0) {
      elements.modelDropdown.innerHTML = `<option value="" disabled>${UI_STRINGS.LOADING_MODELS}</option>`;
      return;
    }

    elements.modelDropdown.innerHTML = options
      .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
      .join("");

    // Try to keep current model if available in new provider
    const matchingOption = options.find((opt) => opt.value === state.model);
    if (matchingOption) {
      elements.modelDropdown.value = state.model;
    } else if (options.length > 0) {
      // Default to first option for this provider
      state.model = DEFAULT_MODELS[provider] || options[0].value;
      elements.modelDropdown.value = state.model;
      // Notify extension of model change due to provider switch
      vscode.postMessage({
        type: MESSAGE_TYPES.CHANGE_MODEL,
        model: state.model,
        provider: state.provider,
      });
    }
  }

  /**
   * Show/hide execution mode dropdown based on provider
   * Only CLI providers (copilot-cli, claude-cli, codex-cli) support execution mode
   */
  function updateExecutionModeVisibility(provider) {
    const isCli =
      provider === PROVIDER_IDS.COPILOT_CLI ||
      provider === PROVIDER_IDS.CLAUDE_CLI ||
      provider === PROVIDER_IDS.CODEX_CLI;

    if (isCli) {
      // Remove inline override so `.setting-group` flex layout applies
      elements.executionModeGroup.style.removeProperty("display");
    } else {
      elements.executionModeGroup.style.display = "none";
    }
  }

  // Request initial state
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
