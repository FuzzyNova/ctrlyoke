(function() {
  const vscode = acquireVsCodeApi();

  // Import constants from compiled DashboardConstants.js (loaded via script tag in HTML)
  // Single source of truth - these match src/types/DashboardConstants.ts
  // Only importing cross-file shared constants (not UI-specific strings)
  const {
    MESSAGE_TYPES,
    EXECUTION_STATES,
    STEP_STATUS
  } = window.FlightPathConstants;

  // State management
  let state = {
    fileName: null,
    prompts: [],
    executionState: EXECUTION_STATES.IDLE,
    currentStep: 0,
    totalSteps: 0,
    cliOutputs: {}, // Maps stepIndex -> array of outputs (including retries)
    retryStates: {} // Maps stepIndex -> { currentRetry, maxRetries }
  };

  // DOM elements
  const elements = {
    fileName: document.getElementById('file-name'),
    changeFileBtn: document.getElementById('change-file'),
    executionState: document.getElementById('execution-state'),
    runBtn: document.getElementById('btn-run'),
    pauseBtn: document.getElementById('btn-pause'),
    stopBtn: document.getElementById('btn-stop'),
    progressContainer: document.getElementById('progress-container'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    promptsList: document.getElementById('prompts-list'),
    outputSection: document.getElementById('output-section'),
    outputContent: document.getElementById('output-content')
  };

  // Event listeners
  elements.changeFileBtn.addEventListener('click', () => {
    vscode.postMessage({ type: MESSAGE_TYPES.SELECT_FILE });
  });

  elements.runBtn.addEventListener('click', () => {
    vscode.postMessage({ type: MESSAGE_TYPES.RUN });
  });

  elements.pauseBtn.addEventListener('click', () => {
    vscode.postMessage({ type: MESSAGE_TYPES.PAUSE });
  });

  elements.stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: MESSAGE_TYPES.STOP });
  });

  // Message handler
  window.addEventListener('message', event => {
    const message = event.data;
    
    switch (message.type) {
      case MESSAGE_TYPES.INIT:
        handleInit(message.data);
        break;
      case MESSAGE_TYPES.FILE_SELECTED:
        handleFileSelected(message.fileName, message.prompts);
        break;
      case MESSAGE_TYPES.EXECUTION_STARTED:
        handleExecutionStarted(message.fileName, message.totalSteps);
        break;
      case MESSAGE_TYPES.EXECUTION_STATE_CHANGED:
        handleExecutionStateChanged(message.state);
        break;
      case MESSAGE_TYPES.PROGRESS_UPDATE:
        handleProgressUpdate(message.current, message.total);
        break;
      case MESSAGE_TYPES.STEP_STATUS_CHANGED:
        handleStepStatusChanged(message.stepIndex, message.status, message.details);
        break;
      case MESSAGE_TYPES.RETRY_ATTEMPT_CHANGED:
        handleRetryAttemptChanged(message.stepIndex, message.currentRetry, message.maxRetries);
        break;
      case MESSAGE_TYPES.CLI_OUTPUT:
        handleCliOutput(message.stepIndex, message.output);
        break;
      case MESSAGE_TYPES.CLI_STREAMING_CHUNK:
        handleCliStreamingChunk(message.stepIndex, message.chunk);
        break;
      case MESSAGE_TYPES.EXECUTION_COMPLETED:
        handleExecutionCompleted();
        break;
    }
  });

  function handleInit(data) {
    state = { ...state, ...data };
    render();
  }

  function handleFileSelected(fileName, prompts) {
    state.fileName = fileName;
    state.prompts = prompts.map((p, i) => ({
      index: i,
      text: p.prompt || p,
      status: 'pending',
      details: {}
    }));
    // Reset execution state and progress when new file is selected
    state.executionState = EXECUTION_STATES.IDLE;
    state.currentStep = 0;
    state.totalSteps = 0;
    state.cliOutputs = {}; // Reset outputs
    state.retryStates = {}; // Reset retry states
    // Hide progress bar
    elements.progressContainer.style.display = 'none';
    // Clear CLI output and show empty state
    elements.outputContent.innerHTML = '<p class="empty-state">CLI output will appear here during execution</p>';
    render();
  }

  function handleExecutionStarted(fileName, totalSteps) {
    state.executionState = EXECUTION_STATES.RUNNING;
    state.totalSteps = totalSteps;
    state.currentStep = 0;
    updateControls();
    elements.progressContainer.style.display = 'block';
  }

  function handleExecutionStateChanged(executionState) {
    state.executionState = executionState;
    render();
  }

  function handleProgressUpdate(current, total) {
    state.currentStep = current;
    state.totalSteps = total;
    
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
    elements.progressFill.style.width = `${percentage}%`;
    elements.progressText.textContent = `${current}/${total} (${percentage}%)`;
  }

  function handleStepStatusChanged(stepIndex, status, details) {
    if (state.prompts[stepIndex]) {
      state.prompts[stepIndex].status = status.state;
      state.prompts[stepIndex].details = { ...status, ...details };
      renderPromptsList();
    }
  }

  function handleRetryAttemptChanged(stepIndex, currentRetry, maxRetries) {
    state.retryStates[stepIndex] = { currentRetry, maxRetries };
    renderPromptsList();
  }

  function handleCliOutput(stepIndex, output) {
    console.log('📊 Dashboard: Received CLI output for step', stepIndex, output);
    
    // Initialize array for this step if needed
    if (!state.cliOutputs[stepIndex]) {
      state.cliOutputs[stepIndex] = [];
    }
    
    // If this is a non-streaming (final) output, check if we should replace or append
    if (!output.isStreaming) {
      // If the last output for this step was streaming, replace it with the final version
      const outputs = state.cliOutputs[stepIndex];
      if (outputs.length > 0 && outputs[outputs.length - 1].isStreaming) {
        outputs[outputs.length - 1] = output;
      } else {
        // This is a retry attempt - append it
        outputs.push(output);
      }
    } else {
      // Streaming output - either add new or update existing
      const outputs = state.cliOutputs[stepIndex];
      if (outputs.length === 0 || !outputs[outputs.length - 1].isStreaming) {
        outputs.push(output);
      } else {
        outputs[outputs.length - 1] = output;
      }
    }
    
    console.log('📊 Dashboard: currentStep =', state.currentStep, 'stepIndex =', stepIndex, 'outputCount =', state.cliOutputs[stepIndex].length);
    if (stepIndex === state.currentStep - 1) {
      console.log('✅ Dashboard: Rendering CLI output');
      renderCliOutputs(stepIndex);
    } else {
      console.log('⚠️ Dashboard: Not rendering - stepIndex mismatch');
    }
  }

  function handleCliStreamingChunk(stepIndex, chunk) {
    // Initialize array if needed
    if (!state.cliOutputs[stepIndex]) {
      state.cliOutputs[stepIndex] = [];
    }
    
    const outputs = state.cliOutputs[stepIndex];
    
    // Initialize streaming buffer if needed
    if (outputs.length === 0 || !outputs[outputs.length - 1].isStreaming) {
      outputs.push({
        prompt: '',
        response: '',
        elapsed: 0,
        tokens: null,
        isStreaming: true
      });
    }

    // Append chunk to the last (streaming) output's response
    outputs[outputs.length - 1].response += chunk;

    // Render if this is the current step
    if (stepIndex === state.currentStep - 1) {
      renderCliOutputs(stepIndex);
    }
  }

  function handleExecutionCompleted() {
    state.executionState = EXECUTION_STATES.COMPLETED;
    updateControls();
  }

  function render() {
    elements.fileName.textContent = state.fileName || 'No file selected';
    renderExecutionState();
    renderPromptsList();
    updateControls();
  }

  function renderExecutionState() {
    // Remove all state classes
    elements.executionState.className = '';
    
    // Add new state class
    const stateClass = `execution-state-${state.executionState}`;
    elements.executionState.className = stateClass;
    
    // Update text based on state
    let stateText = '';
    switch (state.executionState) {
      case EXECUTION_STATES.IDLE:
        stateText = 'Ready';
        break;
      case EXECUTION_STATES.RUNNING:
        stateText = 'Running';
        break;
      case EXECUTION_STATES.PAUSED:
        stateText = 'Paused';
        break;
      case EXECUTION_STATES.COMPLETED:
        stateText = 'Completed';
        break;
      case EXECUTION_STATES.ERROR:
        stateText = 'Error';
        break;
      default:
        stateText = state.executionState;
    }
    elements.executionState.textContent = stateText;
  }

  function renderPromptsList() {
    if (state.prompts.length === 0) {
      elements.promptsList.innerHTML = '<p class="empty-state">No prompts loaded</p>';
      return;
    }

    elements.promptsList.innerHTML = state.prompts.map(prompt => {
      const icon = getStatusIcon(prompt.status);
      const statusClass = `prompt-item status-${prompt.status}`;
      
      let detailsHtml = '';
      
      // Show retry state if retrying
      const retryState = state.retryStates[prompt.index];
      if (retryState && retryState.currentRetry > 0) {
        detailsHtml += `<div class="prompt-retry">🔄 Retry ${retryState.currentRetry} of ${retryState.maxRetries}</div>`;
      }
      
      if (prompt.details.duration) {
        detailsHtml += `<div class="prompt-detail">Duration: ${prompt.details.duration}s</div>`;
      }
      if (prompt.details.endConditionResult) {
        const result = prompt.details.endConditionResult;
        const resultIcon = result.passed ? '✓' : '✗';
        detailsHtml += `<div class="prompt-detail">End condition: ${resultIcon} ${result.message || ''}</div>`;
      }
      if (prompt.details.message) {
        detailsHtml += `<div class="prompt-status-msg">${prompt.details.message}</div>`;
      }

      return `
        <div class="${statusClass}">
          <div class="prompt-header">
            <span class="prompt-icon">${icon}</span>
            <span class="prompt-text">${prompt.index + 1}. ${truncate(prompt.text, 60)}</span>
          </div>
          ${detailsHtml}
        </div>
      `;
    }).join('');
  }

  function renderCliOutputs(stepIndex) {
    const outputs = state.cliOutputs[stepIndex];
    
    if (!outputs || outputs.length === 0) {
      // Show empty state
      elements.outputContent.innerHTML = '<p class="empty-state">CLI output will appear here during execution</p>';
      return;
    }
    
    // Render all outputs for this step (initial attempt + retries)
    let html = '';
    outputs.forEach((output, attemptIndex) => {
      const attemptLabel = attemptIndex === 0 ? 'Initial Attempt' : `Retry ${attemptIndex}`;
      const streamingIndicator = output.isStreaming ? ' <span style="color: #4ec9b0;">⬤ Streaming...</span>' : '';
      
      html += '<div class="cli-output-item">';
      html += `<div class="output-header">[Prompt ${state.currentStep}] ${attemptLabel}${streamingIndicator}</div>`;
      
      if (output.prompt) {
        html += `<div class="output-prompt">${escapeHtml(output.prompt)}</div>`;
      }
      
      if (output.response) {
        html += `<div class="output-response">${escapeHtml(output.response)}</div>`;
      }
      
      if (output.tokens) {
        html += `<div class="output-stats">📊 Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion</div>`;
      }
      
      if (!output.isStreaming && output.elapsed !== undefined) {
        html += `<div class="output-stats">⏱️ ${output.elapsed}s</div>`;
      }
      
      html += '</div>';
    });
    
    elements.outputContent.innerHTML = html;
    
    // Auto-scroll to bottom if last output is streaming
    const lastOutput = outputs[outputs.length - 1];
    if (lastOutput.isStreaming) {
      elements.outputContent.scrollTop = elements.outputContent.scrollHeight;
    }
  }

  function updateControls() {
    const isRunning = state.executionState === EXECUTION_STATES.RUNNING;
    const hasFile = state.fileName !== null;
    const isCompleted = state.executionState === EXECUTION_STATES.COMPLETED;
    
    // Enable Run button if: has file AND (not running OR is completed)
    elements.runBtn.disabled = !hasFile || (isRunning && !isCompleted);
    // Change button text and class based on state
    elements.runBtn.textContent = isCompleted ? '↻' : '▶';
    elements.runBtn.title = isCompleted ? 'Re-run' : 'Run';
    elements.runBtn.className = isCompleted ? 'btn-rerun' : 'btn-primary';
    
    elements.pauseBtn.disabled = !isRunning;
    elements.stopBtn.disabled = !isRunning;
  }

  function getStatusIcon(status) {
    const icons = {
      [STEP_STATUS.PENDING]: '⏸️',
      [STEP_STATUS.RUNNING]: '▶️',
      [STEP_STATUS.COMPLETED]: '✅',
      [STEP_STATUS.FAILED]: '❌'
    };
    return icons[status] || icons[STEP_STATUS.PENDING];
  }

  function truncate(str, maxLen) {
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Signal ready
  vscode.postMessage({ type: MESSAGE_TYPES.READY });
})();
