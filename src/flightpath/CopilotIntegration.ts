import * as vscode from 'vscode';
import { PromptItem, ContextConfig } from '../types/FlightPathTypes';

/**
 * GitHub Copilot Chat API Integration
 * Note: This is a stub implementation as the actual Copilot Chat API integration
 * would require access to the GitHub Copilot extension's internal APIs
 */
export class CopilotIntegration {
    private context: vscode.ExtensionContext;
    private isAvailable: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.checkCopilotAvailability();
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
                console.log('FlightPath: GitHub Copilot not available - using stub implementation');
            }
        } catch (error) {
            console.error('FlightPath: Error checking Copilot availability:', error);
            this.isAvailable = false;
        }
    }

    /**
     * Send prompt to GitHub Copilot Chat
     */
    async sendPrompt(prompt: PromptItem): Promise<boolean> {
        try {
            console.log('FlightPath: Sending prompt to Copilot (stub implementation)');
            
            if (!this.isAvailable) {
                // Fallback: show prompt in info message for manual execution
                const action = await vscode.window.showInformationMessage(
                    'FlightPath: GitHub Copilot not available. Execute manually?',
                    { modal: false },
                    'Copy Prompt',
                    'Skip'
                );
                
                if (action === 'Copy Prompt') {
                    const fullPrompt = await this.buildPromptWithContext(prompt);
                    await vscode.env.clipboard.writeText(fullPrompt);
                    vscode.window.showInformationMessage('Prompt copied to clipboard');
                    return true;
                }
                
                return false;
            }
            
            // Build prompt with context
            const fullPrompt = await this.buildPromptWithContext(prompt);
            
            // In a real implementation, this would use the Copilot Chat API
            // For now, we'll use VS Code's command to open Copilot Chat
            await this.openCopilotChatWithPrompt(fullPrompt);
            
            return true;
        } catch (error) {
            console.error('FlightPath: Failed to send prompt to Copilot:', error);
            vscode.window.showErrorMessage(`FlightPath: Failed to send prompt: ${error}`);
            return false;
        }
    }

    /**
     * Build prompt with context information
     */
    private async buildPromptWithContext(prompt: PromptItem): Promise<string> {
        let fullPrompt = prompt.prompt;
        
        if (!prompt.context) {
            return fullPrompt;
        }
        
        const context = prompt.context;
        const contextParts: string[] = [];
        
        try {
            // Include current file
            if (context.includeCurrentFile) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    const fileName = activeEditor.document.fileName;
                    const content = activeEditor.document.getText();
                    contextParts.push(`Current file (${fileName}):\n\`\`\`\n${content}\n\`\`\``);
                }
            }
            
            // Include selection
            if (context.includeSelection) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && !activeEditor.selection.isEmpty) {
                    const selectedText = activeEditor.document.getText(activeEditor.selection);
                    contextParts.push(`Selected text:\n\`\`\`\n${selectedText}\n\`\`\``);
                }
            }
            
            // Include workspace files
            if (context.includeWorkspaceFiles && context.includeWorkspaceFiles.length > 0) {
                for (const pattern of context.includeWorkspaceFiles) {
                    const files = await vscode.workspace.findFiles(pattern, null, 10); // Limit to 10 files
                    for (const file of files) {
                        try {
                            const content = await vscode.workspace.fs.readFile(file);
                            const text = content.toString();
                            const fileName = vscode.workspace.asRelativePath(file);
                            contextParts.push(`File (${fileName}):\n\`\`\`\n${text}\n\`\`\``);
                        } catch (fileError) {
                            console.warn(`FlightPath: Could not read file ${file.fsPath}:`, fileError);
                        }
                    }
                }
            }
            
            // Combine context with prompt
            if (contextParts.length > 0) {
                fullPrompt = `Context Information:\n\n${contextParts.join('\n\n')}\n\n---\n\nPrompt: ${prompt.prompt}`;
            }
            
        } catch (error) {
            console.error('FlightPath: Error building context:', error);
            // Return original prompt if context building fails
        }
        
        return fullPrompt;
    }

    /**
     * Open Copilot Chat with prompt (stub implementation)
     */
    private async openCopilotChatWithPrompt(prompt: string): Promise<void> {
        try {
            // Try to use Copilot Chat command if available
            const commands = await vscode.commands.getCommands();
            
            if (commands.includes('github.copilot.interactiveEditor.explain')) {
                // Use interactive editor command
                await vscode.commands.executeCommand('github.copilot.interactiveEditor.explain');
            } else if (commands.includes('github.copilot-chat.openChatEditor')) {
                // Use chat editor command
                await vscode.commands.executeCommand('github.copilot-chat.openChatEditor');
            } else {
                // Fallback: copy to clipboard and show instruction
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage(
                    'FlightPath: Prompt copied to clipboard. Please paste it into GitHub Copilot Chat manually.',
                    'Open Copilot Chat'
                ).then(action => {
                    if (action === 'Open Copilot Chat') {
                        vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
                    }
                });
            }
        } catch (error) {
            console.error('FlightPath: Error opening Copilot Chat:', error);
            
            // Final fallback: show prompt in information message
            const action = await vscode.window.showInformationMessage(
                'FlightPath: Unable to open Copilot Chat automatically. Prompt ready:',
                'Copy Prompt',
                'Show Prompt'
            );
            
            if (action === 'Copy Prompt') {
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('Prompt copied to clipboard');
            } else if (action === 'Show Prompt') {
                // Create a new untitled document with the prompt
                const doc = await vscode.workspace.openTextDocument({
                    content: `FlightPath Generated Prompt:\n\n${prompt}`,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc);
            }
        }
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
    getStatus(): { available: boolean; message: string } {
        if (this.isAvailable) {
            return {
                available: true,
                message: 'GitHub Copilot integration active'
            };
        } else {
            return {
                available: false,
                message: 'GitHub Copilot not available - manual execution required'
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
     * Execute prompt with enhanced context awareness
     */
    async executePromptWithContext(prompt: PromptItem): Promise<{
        success: boolean;
        message: string;
        requiresManualExecution?: boolean;
    }> {
        try {
            const success = await this.sendPrompt(prompt);
            
            if (success) {
                return {
                    success: true,
                    message: this.isAvailable ? 
                        'Prompt sent to GitHub Copilot successfully' :
                        'Prompt prepared for manual execution'
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
}