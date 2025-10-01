import * as vscode from 'vscode';
import * as path from 'path';
import { PromptFileParser } from './PromptFileParser';
import { PromptQueue } from './PromptQueue';
import { CopilotIntegration } from './CopilotIntegration';
import { PromptFile, PromptItem, QueueState } from '../types/FlightPathTypes';

export class FlightPathManager {
    private promptFileParser: PromptFileParser;
    private promptQueue: PromptQueue;
    private copilotIntegration: CopilotIntegration;
    private context: vscode.ExtensionContext;
    private statusBarItem: vscode.StatusBarItem;
    private currentWorkspaceFolder: vscode.WorkspaceFolder | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.promptFileParser = new PromptFileParser();
        this.promptQueue = new PromptQueue();
        this.copilotIntegration = new CopilotIntegration(context);
        
        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'flightpath.openPanel';
        this.updateStatusBar();
        context.subscriptions.push(this.statusBarItem);
        
        // Listen to queue state changes
        this.promptQueue.onDidChangeState(this.onQueueStateChanged.bind(this));
        
        // Get current workspace folder
        this.currentWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
        
        console.log('FlightPath: Manager initialized');
    }

    /**
     * Initialize FlightPath manager
     */
    async initialize(): Promise<void> {
        try {
            console.log('FlightPath: Initializing manager...');
            
            // Discover existing prompt files
            await this.discoverPromptFiles();
            
            // Refresh Copilot integration and check automation capabilities
            await this.copilotIntegration.refresh();
            const status = this.copilotIntegration.getStatus();
            console.log(`FlightPath: ${status.message}`);
            
            // Update status bar
            this.updateStatusBar();
            
            console.log('FlightPath: Manager initialization complete');
        } catch (error) {
            console.error('FlightPath: Failed to initialize manager:', error);
            vscode.window.showErrorMessage(`FlightPath: Initialization failed: ${error}`);
        }
    }

    /**
     * Execute a prompt file
     */
    async executePromptFile(filePath: string): Promise<void> {
        try {
            console.log(`FlightPath: Executing prompt file: ${filePath}`);
            
            // Parse the prompt file
            const promptFile = await this.promptFileParser.parsePromptFile(filePath);
            if (!promptFile || !promptFile.prompts) {
                vscode.window.showErrorMessage('FlightPath: Failed to parse prompt file');
                return;
            }
            
            // Validate prompts
            const validation = this.promptFileParser.validatePromptItems(promptFile.prompts);
            if (!validation.valid) {
                const errors = validation.errors.join('\n');
                vscode.window.showErrorMessage(`FlightPath: Validation failed:\n${errors}`);
                return;
            }
            
            // Load prompts into queue
            this.promptQueue.loadPrompts(promptFile.prompts);
            
            // Check automation capabilities and show appropriate message
            const capabilities = this.copilotIntegration.getCapabilities();
            const fileName = path.basename(filePath);
            let confirmMessage = `Execute ${promptFile.prompts.length} prompt(s) from ${fileName}?`;
            
            if (capabilities.supportsZeroInteraction) {
                confirmMessage += '\n\n✅ Direct automation enabled - workflow will run automatically!';
            } else {
                confirmMessage += '\n\n❌ Direct automation unavailable - workflow cannot run. Check automation status for details.';
            }
            
            const action = await vscode.window.showInformationMessage(
                confirmMessage,
                { modal: true },
                'Take Off',
                'Test Automation',
                'Cancel'
            );
            
            if (action === 'Take Off') {
                // Set workflow progress in Copilot integration
                this.copilotIntegration.setWorkflowProgress(1, promptFile.prompts.length);
                await this.startWorkflowExecution();
            } else if (action === 'Test Automation') {
                await this.copilotIntegration.testAutomation();
            }
            
        } catch (error) {
            console.error('FlightPath: Failed to execute prompt file:', error);
            vscode.window.showErrorMessage(`FlightPath: Execution failed: ${error}`);
        }
    }

    /**
     * Start workflow execution with Copilot integration
     */
    private async startWorkflowExecution(): Promise<void> {
        const state = this.promptQueue.getState();
        
        for (let i = 0; i < state.prompts.length; i++) {
            const prompt = state.prompts[i];
            
            // Update progress
            this.copilotIntegration.setWorkflowProgress(i + 1, state.prompts.length);
            
            // Send prompt to Copilot
            const result = await this.copilotIntegration.executePromptWithContext(prompt);
            
            if (!result.success) {
                vscode.window.showErrorMessage(`FlightPath: Failed to execute prompt ${i + 1}: ${result.message}`);
                break;
            }
            
            // Mark as sent in queue
            await this.promptQueue.markCurrentAsSent();
            
            // Check if workflow was paused
            if (this.promptQueue.getState().status === 'paused') {
                break;
            }
        }
    }

    /**
     * Take off - execute selected prompt file
     */
    async takeOff(): Promise<void> {
        try {
            if (!this.currentWorkspaceFolder) {
                vscode.window.showErrorMessage('FlightPath: No workspace folder found');
                return;
            }
            
            // Discover available prompt files
            const promptFiles = await this.promptFileParser.discoverPromptFiles(this.currentWorkspaceFolder);
            
            if (promptFiles.length === 0) {
                const createAction = await vscode.window.showInformationMessage(
                    'No prompt files found. Would you like to create one?',
                    'Create Prompt File',
                    'Cancel'
                );
                
                if (createAction === 'Create Prompt File') {
                    await this.createPromptFile();
                }
                return;
            }
            
            // Show quick pick for file selection
            const items = promptFiles.map(filePath => ({
                label: path.basename(filePath),
                description: path.relative(this.currentWorkspaceFolder!.uri.fsPath, filePath),
                filePath
            }));
            
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a prompt file to execute',
                ignoreFocusOut: true
            });
            
            if (selected) {
                await this.executePromptFile(selected.filePath);
            }
            
        } catch (error) {
            console.error('FlightPath: Take off failed:', error);
            vscode.window.showErrorMessage(`FlightPath: Take off failed: ${error}`);
        }
    }

    /**
     * Pause current execution
     */
    pause(): void {
        this.promptQueue.pause();
    }

    /**
     * Resume execution
     */
    async resume(): Promise<void> {
        await this.promptQueue.resume();
    }

    /**
     * Stop current execution
     */
    stop(): void {
        this.promptQueue.stop();
    }

    /**
     * Create a new prompt file
     */
    async createPromptFile(): Promise<void> {
        try {
            if (!this.currentWorkspaceFolder) {
                vscode.window.showErrorMessage('FlightPath: No workspace folder found');
                return;
            }
            
            // Get file name from user
            const fileName = await vscode.window.showInputBox({
                prompt: 'Enter prompt file name',
                placeHolder: 'my-workflow.prompt.json',
                validateInput: (value) => {
                    if (!value) {
                        return 'File name is required';
                    }
                    if (!value.endsWith('.prompt.json') && !value.endsWith('.flightpath.json')) {
                        return 'File must end with .prompt.json or .flightpath.json';
                    }
                    return null;
                }
            });
            
            if (!fileName) {
                return;
            }
            
            // Create prompts directory if it doesn't exist
            const promptsDir = vscode.workspace.getConfiguration('flightpath').get<string>('promptsDirectory', '.flightpath');
            const promptsDirPath = path.join(this.currentWorkspaceFolder.uri.fsPath, promptsDir);
            const filePath = path.join(promptsDirPath, fileName);
            
            // Create example content
            const exampleContent = fileName.endsWith('.flightpath.json') ? 
                this.createExampleFlightPathContent() : 
                this.createExamplePromptContent();
            
            // Write file
            const uri = vscode.Uri.file(filePath);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(exampleContent, 'utf8'));
            
            // Open file for editing
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            
            vscode.window.showInformationMessage(`FlightPath: Created ${fileName}`);
            
        } catch (error) {
            console.error('FlightPath: Failed to create prompt file:', error);
            vscode.window.showErrorMessage(`FlightPath: Failed to create prompt file: ${error}`);
        }
    }

    /**
     * Open FlightPath panel
     */
    async openPanel(): Promise<void> {
        // This would open the WebView panel
        // For now, just show the take off command
        await this.takeOff();
    }

    /**
     * Get current queue state
     */
    getQueueState(): QueueState {
        return this.promptQueue.getState();
    }

    /**
     * Get Copilot integration status
     */
    getCopilotStatus(): { available: boolean; message: string; strategy: string } {
        return this.copilotIntegration.getStatus();
    }

    /**
     * Test Copilot automation
     */
    async testCopilotAutomation(): Promise<boolean> {
        return await this.copilotIntegration.testAutomation();
    }

    /**
     * Get Copilot integration capabilities
     */
    getCopilotCapabilities() {
        return this.copilotIntegration.getCapabilities();
    }

    /**
     * Discover prompt files in workspace
     */
    private async discoverPromptFiles(): Promise<void> {
        if (!this.currentWorkspaceFolder) {
            return;
        }
        
        const promptFiles = await this.promptFileParser.discoverPromptFiles(this.currentWorkspaceFolder);
        console.log(`FlightPath: Discovered ${promptFiles.length} prompt files`);
    }

    /**
     * Handle queue state changes
     */
    private onQueueStateChanged(state: QueueState): void {
        console.log(`FlightPath: Queue state changed to ${state.status}`);
        this.updateStatusBar();
        
        // Handle prompt execution
        if (state.status === 'running' && state.prompts.length > 0) {
            const currentPrompt = this.promptQueue.getCurrentPrompt();
            if (currentPrompt) {
                this.executeCurrentPrompt(currentPrompt);
            }
        }
    }

    /**
     * Execute current prompt with Copilot
     */
    private async executeCurrentPrompt(prompt: PromptItem): Promise<void> {
        try {
            console.log('FlightPath: Executing prompt with Copilot (stub implementation)');
            
            // This is where we would integrate with GitHub Copilot Chat API
            // For now, show the prompt and simulate execution
            const action = await vscode.window.showInformationMessage(
                `FlightPath: Ready to send prompt to Copilot:\n\n"${prompt.prompt.substring(0, 100)}..."`,
                'Send to Copilot',
                'Skip',
                'Stop'
            );
            
            if (action === 'Send to Copilot') {
                // Simulate sending to Copilot
                await this.promptQueue.markCurrentAsSent();
                
                // Simulate completion after a delay (in real implementation, this would be triggered by end condition)
                setTimeout(async () => {
                    await this.promptQueue.completeCurrentAndMoveNext();
                }, 2000);
                
            } else if (action === 'Skip') {
                await this.promptQueue.completeCurrentAndMoveNext();
            } else {
                this.promptQueue.stop();
            }
            
        } catch (error) {
            console.error('FlightPath: Failed to execute prompt:', error);
            this.promptQueue.markCurrentAsFailed(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Update status bar item
     */
    private updateStatusBar(): void {
        const state = this.promptQueue.getState();
        const progress = this.promptQueue.getProgress();
        
        let text = '$(rocket) FlightPath';
        let tooltip = 'FlightPath - Click to open';
        
        switch (state.status) {
            case 'running':
                text = `$(loading~spin) FlightPath ${progress.current}/${progress.total}`;
                tooltip = `FlightPath - Running (${progress.percentage}% complete)`;
                break;
            case 'paused':
                text = `$(debug-pause) FlightPath ${progress.current}/${progress.total}`;
                tooltip = 'FlightPath - Paused (click to resume)';
                break;
            case 'completed':
                text = `$(check) FlightPath Complete`;
                tooltip = 'FlightPath - Workflow completed successfully';
                break;
            case 'error':
                text = `$(error) FlightPath Error`;
                tooltip = 'FlightPath - Execution failed (click to retry)';
                break;
        }
        
        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.show();
    }

    /**
     * Create example prompt content
     */
    private createExamplePromptContent(): string {
        return JSON.stringify({
            prompt: "Analyze the current file and suggest improvements",
            context: {
                includeCurrentFile: true,
                includeSelection: false
            },
            endCondition: {
                script: "check_improvements.py",
                returns: "true"
            }
        }, null, 2);
    }

    /**
     * Create example FlightPath content
     */
    private createExampleFlightPathContent(): string {
        return JSON.stringify({
            prompts: [
                {
                    prompt: "Analyze this codebase for potential bugs",
                    context: {
                        includeWorkspaceFiles: ["src/**/*.ts"]
                    }
                },
                {
                    prompt: "Fix any issues found in the analysis",
                    context: {
                        includeCurrentFile: true
                    },
                    endCondition: {
                        script: "run_tests.py",
                        returns: "all_passed"
                    }
                }
            ]
        }, null, 2);
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.statusBarItem.dispose();
        console.log('FlightPath: Manager disposed');
    }
}