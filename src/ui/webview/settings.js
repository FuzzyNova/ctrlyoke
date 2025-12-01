(function () {
  const vscode = acquireVsCodeApi();

  // Import constants from compiled DashboardConstants.js (loaded via script tag in HTML)
  // Single source of truth - these match src/types/DashboardConstants.ts
  const { MESSAGE_TYPES } = window.FlightPathConstants;

  // Model options per provider - populated dynamically from ModelRegistry via INIT message
  // Chat models come from VS Code LM API (full list)
  // CLI models come from `copilot help config` (subset)
  // Claude CLI models are static (no programmatic way to query)
  let modelOptions = {
    "copilot-cli": [],
    "copilot-chat": [],
    "claude-cli": [
      { value: "sonnet", label: "Sonnet (Recommended)" },
      { value: "opus", label: "Opus (Most Capable)" },
      { value: "haiku", label: "Haiku (Fastest)" },
    ],
  };

  // Provider availability status
  let providerStatus = {
    "copilot-cli": { available: false, status: "checking" },
    "copilot-chat": { available: true, status: "available" },
    "claude-cli": { available: false, status: "checking" },
  };

  // Provider display names and labels
  const PROVIDER_INFO = {
    "copilot-cli": { name: "Copilot CLI", shortName: "Copilot CLI" },
    "copilot-chat": { name: "Copilot Chat", shortName: "Copilot Chat" },
    "claude-cli": { name: "Claude CLI", shortName: "Claude CLI" },
  };

  // Default models per provider
  const DEFAULT_MODELS = {
    "copilot-cli": "claude-sonnet-4.5",
    "copilot-chat": "claude-sonnet-4.5",
    "claude-cli": "sonnet",
  };

  let state = {
    provider: "copilot-cli",
    model: "claude-sonnet-4.5",
    dynamicQueueEnabled: false,
  };

  const elements = {
    providerDropdown: document.getElementById("provider-dropdown"),
    modelDropdown: document.getElementById("model-dropdown"),
    dynamicQueueCheckbox: document.getElementById("dynamic-queue-checkbox"),
  };

  // Event listeners
  elements.providerDropdown.addEventListener("change", (e) => {
    state.provider = e.target.value;
    updateModelDropdownOptions(state.provider);
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
    const providers = ["copilot-cli", "copilot-chat", "claude-cli"];

    elements.providerDropdown.innerHTML = providers
      .map((id) => {
        const info = PROVIDER_INFO[id];
        const status = providerStatus[id];
        const isAvailable = status?.available !== false;
        const isChecking = status?.status === "checking";

        let label = info.name;
        if (isChecking) {
          label += " (checking...)";
        } else if (!isAvailable) {
          label += " (not available)";
        }

        return `<option value="${id}" ${!isAvailable ? "disabled" : ""}>${label}</option>`;
      })
      .join("");
  }

  function updateModelDropdownOptions(provider) {
    const options = modelOptions[provider] || [];

    // Show loading state if no models yet
    if (options.length === 0) {
      elements.modelDropdown.innerHTML =
        '<option value="" disabled>Loading models...</option>';
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

  // Request initial state
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
