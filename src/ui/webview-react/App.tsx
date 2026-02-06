import { useEffect, useLayoutEffect, useRef } from "react";
import {
  Panel,
  Group,
  Separator,
  PanelImperativeHandle,
  GroupImperativeHandle,
} from "react-resizable-panels";
import { useMessageHandler } from "@hooks/useMessageHandler";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSettingsStore } from "@store/settingsStore";
import { MESSAGE_TYPES, IncomingMessage } from "@/types/messages";
import {
  Header,
  PromptsPanel,
  OutputSection,
  EditorSection,
  SettingsPanel,
} from "./components/layout";

function App() {
  const vscode = useVsCodeApi();

  // Panel imperative refs for programmatic collapse/expand
  const settingsRef = useRef<PanelImperativeHandle>(null);
  const promptsRef = useRef<PanelImperativeHandle>(null);
  const outputRef = useRef<PanelImperativeHandle>(null);
  const editorRef = useRef<PanelImperativeHandle>(null);
  // Vertical group ref for setLayout() API
  const verticalGroupRef = useRef<GroupImperativeHandle>(null);
  // Gates onResize until useLayoutEffect has applied the persisted
  // collapsed/expanded state.  Reset to false whenever both panels are collapsed
  // (the vertical Group unmounts); the next mount re-gates until the first
  // useLayoutEffect re-syncs.
  const initializedRef = useRef(false);
  // Track last expanded sizes (restored when re-expanding, captured during drag)
  const lastOutputSize = useRef(60);
  const lastEditorSize = useRef(40);
  // Flag: true when Group just remounted from both-collapsed, false after forced resize
  const needsForcedResize = useRef(false);
  // Flag: true during forced resize operation to prevent onResize from saving wrong values
  const isForcingResize = useRef(false);

  // Collapse state from store (source of truth)
  const settingsCollapsed = useUiStore((s) => s.settingsCollapsed);
  const setSettingsCollapsed = useUiStore((s) => s.setSettingsCollapsed);
  const promptsCollapsed = useUiStore((s) => s.promptsCollapsed);
  const setPromptsCollapsed = useUiStore((s) => s.setPromptsCollapsed);
  const outputCollapsed = useUiStore((s) => s.outputCollapsed);
  const setOutputCollapsed = useUiStore((s) => s.setOutputCollapsed);
  const editorCollapsed = useUiStore((s) => s.editorCollapsed);
  const setEditorCollapsed = useUiStore((s) => s.setEditorCollapsed);

  // Stable mount defaults — only recomputed on the both-collapsed → one-open
  // transition (i.e. when the vertical Group remounts).  Keeping defaultSize
  // constant while the Group is already mounted prevents the library from
  // re-initialising and overriding imperative collapse()/expand() calls.
  const wasBothCollapsed = useRef(outputCollapsed && editorCollapsed);
  const mountDefaultOutput = useRef(
    outputCollapsed
      ? "30px"
      : editorCollapsed
        ? "95"
        : String(lastOutputSize.current)
  );
  const mountDefaultEditor = useRef(
    editorCollapsed
      ? "30px"
      : outputCollapsed
        ? "95"
        : String(lastEditorSize.current)
  );

  // Zustand stores
  const workflowStore = useWorkflowStore();
  const settingsStore = useSettingsStore();

  // Message handlers with full implementations
  useMessageHandler({
    INIT: handleInit,
    FILE_SELECTED: handleFileSelected,
    SESSION_RESTORED: handleSessionRestored,
    EXECUTION_STARTED: handleExecutionStarted,
    EXECUTION_STATE_CHANGED: handleExecutionStateChanged,
    EXECUTION_COMPLETED: handleExecutionCompleted,
    PROGRESS_UPDATE: handleProgressUpdate,
    STEP_STATUS_CHANGED: handleStepStatusChanged,
    RETRY_ATTEMPT_CHANGED: handleRetryAttemptChanged,
    CLI_OUTPUT: handleCliOutput,
    CLI_STREAMING_CHUNK: handleCliStreamingChunk,
    CLI_STREAMING_EVENTS: handleCliStreamingEvents,
    STATUS_MESSAGE: handleStatusMessage,
    PROMPTS_EXTENDED: handlePromptsExtended,
    PROMPT_DELETED: handlePromptDeleted,
    MODEL_OPTIONS_UPDATE: handleModelOptionsUpdate,
    PROVIDER_STATUS_UPDATE: handleProviderStatusUpdate,
    AGENTS_UPDATE: handleAgentsUpdate,
    WORKFLOW_PROPERTIES_UPDATE: handleWorkflowPropertiesUpdate,
    WORKFLOW_LOADED: handleWorkflowLoaded,
    WORKFLOW_UNLOADED: handleWorkflowUnloaded,
    WORKFLOW_NAME_UPDATED: handleWorkflowNameUpdated,
    RECENT_WORKFLOWS: handleRecentWorkflows,
    OPEN_NEW_WORKFLOW_MODAL: handleOpenNewWorkflowModal,
    TEMPLATE_INFO: handleTemplateInfo,
    DEFAULT_TEMPLATE_SET: handleDefaultTemplateSet,
    WORKFLOW_CREATED: handleWorkflowCreated,
    COMPLETIONS_RESPONSE: handleCompletionsResponse,
    QUEUE_EXTENDED: handleQueueExtended,
    QUEUE_SIZE_LIMIT_REACHED: handleQueueSizeLimitReached,
    EXECUTION_TIME_LIMIT_REACHED: handleExecutionTimeLimitReached,
  });

  // Signal ready to extension
  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.READY });
  }, []);

  // Initial collapse sync — runs before first paint to avoid flash
  useLayoutEffect(() => {
    if (settingsCollapsed) settingsRef.current?.collapse();
    if (promptsCollapsed) promptsRef.current?.collapse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ongoing store → panel sync
  useEffect(() => {
    if (settingsCollapsed) settingsRef.current?.collapse();
    else settingsRef.current?.expand();
  }, [settingsCollapsed]);

  useEffect(() => {
    if (promptsCollapsed) promptsRef.current?.collapse();
    else promptsRef.current?.expand();
  }, [promptsCollapsed]);

  // Sync store → panels imperatively.  Runs before paint so there is no visible
  // flash of the default 60/40 split before the persisted collapsed state is
  // applied.  Does NOT open the onResize gate — that is done in the useEffect
  // below, which runs after all child effects (including the Panel mount
  // onResize events) have fired.
  useLayoutEffect(() => {
    const shouldForceResize =
      !outputCollapsed && !editorCollapsed && needsForcedResize.current;

    if (shouldForceResize) {
      // Force resize: use setLayout() to atomically expand and resize both panels
      isForcingResize.current = true;

      if (verticalGroupRef.current) {
        // Round to integers and ensure they sum to 100
        const outputSize = Math.round(lastOutputSize.current);
        const editorSize = 100 - outputSize;

        // setLayout expects an object with panel IDs as keys
        const layout = {
          "output-panel": outputSize,
          "editor-panel": editorSize,
        };

        try {
          verticalGroupRef.current.setLayout(layout);
        } catch (error) {
          console.error("[LAYOUT] ❌ setLayout() failed:", error);
        }
      } else {
        console.error("[LAYOUT] ❌ verticalGroupRef.current is null!");
      }

      needsForcedResize.current = false;

      // Clear flag after a brief delay to allow onResize events to process
      setTimeout(() => {
        isForcingResize.current = false;
      }, 50);
    } else {
      // Normal collapse/expand
      if (outputRef.current) {
        if (outputCollapsed) {
          outputRef.current.collapse();
        } else {
          outputRef.current.expand();
        }
      }

      if (editorRef.current) {
        if (editorCollapsed) {
          editorRef.current.collapse();
        } else {
          editorRef.current.expand();
        }
      }
    }
  }, [outputCollapsed, editorCollapsed]);

  // Gate management: closed when both panels are collapsed (the Group
  // unmounts; next mount needs re-sync before onResize is trusted).  Opened
  // in useEffect (not useLayoutEffect) so that the Panel mount onResize
  // events — which fire in child useEffects — are still gated when they run.
  useEffect(() => {
    if (outputCollapsed && editorCollapsed) {
      initializedRef.current = false;
      // Clear forced resize flag when both collapse
      if (needsForcedResize.current) {
        needsForcedResize.current = false;
      }
    } else {
      initializedRef.current = true;
    }
  }, [outputCollapsed, editorCollapsed]);

  // Update mount defaults only when the Group is about to remount
  // (both-collapsed → one-open).  While the Group stays alive defaultSize
  // must remain constant so the library does not re-initialise and clobber
  // imperative collapse()/expand() calls.
  {
    const bothCollapsed = outputCollapsed && editorCollapsed;
    if (wasBothCollapsed.current && !bothCollapsed) {
      mountDefaultOutput.current = outputCollapsed
        ? "30px"
        : editorCollapsed
          ? "95"
          : String(lastOutputSize.current);
      mountDefaultEditor.current = editorCollapsed
        ? "30px"
        : outputCollapsed
          ? "95"
          : String(lastEditorSize.current);
      // Group is remounting - next both-open transition needs forced resize
      needsForcedResize.current = true;
    }
    wasBothCollapsed.current = bothCollapsed;
  }

  return (
    <div className="h-screen w-full flex flex-col bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]">
      <Header />

      {/* Main layout: Prompts (left) | Output/Editor (center) | Settings (right) */}
      <Group
        orientation="horizontal"
        className="flex-1"
        id="flightpath-main-layout"
      >
        {/* Prompts Panel (Left - collapsible) */}
        <Panel
          panelRef={promptsRef}
          defaultSize="20"
          collapsible
          collapsedSize="32px"
          minSize="10"
          maxSize="40"
          id="prompts-panel"
          onResize={() => {
            setPromptsCollapsed(promptsRef.current?.isCollapsed() ?? false);
          }}
        >
          <PromptsPanel />
        </Panel>

        <Separator className="w-1 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-col-resize transition-colors" />

        {/* Center content — Output (top) / Editor (bottom), both independently
            collapsible.  When both are collapsed the vertical Group unmounts and
            we render a plain flex stack of the two collapsed bars — the library
            can't keep two panels at collapsedSize (5 % each) without a third
            panel or maxSize tricks, both of which break imperative expand().
            When at least one panel is open the Group is active and the user can
            drag the separator freely. */}
        <Panel id="center-content">
          {(() => {
            const bothCollapsed = outputCollapsed && editorCollapsed;
            return bothCollapsed;
          })() ? (
            <div className="flex flex-col h-full bg-[var(--vscode-editor-background)]">
              <div className="flex-none">
                <OutputSection />
              </div>
              <div className="flex-none">
                <EditorSection />
              </div>
            </div>
          ) : (
            <Group
              groupRef={verticalGroupRef}
              orientation="vertical"
              className="h-full"
              id="flightpath-vertical-layout"
            >
              <Panel
                panelRef={outputRef}
                defaultSize={mountDefaultOutput.current}
                collapsible
                collapsedSize="30px"
                minSize="15"
                id="output-panel"
                onResize={() => {
                  if (!initializedRef.current) {
                    return;
                  }
                  const outputCollapsed =
                    outputRef.current?.isCollapsed() ?? false;
                  const editorCollapsed =
                    editorRef.current?.isCollapsed() ?? false;
                  const currentSize = outputRef.current?.getSize().asPercentage;

                  if (
                    !outputCollapsed &&
                    !editorCollapsed &&
                    !isForcingResize.current
                  ) {
                    lastOutputSize.current =
                      currentSize ?? lastOutputSize.current;
                  }
                  setOutputCollapsed(outputCollapsed);
                }}
              >
                <OutputSection />
              </Panel>

              <Separator className="h-1 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-row-resize transition-colors" />

              <Panel
                panelRef={editorRef}
                defaultSize={mountDefaultEditor.current}
                collapsible
                collapsedSize="30px"
                minSize="15"
                id="editor-panel"
                onResize={() => {
                  if (!initializedRef.current) {
                    return;
                  }
                  const editorCollapsed =
                    editorRef.current?.isCollapsed() ?? false;
                  const outputCollapsed =
                    outputRef.current?.isCollapsed() ?? false;
                  const currentSize = editorRef.current?.getSize().asPercentage;

                  if (
                    !editorCollapsed &&
                    !outputCollapsed &&
                    !isForcingResize.current
                  ) {
                    lastEditorSize.current =
                      currentSize ?? lastEditorSize.current;
                  } else if (isForcingResize.current) {
                  }
                  setEditorCollapsed(editorCollapsed);
                }}
              >
                <EditorSection />
              </Panel>
            </Group>
          )}
        </Panel>

        <Separator className="w-1 bg-[var(--vscode-panel-border)] hover:bg-[var(--vscode-focusBorder)] cursor-col-resize transition-colors" />

        {/* Settings Panel (Right - collapsible) */}
        <Panel
          panelRef={settingsRef}
          defaultSize="20"
          collapsible
          collapsedSize="32px"
          minSize="15"
          maxSize="40"
          id="settings-panel"
          onResize={() => {
            setSettingsCollapsed(settingsRef.current?.isCollapsed() ?? false);
          }}
        >
          <SettingsPanel />
        </Panel>
      </Group>
    </div>
  );

  // ========================================
  // Message Handler Implementations
  // ========================================

  /**
   * Initialize workflow state from extension
   */
  function handleInit(
    message: IncomingMessage & { type: typeof MESSAGE_TYPES.INIT }
  ) {
    console.log("[App] INIT message received:", message);
    const { data } = message;

    // Update workflow state
    workflowStore.setFileName(data.fileName);
    workflowStore.setWorkflowName(data.workflowName);
    workflowStore.setPrompts(data.prompts || []);
    workflowStore.setExecutionState(data.executionState || "idle");
    workflowStore.setCurrentStep(data.currentIndex || 0);

    // Update settings state
    if (data.modelOptions) {
      settingsStore.setModelOptions(data.modelOptions);
    }
    if (data.availableAgents) {
      settingsStore.setAvailableAgents(data.availableAgents);
    }
    if (data.providerStatus) {
      Object.entries(data.providerStatus).forEach(([provider, status]) => {
        settingsStore.setProviderStatus(provider, status.status);
      });
    }
  }

  /**
   * Handle file selection - Load new workflow
   */
  function handleFileSelected(message: any) {
    console.log("[App] FILE_SELECTED message received:", message);
    workflowStore.setFileName(message.fileName);
    workflowStore.setWorkflowName(message.workflowName || "");
    workflowStore.setPrompts(message.prompts || []);
    workflowStore.setExecutionState("idle");
    workflowStore.setCurrentStep(0);
    workflowStore.resetWorkflow();
  }

  /**
   * Handle session restoration from working file
   */
  function handleSessionRestored(message: any) {
    console.log("[App] SESSION_RESTORED message received:", message);
    workflowStore.setFileName(message.fileName);
    workflowStore.setWorkflowName(message.workflowName || "");
    workflowStore.setPrompts(message.prompts || []);
    workflowStore.setExecutionState(message.executionState || "idle");
    workflowStore.setCurrentStep(message.currentIndex || 0);

    // Restore results/outputs if available
    if (message.results && Array.isArray(message.results)) {
      message.results.forEach((result: any, index: number) => {
        if (result.output) {
          workflowStore.addCliOutput(index, JSON.stringify(result.output));
        }
      });
    }
  }

  /**
   * Handle execution start
   */
  function handleExecutionStarted(message: any) {
    console.log("[App] EXECUTION_STARTED message received:", message);
    workflowStore.setExecutionState("running");
    workflowStore.setCurrentStep(0);
    // Clear previous outputs for fresh run
    workflowStore.resetWorkflow();
  }

  /**
   * Handle execution state changes
   */
  function handleExecutionStateChanged(message: any) {
    console.log("[App] EXECUTION_STATE_CHANGED message received:", message);
    workflowStore.setExecutionState(message.state);
    if (message.currentStep !== undefined) {
      workflowStore.setCurrentStep(message.currentStep);
    }
  }

  /**
   * Handle execution completion
   */
  function handleExecutionCompleted() {
    console.log("[App] EXECUTION_COMPLETED message received");
    workflowStore.setExecutionState("completed");
  }

  /**
   * Handle progress updates
   */
  function handleProgressUpdate(message: any) {
    console.log("[App] PROGRESS_UPDATE message received:", message);
    if (message.current !== undefined) {
      workflowStore.setCurrentStep(message.current);
    }
  }

  /**
   * Handle step status changes
   */
  function handleStepStatusChanged(message: any) {
    console.log("[App] STEP_STATUS_CHANGED message received:", message);
    workflowStore.updatePrompt(message.stepIndex, {
      status: message.status,
      details: message.details,
    });
  }

  /**
   * Handle retry attempt changes
   */
  function handleRetryAttemptChanged(message: any) {
    console.log("[App] RETRY_ATTEMPT_CHANGED message received:", message);
    workflowStore.setRetryState(
      message.stepIndex,
      message.currentRetry,
      message.maxRetries
    );
    workflowStore.addStatusMessage(
      message.stepIndex,
      `Retry attempt ${message.currentRetry} of ${message.maxRetries}`
    );
  }

  /**
   * Handle CLI output
   */
  function handleCliOutput(message: any) {
    console.log("[App] CLI_OUTPUT message received:", message);
    const outputText =
      message.output?.response || JSON.stringify(message.output);
    workflowStore.addCliOutput(message.stepIndex, outputText);
  }

  /**
   * Handle CLI streaming chunks
   */
  function handleCliStreamingChunk(message: any) {
    console.log("[App] CLI_STREAMING_CHUNK message received:", message);
    workflowStore.addCliOutput(message.stepIndex, message.chunk);
  }

  /**
   * Handle CLI streaming events
   */
  function handleCliStreamingEvents(message: any) {
    console.log("[App] CLI_STREAMING_EVENTS message received:", message);
    // Events will be rendered by OutputSection component
    workflowStore.addCliOutput(
      message.stepIndex,
      JSON.stringify(message.events, null, 2)
    );
  }

  /**
   * Handle status messages
   */
  function handleStatusMessage(message: any) {
    console.log("[App] STATUS_MESSAGE message received:", message);
    const formattedMessage = `[${message.severity.toUpperCase()}] ${message.message}`;
    workflowStore.addStatusMessage(message.stepIndex, formattedMessage);
  }

  /**
   * Handle dynamic queue extension
   */
  function handlePromptsExtended(message: any) {
    console.log("[App] PROMPTS_EXTENDED message received:", message);
    workflowStore.setPrompts(message.prompts || []);
  }

  /**
   * Handle prompt deletion
   */
  function handlePromptDeleted(message: any) {
    console.log("[App] PROMPT_DELETED message received:", message);
    workflowStore.setPrompts(message.prompts || []);
  }

  /**
   * Handle model options update
   */
  function handleModelOptionsUpdate(message: any) {
    console.log("[App] MODEL_OPTIONS_UPDATE message received:", message);
    if (message.data?.modelOptions) {
      settingsStore.setModelOptions(message.data.modelOptions);
    }
  }

  /**
   * Handle provider status update
   */
  function handleProviderStatusUpdate(message: any) {
    console.log("[App] PROVIDER_STATUS_UPDATE message received:", message);
    if (message.data?.providerStatus) {
      Object.entries(message.data.providerStatus).forEach(
        ([provider, status]: [string, any]) => {
          settingsStore.setProviderStatus(provider, status.status);
        }
      );
    }
  }

  /**
   * Handle agents list update
   */
  function handleAgentsUpdate(message: any) {
    console.log("[App] AGENTS_UPDATE message received:", message);
    if (message.data?.availableAgents) {
      settingsStore.setAvailableAgents(message.data.availableAgents);
    }
  }

  /**
   * Handle workflow properties update
   */
  function handleWorkflowPropertiesUpdate(message: any) {
    console.log("[App] WORKFLOW_PROPERTIES_UPDATE message received:", message);
    // Workflow properties will be handled by SettingsDrawer component
  }

  /**
   * Handle workflow loaded
   */
  function handleWorkflowLoaded() {
    console.log("[App] WORKFLOW_LOADED message received");
    // Enable settings UI (handled by SettingsDrawer)
  }

  /**
   * Handle workflow unloaded
   */
  function handleWorkflowUnloaded() {
    console.log("[App] WORKFLOW_UNLOADED message received");
    // Disable settings UI (handled by SettingsDrawer)
    workflowStore.resetWorkflow();
  }

  /**
   * Handle workflow name updated
   */
  function handleWorkflowNameUpdated(message: any) {
    console.log("[App] WORKFLOW_NAME_UPDATED message received:", message);
    workflowStore.setWorkflowName(message.workflowName);
  }

  /**
   * Handle recent workflows list
   */
  function handleRecentWorkflows(message: any) {
    console.log("[App] RECENT_WORKFLOWS message received:", message);
    // Recent workflows will be handled by workflow status component
  }

  /**
   * Handle new workflow modal open
   */
  function handleOpenNewWorkflowModal(message: any) {
    console.log("[App] OPEN_NEW_WORKFLOW_MODAL message received:", message);
    // Modal will be handled by modal component
  }

  /**
   * Handle template info
   */
  function handleTemplateInfo(message: any) {
    console.log("[App] TEMPLATE_INFO message received:", message);
    // Template info will be handled by modal component
  }

  /**
   * Handle default template set
   */
  function handleDefaultTemplateSet(message: any) {
    console.log("[App] DEFAULT_TEMPLATE_SET message received:", message);
    // Confirmation handled by modal component
  }

  /**
   * Handle workflow created
   */
  function handleWorkflowCreated(message: any) {
    console.log("[App] WORKFLOW_CREATED message received:", message);
    // Success notification and modal close handled by modal component
  }

  /**
   * Handle completions response
   */
  function handleCompletionsResponse(message: any) {
    console.log("[App] COMPLETIONS_RESPONSE message received:", message);
    // Completions will be handled by CodeMirror editor component
  }

  /**
   * Handle queue extended notification
   */
  function handleQueueExtended(message: any) {
    console.log("[App] QUEUE_EXTENDED message received:", message);
    // Notification handled by notification system
  }

  /**
   * Handle queue size limit reached
   */
  function handleQueueSizeLimitReached(message: any) {
    console.log("[App] QUEUE_SIZE_LIMIT_REACHED message received:", message);
    workflowStore.addStatusMessage(
      -1,
      `Queue size limit reached: ${message.currentSize}/${message.maxSize}`
    );
  }

  /**
   * Handle execution time limit reached
   */
  function handleExecutionTimeLimitReached(message: any) {
    console.log(
      "[App] EXECUTION_TIME_LIMIT_REACHED message received:",
      message
    );
    workflowStore.addStatusMessage(
      -1,
      `Execution time limit reached: ${message.elapsedSeconds}/${message.maxSeconds}s (${message.completedCount}/${message.totalCount} prompts)`
    );
    workflowStore.setExecutionState("stopped");
  }
}

export default App;
