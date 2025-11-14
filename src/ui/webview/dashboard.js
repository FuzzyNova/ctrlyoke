(function() {
  const vscode = acquireVsCodeApi();

  // State management
  let state = {
    fileName: null,
    prompts: [],
    executionState: 'idle',
    currentStep: 0,
    totalSteps: 0,
    cliOutputs: {}
  };

  // DOM elements
  const elements = {
    fileName: document.getElementById('file-name'),
    changeFileBtn: document.getElementById('change-file'),
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
    vscode.postMessage({ type: 'selectFile' });
  });

  elements.runBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'run' });
  });

  elements.pauseBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pause' });
  });

  elements.stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });

  // Message handler
  window.addEventListener('message', event => {
    const message = event.data;
    
    switch (message.type) {
      case 'init':
        handleInit(message.data);
        break;
      case 'fileSelected':
        handleFileSelected(message.fileName, message.prompts);
        break;
      case 'executionStarted':
        handleExecutionStarted(message.fileName, message.totalSteps);
        break;
      case 'progressUpdate':
        handleProgressUpdate(message.current, message.total);
        break;
      case 'stepStatusChanged':
        handleStepStatusChanged(message.stepIndex, message.status, message.details);
        break;
      case 'cliOutput':
        handleCliOutput(message.stepIndex, message.output);
        break;
      case 'executionCompleted':
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
    state.executionState = 'idle';
    state.currentStep = 0;
    state.totalSteps = 0;
    state.cliOutputs = {};
    // Hide progress bar and output section
    elements.progressContainer.style.display = 'none';
    elements.outputSection.style.display = 'none';
    render();
  }

  function handleExecutionStarted(fileName, totalSteps) {
    state.executionState = 'running';
    state.totalSteps = totalSteps;
    state.currentStep = 0;
    updateControls();
    elements.progressContainer.style.display = 'block';
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

  function handleCliOutput(stepIndex, output) {
    state.cliOutputs[stepIndex] = output;
    if (stepIndex === state.currentStep - 1) {
      renderCliOutput(output);
    }
  }

  function handleExecutionCompleted() {
    state.executionState = 'completed';
    updateControls();
  }

  function render() {
    elements.fileName.textContent = state.fileName || 'No file selected';
    renderPromptsList();
    updateControls();
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

  function renderCliOutput(output) {
    elements.outputSection.style.display = 'block';
    
    let html = `<div class="cli-output-item">`;
    html += `<div class="output-header">[Prompt ${state.currentStep}]</div>`;
    
    if (output.prompt) {
      html += `<div class="output-prompt">${escapeHtml(output.prompt)}</div>`;
    }
    
    if (output.response) {
      html += `<div class="output-response">${escapeHtml(output.response)}</div>`;
    }
    
    if (output.tokens) {
      html += `<div class="output-stats">📊 Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion</div>`;
    }
    
    html += `<div class="output-stats">⏱️ ${output.elapsed}s</div>`;
    html += `</div>`;
    
    elements.outputContent.innerHTML = html;
  }

  function updateControls() {
    const isRunning = state.executionState === 'running';
    const hasFile = state.fileName !== null;
    const isCompleted = state.executionState === 'completed';
    
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
      pending: '⏸️',
      running: '▶️',
      completed: '✅',
      failed: '❌'
    };
    return icons[status] || '⏸️';
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
  vscode.postMessage({ type: 'ready' });
})();
