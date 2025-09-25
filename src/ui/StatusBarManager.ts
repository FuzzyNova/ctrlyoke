import * as vscode from 'vscode';
import { QueueState } from '../types/FlightPathTypes';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'flightpath.openPanel';
        this.updateStatusBar();
        context.subscriptions.push(this.statusBarItem);
    }

    /**
     * Update status bar based on queue state
     */
    updateStatusBar(state?: QueueState): void {
        let text = '$(rocket) FlightPath';
        let tooltip = 'FlightPath - Click to open';
        let backgroundColor: vscode.ThemeColor | undefined;

        if (state) {
            const progress = this.calculateProgress(state);
            
            switch (state.status) {
                case 'running':
                    text = `$(loading~spin) FlightPath ${progress.current}/${progress.total}`;
                    tooltip = `FlightPath - Running (${progress.percentage}% complete)`;
                    backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    break;
                    
                case 'paused':
                    text = `$(debug-pause) FlightPath ${progress.current}/${progress.total}`;
                    tooltip = 'FlightPath - Paused (click to resume)';
                    backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    break;
                    
                case 'completed':
                    text = `$(check) FlightPath Complete`;
                    tooltip = 'FlightPath - Workflow completed successfully';
                    backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    
                    // Auto-hide success message after 5 seconds
                    setTimeout(() => {
                        this.updateStatusBar();
                    }, 5000);
                    break;
                    
                case 'error':
                    text = `$(error) FlightPath Error`;
                    tooltip = 'FlightPath - Execution failed (click for details)';
                    backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    break;
                    
                case 'idle':
                default:
                    // Use default values set above
                    break;
            }
        }

        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.backgroundColor = backgroundColor;
        this.statusBarItem.show();
    }

    /**
     * Show progress in status bar
     */
    showProgress(message: string, progress?: { current: number; total: number }): void {
        let text = `$(loading~spin) ${message}`;
        
        if (progress && progress.total > 0) {
            const percentage = Math.round((progress.current / progress.total) * 100);
            text = `$(loading~spin) ${message} (${percentage}%)`;
        }
        
        this.statusBarItem.text = text;
        this.statusBarItem.show();
    }

    /**
     * Show success message
     */
    showSuccess(message: string, duration: number = 3000): void {
        const originalText = this.statusBarItem.text;
        const originalTooltip = this.statusBarItem.tooltip;
        const originalBackground = this.statusBarItem.backgroundColor;
        
        this.statusBarItem.text = `$(check) ${message}`;
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        
        setTimeout(() => {
            this.statusBarItem.text = originalText;
            this.statusBarItem.tooltip = originalTooltip;
            this.statusBarItem.backgroundColor = originalBackground;
        }, duration);
    }

    /**
     * Show error message
     */
    showError(message: string, duration: number = 5000): void {
        const originalText = this.statusBarItem.text;
        const originalTooltip = this.statusBarItem.tooltip;
        const originalBackground = this.statusBarItem.backgroundColor;
        
        this.statusBarItem.text = `$(error) ${message}`;
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        
        setTimeout(() => {
            this.statusBarItem.text = originalText;
            this.statusBarItem.tooltip = originalTooltip;
            this.statusBarItem.backgroundColor = originalBackground;
        }, duration);
    }

    /**
     * Show warning message
     */
    showWarning(message: string, duration: number = 4000): void {
        const originalText = this.statusBarItem.text;
        const originalTooltip = this.statusBarItem.tooltip;
        const originalBackground = this.statusBarItem.backgroundColor;
        
        this.statusBarItem.text = `$(warning) ${message}`;
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        
        setTimeout(() => {
            this.statusBarItem.text = originalText;
            this.statusBarItem.tooltip = originalTooltip;
            this.statusBarItem.backgroundColor = originalBackground;
        }, duration);
    }

    /**
     * Hide status bar item
     */
    hide(): void {
        this.statusBarItem.hide();
    }

    /**
     * Show status bar item
     */
    show(): void {
        this.statusBarItem.show();
    }

    /**
     * Calculate progress from queue state
     */
    private calculateProgress(state: QueueState): { current: number; total: number; percentage: number } {
        const total = state.prompts.length;
        const current = state.currentIndex;
        const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
        
        return { current, total, percentage };
    }

    /**
     * Update command associated with the status bar item
     */
    updateCommand(command: string): void {
        this.statusBarItem.command = command;
    }

    /**
     * Get current status bar text
     */
    getText(): string {
        return this.statusBarItem.text;
    }

    /**
     * Set custom status bar content
     */
    setCustomStatus(text: string, tooltip?: string, command?: string, backgroundColor?: vscode.ThemeColor): void {
        this.statusBarItem.text = text;
        if (tooltip) {
            this.statusBarItem.tooltip = tooltip;
        }
        if (command) {
            this.statusBarItem.command = command;
        }
        if (backgroundColor) {
            this.statusBarItem.backgroundColor = backgroundColor;
        }
        this.statusBarItem.show();
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.statusBarItem.dispose();
    }
}