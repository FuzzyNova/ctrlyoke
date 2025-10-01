import * as vscode from 'vscode';
import { PromptItem, ContextConfig } from '../types/FlightPathTypes';

/**
 * GitHub Copilot Chat Integration with Direct Automation
 * 
 * Implements PROVEN zero-interaction automation for Copilot Chat using:
 * - Direct text insertion (validated in POC at extension.ts:testCopilotAutomation)
 * - Proven timing delays: 1000ms (focus), 300ms (clear), 500ms (type)
 * 
 * Fallback: If direct automation is unavailable, reports error clearly to user
 */
export class CopilotIntegration {
    private context: vscode.ExtensionContext;
    private isAvailable: boolean = false;
    private workflowStep: number = 0;
    private totalSteps: number = 0;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.initialize();
    }

    /**
     * Initialize Copilot integration and detect automation capability
     */
    private async initialize(): Promise<void> {
        await this.checkCopilotAvailability();
    }

    /**
     * Check if GitHub Copilot is available and automation commands are present
     */
    private async checkCopilotAvailability(): Promise<void> {
        try {
            // Check if GitHub Copilot extension is installed and active
            const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
            const copilotChatExtension = vscode.extensions.getExtension('GitHub.copilot-chat');
            
            const hasCopilot = !!(copilotExtension?.isActive || copilotChatExtension?.isActive);
            
            if (!hasCopilot) {
                console.log('❌ FlightPath: GitHub Copilot not installed or not active');
                this.isAvailable = false;
                return;
            }
            
            // Check for required automation commands (PROVEN strategy)
            const commands = await vscode.commands.getCommands();
            const hasTypeCommand = commands.includes('type');
            const hasChatSubmit = commands.includes('workbench.action.chat.submit');
            const hasChatFocus = commands.includes('workbench.panel.chat.view.copilot.focus');
            const hasSelectAll = commands.includes('editor.action.selectAll');
            
            this.isAvailable = hasTypeCommand && hasChatSubmit && hasChatFocus && hasSelectAll;
            
            if (this.isAvailable) {
                console.log('✅ FlightPath: Direct automation available (PROVEN strategy)');
            } else {
                console.log('❌ FlightPath: Required automation commands not available');
                console.log(`   - type: ${hasTypeCommand}`);
                console.log(`   - chat.submit: ${hasChatSubmit}`);
                console.log(`   - chat.focus: ${hasChatFocus}`);
                console.log(`   - selectAll: ${hasSelectAll}`);
            }
        } catch (error) {
            console.error('FlightPath: Error checking Copilot availability:', error);
            this.isAvailable = false;
        }
    }

    /**
     * Send prompt to GitHub Copilot Chat with direct automation
     * 
     * Uses PROVEN zero-interaction strategy:
     * 1. Focus chat (1000ms delay)
     * 2. Clear input (300ms delay)
     * 3. Type prompt (500ms delay)
     * 4. Submit automatically
     * 
     * If automation is unavailable, returns clear error to user
     */
    async sendPrompt(prompt: PromptItem): Promise<boolean> {
        try {
            // Check if automation is available
            if (!this.isAvailable) {
                const message = 'FlightPath: Direct automation unavailable. Required commands not found. Please ensure GitHub Copilot Chat is installed and VS Code is up to date.';
                console.error('❌ ' + message);
                vscode.window.showErrorMessage(message, 'Show Details').then(action => {
                    if (action === 'Show Details') {
                        this.showAutomationRequirements();
                    }
                });
                return false;
            }
            
            console.log('🚀 FlightPath: Sending prompt with direct automation (PROVEN strategy)');
            
            // Build prompt with Copilot Chat syntax
            const chatPrompt = await this.buildCopilotChatPrompt(prompt);
            
            // Execute direct automation
            return await this.sendPromptWithDirectAutomation(chatPrompt);
            
        } catch (error) {
            console.error('FlightPath: Failed to send prompt to Copilot:', error);
            vscode.window.showErrorMessage(`FlightPath: Failed to send prompt: ${error}`);
            return false;
        }
    }

    /**
     * Direct text insertion automation (PROVEN - zero interaction)
     * 
     * Based on validated proof-of-concept in extension.ts:testCopilotAutomation()
     * Timing delays are proven and validated - do not reduce!
     */
    private async sendPromptWithDirectAutomation(chatPrompt: string): Promise<boolean> {
        try {
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
            console.error('❌ FlightPath: Direct automation failed:', error);
            vscode.window.showErrorMessage(
                `FlightPath: Automation failed: ${error}. Check that Copilot Chat is open and responsive.`
            );
            return false;
        }
    }

    /**
     * Show detailed requirements for automation to work
     */
    private async showAutomationRequirements(): Promise<void> {
        const requirements = `# FlightPath Automation Requirements

For zero-interaction automation to work, the following are required:

## Required Extensions
- GitHub Copilot Chat (installed and activated)

## Required VS Code Commands
- \`type\` - Insert text at cursor
- \`workbench.action.chat.submit\` - Submit chat message
- \`workbench.panel.chat.view.copilot.focus\` - Focus Copilot Chat
- \`editor.action.selectAll\` - Select all text

## Troubleshooting
1. Ensure GitHub Copilot Chat extension is installed and active
2. Try reloading VS Code window (Ctrl+Shift+P → "Reload Window")
3. Update VS Code to the latest version
4. Check VS Code Output panel for detailed error messages

## Testing
Use Command Palette: "FlightPath: Test Automation" to verify setup
`;

        const doc = await vscode.workspace.openTextDocument({
            content: requirements,
            language: 'markdown'
        });
        await vscode.window.showTextDocument(doc, { preview: false });
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
        return this.isAvailable;
    }

    /**
     * Get integration status
     */
    getStatus(): { available: boolean; message: string; strategy: string } {
        if (this.isAvailable) {
            return {
                available: true,
                message: '✅ Direct automation available (PROVEN zero-interaction strategy)',
                strategy: 'direct'
            };
        } else {
            return {
                available: false,
                message: '❌ Direct automation unavailable - required commands not found',
                strategy: 'unavailable'
            };
        }
    }

    /**
     * Refresh Copilot availability check
     */
    async refresh(): Promise<void> {
        await this.checkCopilotAvailability();
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
                return {
                    success: true,
                    message: 'Prompt sent successfully using direct automation',
                    requiresManualExecution: false,
                    strategy: 'direct'
                };
            } else {
                return {
                    success: false,
                    message: 'Direct automation unavailable - required commands not found',
                    requiresManualExecution: true,
                    strategy: 'unavailable'
                };
            }
        } catch (error) {
            return {
                success: false,
                message: `Copilot integration error: ${error}`,
                requiresManualExecution: true,
                strategy: 'error'
            };
        }
    }

    /**
     * Check if zero-interaction automation is supported
     */
    isZeroInteractionSupported(): boolean {
        return this.isAvailable;
    }

    /**
     * Get detailed capability information
     */
    getCapabilities(): {
        hasDirectAutomation: boolean;
        supportsZeroInteraction: boolean;
        currentStrategy: string;
    } {
        return {
            hasDirectAutomation: this.isAvailable,
            supportsZeroInteraction: this.isAvailable,
            currentStrategy: this.isAvailable ? 'direct' : 'unavailable'
        };
    }
}