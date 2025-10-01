import * as vscode from 'vscode';
import { PromptItem, ContextConfig } from '../types/FlightPathTypes';

/**
 * Automation strategy for sending prompts to Copilot Chat
 */
enum AutomationStrategy {
    DirectTextInsertion = 'direct',
    CommandSequence = 'sequence',
    EnhancedClipboard = 'clipboard',
    Unavailable = 'unavailable'
}

/**
 * GitHub Copilot Chat Integration with Multi-Strategy Automation
 * 
 * Implements proven zero-interaction automation for Copilot Chat using:
 * 1. Direct text insertion (primary - validated in POC)
 * 2. Command sequence automation (secondary)
 * 3. Enhanced clipboard fallback (tertiary)
 * 
 * Based on validated proof-of-concept in extension.ts:testCopilotAutomation()
 */
export class CopilotIntegration {
    private context: vscode.ExtensionContext;
    private isAvailable: boolean = false;
    private availableStrategy: AutomationStrategy = AutomationStrategy.Unavailable;
    private workflowStep: number = 0;
    private totalSteps: number = 0;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.initialize();
    }

    /**
     * Initialize Copilot integration and detect best automation strategy
     */
    private async initialize(): Promise<void> {
        await this.checkCopilotAvailability();
        await this.detectBestAutomationStrategy();
    }

    /**
     * Check if GitHub Copilot is available
     */
    private async checkCopilotAvailability(): Promise<void> {
        try {
            // Check if GitHub Copilot extension is installed and active
            const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
            const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');
            
            this.isAvailable = !!(copilotExtension?.isActive || copilotChatExtension?.isActive);
            
            if (this.isAvailable) {
                console.log('FlightPath: GitHub Copilot detected and available');
            } else {
                console.log('FlightPath: GitHub Copilot not available - will use fallback strategies');
            }
        } catch (error) {
            console.error('FlightPath: Error checking Copilot availability:', error);
            this.isAvailable = false;
        }
    }

    /**
     * Detect the best available automation strategy for this VS Code environment
     * Based on available commands and extensions
     */
    private async detectBestAutomationStrategy(): Promise<void> {
        try {
            const commands = await vscode.commands.getCommands();
            
            // Check for direct text insertion support (primary strategy - PROVEN)
            const hasTypeCommand = commands.includes('type');
            const hasChatSubmit = commands.includes('workbench.action.chat.submit');
            const hasChatFocus = commands.includes('workbench.panel.chat.view.copilot.focus');
            
            if (hasTypeCommand && hasChatSubmit && hasChatFocus) {
                this.availableStrategy = AutomationStrategy.DirectTextInsertion;
                console.log('✅ FlightPath: Direct text insertion automation available (PROVEN strategy)');
                return;
            }
            
            // Check for command sequence support (secondary strategy)
            const hasPasteCommand = commands.includes('editor.action.clipboardPasteAction');
            const hasSelectAll = commands.includes('editor.action.selectAll');
            
            if (hasPasteCommand && hasChatSubmit && hasChatFocus && hasSelectAll) {
                this.availableStrategy = AutomationStrategy.CommandSequence;
                console.log('✅ FlightPath: Command sequence automation available (fallback strategy)');
                return;
            }
            
            // Fallback to enhanced clipboard strategy
            if (hasChatFocus) {
                this.availableStrategy = AutomationStrategy.EnhancedClipboard;
                console.log('⚠️ FlightPath: Using enhanced clipboard strategy (manual paste required)');
                return;
            }
            
            // No automation available
            this.availableStrategy = AutomationStrategy.Unavailable;
            console.log('❌ FlightPath: No automation strategy available');
            
        } catch (error) {
            console.error('FlightPath: Error detecting automation strategy:', error);
            this.availableStrategy = AutomationStrategy.Unavailable;
        }
    }

    /**
     * Send prompt to GitHub Copilot Chat with multi-strategy automation
     * 
     * Implements fallback chain:
     * 1. Direct text insertion (zero-interaction - PROVEN)
     * 2. Command sequence automation (minimal interaction)
     * 3. Enhanced clipboard (manual paste required)
     * 4. Unavailable (error state)
     */
    async sendPrompt(prompt: PromptItem): Promise<boolean> {
        try {
            console.log(`FlightPath: Sending prompt using ${this.availableStrategy} strategy`);
            
            // Build prompt with Copilot Chat syntax
            const chatPrompt = await this.buildCopilotChatPrompt(prompt);
            
            // Execute based on available strategy
            switch (this.availableStrategy) {
                case AutomationStrategy.DirectTextInsertion:
                    return await this.sendPromptWithDirectAutomation(chatPrompt);
                
                case AutomationStrategy.CommandSequence:
                    return await this.sendPromptWithCommandSequence(chatPrompt);
                
                case AutomationStrategy.EnhancedClipboard:
                    return await this.sendPromptWithEnhancedClipboard(chatPrompt, prompt);
                
                case AutomationStrategy.Unavailable:
                default:
                    return await this.handleUnavailableAutomation(chatPrompt);
            }
            
        } catch (error) {
            console.error('FlightPath: Failed to send prompt to Copilot:', error);
            vscode.window.showErrorMessage(`FlightPath: Failed to send prompt: ${error}`);
            return false;
        }
    }

    /**
     * Strategy 1: Direct text insertion automation (PROVEN - zero interaction)
     * 
     * Based on validated proof-of-concept in extension.ts:testCopilotAutomation()
     * Timing delays are proven and validated - do not reduce!
     */
    private async sendPromptWithDirectAutomation(chatPrompt: string): Promise<boolean> {
        try {
            console.log('🚀 FlightPath: Using direct text insertion (zero-interaction automation)');
            
            // Step 1: Focus Copilot Chat panel
            await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
            await new Promise(resolve => setTimeout(resolve, 1000)); // PROVEN: 1000ms required
            
            // Step 2: Clear any existing input
            await vscode.commands.executeCommand('editor.action.selectAll');
            await new Promise(resolve => setTimeout(resolve, 300)); // PROVEN: 300ms required
            
            // Step 3: Type the prompt directly into chat input
            await vscode.commands.executeCommand('type', { text: chatPrompt });
            await new Promise(resolve => setTimeout(resolve, 500)); // PROVEN: 500ms required
            
            // Step 4: Submit automatically
            await vscode.commands.executeCommand('workbench.action.chat.submit');
            
            console.log('✅ FlightPath: Prompt sent successfully with zero-interaction automation');
            
            // Update workflow progress
            await this.updateWorkflowProgress();
            
            return true;
            
        } catch (error) {
            console.error('❌ FlightPath: Direct automation failed, trying fallback:', error);
            // Fallback to command sequence
            return await this.sendPromptWithCommandSequence(chatPrompt);
        }
    }

    /**
     * Strategy 2: Command sequence automation (clipboard + auto-paste + submit)
     */
    private async sendPromptWithCommandSequence(chatPrompt: string): Promise<boolean> {
        try {
            console.log('🔄 FlightPath: Using command sequence automation');
            
            // Copy to clipboard
            await vscode.env.clipboard.writeText(chatPrompt);
            
            // Execute command sequence with timing
            await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
            await new Promise(resolve => setTimeout(resolve, 800));
            
            await vscode.commands.executeCommand('editor.action.selectAll');
            await new Promise(resolve => setTimeout(resolve, 200));
            
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            await new Promise(resolve => setTimeout(resolve, 400));
            
            await vscode.commands.executeCommand('workbench.action.chat.submit');
            
            console.log('✅ FlightPath: Prompt sent via command sequence');
            await this.updateWorkflowProgress();
            
            return true;
            
        } catch (error) {
            console.error('❌ FlightPath: Command sequence failed, using enhanced clipboard:', error);
            // Fallback to enhanced clipboard
            return await this.sendPromptWithEnhancedClipboard(chatPrompt);
        }
    }

    /**
     * Strategy 3: Enhanced clipboard automation (manual paste required)
     */
    private async sendPromptWithEnhancedClipboard(chatPrompt: string, prompt?: PromptItem): Promise<boolean> {
        try {
            console.log('📋 FlightPath: Using enhanced clipboard strategy');
            
            // Copy to clipboard
            await vscode.env.clipboard.writeText(chatPrompt);
            
            // Open Copilot Chat
            await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
            
            // Show helpful notification with progress
            const progressText = this.totalSteps > 0 
                ? ` (Step ${this.workflowStep}/${this.totalSteps})`
                : '';
            
            const action = await vscode.window.showInformationMessage(
                `FlightPath${progressText}: Prompt ready! Paste (Ctrl+V) and press Enter to continue.`,
                { modal: false },
                'Continue',
                'Preview Prompt',
                'Pause Workflow'
            );
            
            if (action === 'Preview Prompt') {
                await this.showPromptPreview(chatPrompt);
                // Re-show the notification after preview
                return await this.sendPromptWithEnhancedClipboard(chatPrompt, prompt);
            } else if (action === 'Pause Workflow') {
                vscode.window.showInformationMessage('FlightPath: Workflow paused. Use "Resume" command to continue.');
                return false;
            }
            
            return true;
            
        } catch (error) {
            console.error('FlightPath: Enhanced clipboard strategy failed:', error);
            return false;
        }
    }

    /**
     * Handle unavailable automation (last resort)
     */
    private async handleUnavailableAutomation(chatPrompt: string): Promise<boolean> {
        const action = await vscode.window.showWarningMessage(
            'FlightPath: Copilot Chat automation unavailable. Manual execution required.',
            'Copy Prompt',
            'Show Prompt',
            'Cancel'
        );
        
        if (action === 'Copy Prompt') {
            await vscode.env.clipboard.writeText(chatPrompt);
            vscode.window.showInformationMessage('Prompt copied to clipboard');
            return true;
        } else if (action === 'Show Prompt') {
            await this.showPromptPreview(chatPrompt);
            return true;
        }
        
        return false;
    }

    /**
     * Build prompt with Copilot Chat syntax and context
     * Uses native Copilot Chat variables (@workspace, #file, #selection)
     */
    private async buildCopilotChatPrompt(prompt: PromptItem): Promise<string> {
        let chatPrompt = '';
        const contextParts: string[] = [];
        
        try {
            // Add workspace context using Copilot Chat variables
            if (prompt.context?.includeWorkspaceFiles && prompt.context.includeWorkspaceFiles.length > 0) {
                chatPrompt += '@workspace ';
                
                // Also add specific file patterns as context
                for (const pattern of prompt.context.includeWorkspaceFiles) {
                    const files = await vscode.workspace.findFiles(pattern, null, 5);
                    for (const file of files) {
                        const fileName = vscode.workspace.asRelativePath(file);
                        chatPrompt += `#file:${fileName} `;
                    }
                }
            }
            
            // Add current file reference
            if (prompt.context?.includeCurrentFile) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    const fileName = vscode.workspace.asRelativePath(activeEditor.document.uri);
                    chatPrompt += `#file:${fileName} `;
                }
            }
            
            // Add selection context
            if (prompt.context?.includeSelection) {
                chatPrompt += '#selection ';
            }
            
            // Detect and apply slash commands based on prompt content
            const promptLower = prompt.prompt.toLowerCase();
            let slashCommand = '';
            
            if (promptLower.includes('fix') || promptLower.includes('error') || promptLower.includes('bug')) {
                slashCommand = '/fix ';
            } else if (promptLower.includes('explain') || promptLower.includes('what does')) {
                slashCommand = '/explain ';
            } else if (promptLower.includes('create') || promptLower.includes('generate') || promptLower.includes('new')) {
                slashCommand = '/new ';
            } else if (promptLower.includes('test')) {
                slashCommand = '/tests ';
            }
            
            // Combine: [slash command] [context variables] [prompt text]
            chatPrompt = slashCommand + chatPrompt + prompt.prompt;
            
        } catch (error) {
            console.error('FlightPath: Error building Copilot Chat prompt:', error);
            // Fallback to simple prompt
            chatPrompt = prompt.prompt;
        }
        
        return chatPrompt.trim();
    }

    /**
     * Legacy method for backward compatibility
     * @deprecated Use buildCopilotChatPrompt instead
     */
    private async buildPromptWithContext(prompt: PromptItem): Promise<string> {
        return await this.buildCopilotChatPrompt(prompt);
    }

    /**
     * Update workflow progress tracking
     */
    private async updateWorkflowProgress(): Promise<void> {
        if (this.totalSteps > 0) {
            const progress = `${this.workflowStep}/${this.totalSteps}`;
            vscode.window.setStatusBarMessage(
                `$(rocket) FlightPath: Step ${progress} completed`,
                3000
            );
        }
    }

    /**
     * Show prompt preview in a document
     */
    private async showPromptPreview(prompt: string): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument({
                content: `# FlightPath Generated Copilot Chat Prompt\n\n${prompt}\n\n---\n\n*Copy this prompt and paste it into Copilot Chat*`,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } catch (error) {
            console.error('FlightPath: Failed to show prompt preview:', error);
        }
    }

    /**
     * Set workflow progress tracking (called by PromptQueue)
     */
    setWorkflowProgress(currentStep: number, totalSteps: number): void {
        this.workflowStep = currentStep;
        this.totalSteps = totalSteps;
    }



    /**
     * Check if Copilot integration is available
     */
    isIntegrationAvailable(): boolean {
        return this.isAvailable || this.availableStrategy !== AutomationStrategy.Unavailable;
    }

    /**
     * Get integration status with automation strategy details
     */
    getStatus(): { available: boolean; message: string; strategy: string } {
        let message = '';
        let available = false;
        
        switch (this.availableStrategy) {
            case AutomationStrategy.DirectTextInsertion:
                available = true;
                message = '✅ Zero-interaction automation available (Direct text insertion)';
                break;
            case AutomationStrategy.CommandSequence:
                available = true;
                message = '✅ Automated workflow available (Command sequence)';
                break;
            case AutomationStrategy.EnhancedClipboard:
                available = true;
                message = '⚠️ Semi-automated (Manual paste required)';
                break;
            case AutomationStrategy.Unavailable:
            default:
                available = false;
                message = '❌ No automation available - manual execution required';
                break;
        }
        
        return {
            available,
            message,
            strategy: this.availableStrategy
        };
    }

    /**
     * Refresh Copilot availability check and re-detect automation strategy
     */
    async refresh(): Promise<void> {
        await this.checkCopilotAvailability();
        await this.detectBestAutomationStrategy();
    }

    /**
     * Get the current automation strategy
     */
    getAutomationStrategy(): AutomationStrategy {
        return this.availableStrategy;
    }

    /**
     * Test automation capability (diagnostic tool)
     */
    async testAutomation(): Promise<boolean> {
        const testMessage = "FlightPath automation test. Please acknowledge.";
        
        try {
            const result = await this.sendPromptWithDirectAutomation(testMessage);
            
            if (result) {
                vscode.window.showInformationMessage(
                    '✅ FlightPath: Automation test successful! Check Copilot Chat for test message.'
                );
            }
            
            return result;
        } catch (error) {
            vscode.window.showErrorMessage(
                `❌ FlightPath: Automation test failed: ${error}`
            );
            return false;
        }
    }

    /**
     * Execute prompt with enhanced context awareness and automation
     */
    async executePromptWithContext(prompt: PromptItem): Promise<{
        success: boolean;
        message: string;
        requiresManualExecution?: boolean;
        strategy?: string;
    }> {
        try {
            const success = await this.sendPrompt(prompt);
            
            if (success) {
                const strategyName = this.getAutomationStrategyName();
                return {
                    success: true,
                    message: `Prompt sent successfully using ${strategyName}`,
                    requiresManualExecution: this.availableStrategy === AutomationStrategy.EnhancedClipboard,
                    strategy: this.availableStrategy
                };
            } else {
                return {
                    success: false,
                    message: 'Failed to send prompt to Copilot',
                    requiresManualExecution: true
                };
            }
        } catch (error) {
            return {
                success: false,
                message: `Copilot integration error: ${error}`,
                requiresManualExecution: true
            };
        }
    }

    /**
     * Get human-readable automation strategy name
     */
    private getAutomationStrategyName(): string {
        switch (this.availableStrategy) {
            case AutomationStrategy.DirectTextInsertion:
                return 'zero-interaction automation';
            case AutomationStrategy.CommandSequence:
                return 'command sequence automation';
            case AutomationStrategy.EnhancedClipboard:
                return 'clipboard automation';
            default:
                return 'manual execution';
        }
    }

    /**
     * Check if current strategy supports zero-interaction workflows
     */
    isZeroInteractionSupported(): boolean {
        return this.availableStrategy === AutomationStrategy.DirectTextInsertion ||
               this.availableStrategy === AutomationStrategy.CommandSequence;
    }

    /**
     * Get detailed capability information
     */
    getCapabilities(): {
        hasDirectAutomation: boolean;
        hasCommandSequence: boolean;
        hasClipboardFallback: boolean;
        supportsZeroInteraction: boolean;
        currentStrategy: string;
    } {
        return {
            hasDirectAutomation: this.availableStrategy === AutomationStrategy.DirectTextInsertion,
            hasCommandSequence: this.availableStrategy === AutomationStrategy.CommandSequence ||
                               this.availableStrategy === AutomationStrategy.DirectTextInsertion,
            hasClipboardFallback: this.availableStrategy !== AutomationStrategy.Unavailable,
            supportsZeroInteraction: this.isZeroInteractionSupported(),
            currentStrategy: this.availableStrategy
        };
    }
}