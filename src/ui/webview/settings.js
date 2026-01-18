(function () {
  const vscode = acquireVsCodeApi();

  // Import constants from compiled DashboardConstants.js (loaded via script tag in HTML)
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

  // Model options per provider - populated dynamically from ModelRegistry
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

  // Workflow properties (from working file)
  let workflowProperties = {
    provider: undefined,
    model: undefined,
    agent: undefined,
    newChatSession: undefined,
    allowDynamicExtension: undefined,
    endCondition: undefined,
  };

  // Global settings (from VS Code)
  let globalSettings = {
    provider: PROVIDER_IDS.COPILOT_CLI,
    model: DEFAULT_MODELS[PROVIDER_IDS.COPILOT_CLI],
    agent: "",
    newChatSession: true,
    allowDynamicExtension: false,
    executionMode: "interactive",
  };

  // Available agents
  let availableAgents = [];

  // Workflow loaded state
  let workflowLoaded = false;

  const elements = {
    // Workflow properties
    workflowProvider: document.getElementById("workflow-provider"),
    workflowModel: document.getElementById("workflow-model"),
    workflowAgent: document.getElementById("workflow-agent"),
    workflowNewChat: document.getElementById("workflow-new-chat"),
    workflowDynamicExt: document.getElementById("workflow-dynamic-ext"),

    // End condition
    workflowEndEnabled: document.getElementById("workflow-end-enabled"),
    workflowEndDetails: document.getElementById("workflow-end-details"),
    workflowEndScript: document.getElementById("workflow-end-script"),
    workflowEndReturns: document.getElementById("workflow-end-returns"),
    workflowEndTimeout: document.getElementById("workflow-end-timeout"),
    workflowEndRetries: document.getElementById("workflow-end-retries"),
    workflowEndRetryPrompt: document.getElementById(
      "workflow-end-retry-prompt"
    ),

    // Session settings
    executionModeRadios: document.querySelectorAll(
      'input[name="execution-mode"]'
    ),

    // Buttons
    moreSettingsBtn: document.getElementById("more-settings-btn"),
    setDefaultButtons: document.querySelectorAll(".btn-set-default"),
  };

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  // Workflow property changes
  elements.workflowProvider.addEventListener("change", (e) => {
    const newProvider = e.target.value;
    workflowProperties.provider = newProvider;
    updateModelDropdownOptions(newProvider);

    // Select the default model for the new provider
    const defaultModel = DEFAULT_MODELS[newProvider];
    if (
      defaultModel &&
      elements.workflowModel.querySelector(`option[value="${defaultModel}"]`)
    ) {
      elements.workflowModel.value = defaultModel;
      workflowProperties.model = defaultModel;
      updateSetAsDefaultButton("model");
      saveWorkflowProperty("model", defaultModel);
    }

    updateSetAsDefaultButton("provider");
    saveWorkflowProperty("provider", newProvider);
  });

  elements.workflowModel.addEventListener("change", (e) => {
    workflowProperties.model = e.target.value;
    updateSetAsDefaultButton("model");
    saveWorkflowProperty("model", e.target.value);
  });

  elements.workflowAgent.addEventListener("change", (e) => {
    workflowProperties.agent = e.target.value;
    updateSetAsDefaultButton("agent");
    saveWorkflowProperty("agent", e.target.value);
  });

  elements.workflowNewChat.addEventListener("change", (e) => {
    workflowProperties.newChatSession = e.target.value === "true";
    updateSetAsDefaultButton("newChatSession");
    saveWorkflowProperty("newChatSession", e.target.value === "true");
  });

  elements.workflowDynamicExt.addEventListener("change", (e) => {
    workflowProperties.allowDynamicExtension = e.target.value === "true";
    updateSetAsDefaultButton("allowDynamicExtension");
    saveWorkflowProperty("allowDynamicExtension", e.target.value === "true");
  });

  // End condition
  elements.workflowEndEnabled.addEventListener("change", (e) => {
    const enabled = e.target.checked;
    elements.workflowEndDetails.hidden = !enabled;

    if (enabled) {
      // Collect end condition values
      const endCondition = {
        script: elements.workflowEndScript.value || undefined,
        returns: elements.workflowEndReturns.value || undefined,
        timeout: parseInt(elements.workflowEndTimeout.value) || undefined,
        maxRetries: parseInt(elements.workflowEndRetries.value) || undefined,
        retryPrompt: elements.workflowEndRetryPrompt.value || undefined,
      };
      workflowProperties.endCondition = endCondition;
    } else {
      workflowProperties.endCondition = undefined;
    }

    saveWorkflowProperty("endCondition", workflowProperties.endCondition);
  });

  // End condition fields
  const endConditionFields = [
    elements.workflowEndScript,
    elements.workflowEndReturns,
    elements.workflowEndTimeout,
    elements.workflowEndRetries,
    elements.workflowEndRetryPrompt,
  ];

  endConditionFields.forEach((field) => {
    field.addEventListener("change", () => {
      if (elements.workflowEndEnabled.checked) {
        const endCondition = {
          script: elements.workflowEndScript.value || undefined,
          returns: elements.workflowEndReturns.value || undefined,
          timeout: parseInt(elements.workflowEndTimeout.value) || undefined,
          maxRetries: parseInt(elements.workflowEndRetries.value) || undefined,
          retryPrompt: elements.workflowEndRetryPrompt.value || undefined,
        };
        workflowProperties.endCondition = endCondition;
        saveWorkflowProperty("endCondition", endCondition);
      }
    });
  });

  // Execution mode (updates global setting, not workflow)
  elements.executionModeRadios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      if (e.target.checked) {
        globalSettings.executionMode = e.target.value;
        vscode.postMessage({
          type: MESSAGE_TYPES.CHANGE_EXECUTION_MODE,
          executionMode: e.target.value,
        });
      }
    });
  });

  // "Set as Default" buttons
  elements.setDefaultButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const property = e.target.dataset.property;
      handleSetAsDefault(property, e.target);
    });
  });

  // More Settings button
  elements.moreSettingsBtn.addEventListener("click", () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.OPEN_SETTINGS,
    });
  });

  // ============================================================================
  // MESSAGE HANDLER
  // ============================================================================

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case MESSAGE_TYPES.INIT:
        handleInit(message.data);
        break;
      case MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE:
        handleWorkflowPropertiesUpdate(message.data);
        break;
      case MESSAGE_TYPES.WORKFLOW_LOADED:
        handleWorkflowLoaded(message.data);
        break;
      case MESSAGE_TYPES.WORKFLOW_UNLOADED:
        handleWorkflowUnloaded();
        break;
      case MESSAGE_TYPES.MODEL_OPTIONS_UPDATE:
        handleModelOptionsUpdate(message.data);
        break;
      case MESSAGE_TYPES.PROVIDER_STATUS_UPDATE:
        handleProviderStatusUpdate(message.data);
        break;
      case MESSAGE_TYPES.AGENTS_UPDATE:
        handleAgentsUpdate(message.data);
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

    // Update global settings
    if (data.globalSettings) {
      globalSettings = { ...globalSettings, ...data.globalSettings };
    }

    // Update workflow properties (if workflow loaded)
    if (data.workflowProperties) {
      workflowProperties = {
        ...workflowProperties,
        ...data.workflowProperties,
      };
      workflowLoaded = true;
    }

    // Update available agents
    if (data.availableAgents) {
      availableAgents = data.availableAgents;
    }

    // Initialize UI
    updateProviderDropdownOptions();
    updateModelDropdownOptions(
      workflowProperties.provider || globalSettings.provider
    );
    updateAgentDropdownOptions();
    updateExecutionModeRadios();

    // Load workflow properties or use global defaults
    loadWorkflowPropertiesIntoUI();

    // Update "Set as Default" button visibility
    updateAllSetAsDefaultButtons();

    // Always enable fields (allow setting workflow properties even without a loaded workflow)
    setFieldsEnabled(true);
  }

  function handleWorkflowPropertiesUpdate(data) {
    workflowProperties = { ...workflowProperties, ...data.workflowProperties };
    loadWorkflowPropertiesIntoUI();
    updateAllSetAsDefaultButtons();
  }

  function handleWorkflowLoaded(data) {
    workflowLoaded = true;
    workflowProperties = { ...workflowProperties, ...data.workflowProperties };
    loadWorkflowPropertiesIntoUI();
    updateAllSetAsDefaultButtons();
    setFieldsEnabled(true);
  }

  function handleWorkflowUnloaded() {
    workflowLoaded = false;

    // Clear workflow properties (extension maintains pending state)
    workflowProperties = {
      provider: undefined,
      model: undefined,
      agent: undefined,
      newChatSession: undefined,
      allowDynamicExtension: undefined,
      endCondition: undefined,
    };

    // Keep fields enabled so users can set properties before creating a workflow
    setFieldsEnabled(true);

    // Reload UI with global defaults
    loadWorkflowPropertiesIntoUI();
  }

  function handleModelOptionsUpdate(data) {
    if (data.modelOptions) {
      modelOptions = { ...modelOptions, ...data.modelOptions };
      updateModelDropdownOptions(
        workflowProperties.provider || globalSettings.provider
      );
    }
  }

  function handleProviderStatusUpdate(data) {
    if (data.providerStatus) {
      providerStatus = { ...providerStatus, ...data.providerStatus };
      updateProviderDropdownOptions();
    }
  }

  function handleAgentsUpdate(data) {
    if (data.availableAgents) {
      availableAgents = data.availableAgents;
      updateAgentDropdownOptions();
    }
  }

  // ============================================================================
  // UI UPDATE FUNCTIONS
  // ============================================================================

  function loadWorkflowPropertiesIntoUI() {
    // Provider
    const provider = workflowProperties.provider || globalSettings.provider;
    elements.workflowProvider.value = provider;

    // Model
    updateModelDropdownOptions(provider);
    const model = workflowProperties.model || globalSettings.model;
    elements.workflowModel.value = model;

    // Agent
    const agent =
      workflowProperties.agent !== undefined
        ? workflowProperties.agent
        : globalSettings.agent;
    elements.workflowAgent.value = agent || "";

    // New Chat Session
    const newChat =
      workflowProperties.newChatSession !== undefined
        ? workflowProperties.newChatSession
        : globalSettings.newChatSession;
    elements.workflowNewChat.value = String(newChat);

    // Allow Dynamic Extension
    const dynamicExt =
      workflowProperties.allowDynamicExtension !== undefined
        ? workflowProperties.allowDynamicExtension
        : globalSettings.allowDynamicExtension;
    elements.workflowDynamicExt.value = String(dynamicExt);

    // End Condition
    if (workflowProperties.endCondition) {
      elements.workflowEndEnabled.checked = true;
      elements.workflowEndDetails.hidden = false;
      elements.workflowEndScript.value =
        workflowProperties.endCondition.script || "";
      elements.workflowEndReturns.value =
        workflowProperties.endCondition.returns || "";
      elements.workflowEndTimeout.value =
        workflowProperties.endCondition.timeout || 30000;
      elements.workflowEndRetries.value =
        workflowProperties.endCondition.maxRetries || 0;
      elements.workflowEndRetryPrompt.value =
        workflowProperties.endCondition.retryPrompt || "";
    } else {
      elements.workflowEndEnabled.checked = false;
      elements.workflowEndDetails.hidden = true;
    }
  }

  function updateProviderDropdownOptions() {
    const providers = [
      PROVIDER_IDS.COPILOT_CLI,
      PROVIDER_IDS.COPILOT_CHAT,
      PROVIDER_IDS.CLAUDE_CLI,
      PROVIDER_IDS.CODEX_CLI,
    ];

    elements.workflowProvider.innerHTML = providers
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

    if (options.length === 0) {
      elements.workflowModel.innerHTML = `<option value="" disabled>${UI_STRINGS.LOADING_MODELS}</option>`;
      return;
    }

    elements.workflowModel.innerHTML = options
      .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
      .join("");

    // After populating, ensure a valid model is selected
    // If current value is not in the options, select the default for this provider
    const currentValue = elements.workflowModel.value;
    const isValidOption = options.some((opt) => opt.value === currentValue);

    if (!isValidOption || !currentValue) {
      const defaultModel = DEFAULT_MODELS[provider];
      if (defaultModel && options.some((opt) => opt.value === defaultModel)) {
        elements.workflowModel.value = defaultModel;
      } else if (options.length > 0) {
        // Fallback to first option if default not available
        elements.workflowModel.value = options[0].value;
      }
    }
  }

  function updateAgentDropdownOptions() {
    if (!availableAgents || availableAgents.length === 0) {
      elements.workflowAgent.innerHTML = `<option value="">None (default behavior)</option>`;
      return;
    }

    elements.workflowAgent.innerHTML = availableAgents
      .map((agent) => {
        const value = agent.name || "";
        const label = agent.displayName || "None (default behavior)";

        let suffix = "";
        if (agent.name) {
          if (agent.source === "user") {
            suffix = " (User)";
          } else if (agent.source === "workspace-github") {
            suffix = " (.github)";
          } else if (agent.source === "workspace-claude") {
            suffix = " (.claude)";
          }
        }

        return `<option value="${value}">${label}${suffix}</option>`;
      })
      .join("");
  }

  function updateExecutionModeRadios() {
    const mode = globalSettings.executionMode || "interactive";
    elements.executionModeRadios.forEach((radio) => {
      radio.checked = radio.value === mode;
    });
  }

  function setFieldsEnabled(enabled) {
    // Enable/disable all workflow property fields
    elements.workflowProvider.disabled = !enabled;
    elements.workflowModel.disabled = !enabled;
    elements.workflowAgent.disabled = !enabled;
    elements.workflowNewChat.disabled = !enabled;
    elements.workflowDynamicExt.disabled = !enabled;
    elements.workflowEndEnabled.disabled = !enabled;
    elements.workflowEndScript.disabled = !enabled;
    elements.workflowEndReturns.disabled = !enabled;
    elements.workflowEndTimeout.disabled = !enabled;
    elements.workflowEndRetries.disabled = !enabled;
    elements.workflowEndRetryPrompt.disabled = !enabled;

    // Hide all "Set as Default" buttons when no workflow
    if (!enabled) {
      elements.setDefaultButtons.forEach((btn) => {
        btn.hidden = true;
      });
    }
  }

  // ============================================================================
  // "SET AS DEFAULT" BUTTON LOGIC
  // ============================================================================

  function updateSetAsDefaultButton(property) {
    const btn = document.querySelector(`[data-property="${property}"]`);
    if (!btn) {
      return;
    }

    const workflowValue = workflowProperties[property];
    const globalValue = globalSettings[property];

    // Show button if workflow value differs from global setting
    const isDifferent =
      workflowValue !== undefined && workflowValue !== globalValue;
    btn.hidden = !isDifferent;
  }

  function updateAllSetAsDefaultButtons() {
    updateSetAsDefaultButton("provider");
    updateSetAsDefaultButton("model");
    updateSetAsDefaultButton("agent");
    updateSetAsDefaultButton("newChatSession");
    updateSetAsDefaultButton("allowDynamicExtension");
  }

  function handleSetAsDefault(property, buttonElement) {
    const value = workflowProperties[property];
    const provider = workflowProperties.provider || globalSettings.provider;

    // Send message to extension to update VS Code setting
    vscode.postMessage({
      type: MESSAGE_TYPES.SET_AS_DEFAULT,
      property: property,
      value: value,
      provider: property === "model" ? provider : undefined,
    });

    // Update global settings in local state
    globalSettings[property] = value;

    // Animate button
    animateSetAsDefaultButton(buttonElement);
  }

  function animateSetAsDefaultButton(buttonElement) {
    // Change button text to show checkmark
    buttonElement.textContent = "✓ Default";
    buttonElement.classList.add("success");

    // After 2 seconds, fade out and hide
    setTimeout(() => {
      buttonElement.classList.add("fade-out");
      setTimeout(() => {
        buttonElement.hidden = true;
        buttonElement.classList.remove("success", "fade-out");
        buttonElement.textContent = "Set as Default";
      }, 300);
    }, 2000);
  }

  // ============================================================================
  // SAVE WORKFLOW PROPERTY
  // ============================================================================

  function saveWorkflowProperty(property, value) {
    // Update local state for UI consistency
    workflowProperties[property] = value;

    // Always send to extension - it will decide whether to:
    // - Update working file (if workflow loaded)
    // - Store in pending properties (if no workflow yet)
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY,
      property: property,
      value: value,
    });
  }

  // Request initial state
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
