import * as vscode from 'vscode';
import { FlightPathManager } from './flightpath/FlightPathManager';

let flightPathManager: FlightPathManager;

export async function activate(context: vscode.ExtensionContext) {
    console.log('FlightPath: Extension activating...');

    try {
        // Initialize FlightPath manager
        flightPathManager = new FlightPathManager(context);
        await flightPathManager.initialize();

        // Register commands
        registerCommands(context);

        console.log('FlightPath: Extension activated successfully!');
        vscode.window.showInformationMessage('FlightPath is ready for takeoff! 🚀');

    } catch (error) {
        console.error('FlightPath: Failed to activate extension:', error);
        vscode.window.showErrorMessage(`FlightPath: Activation failed: ${error}`);
    }
}

function registerCommands(context: vscode.ExtensionContext) {
    // Take Off command - main execution command
    const takeOffCommand = vscode.commands.registerCommand('flightpath.takeOff', async () => {
        await flightPathManager.takeOff();
    });

    // Open Panel command
    const openPanelCommand = vscode.commands.registerCommand('flightpath.openPanel', async () => {
        await flightPathManager.openPanel();
    });

    // Create Prompt File command
    const createPromptFileCommand = vscode.commands.registerCommand('flightpath.createPromptFile', async () => {
        await flightPathManager.createPromptFile();
    });

    // Pause execution command
    const pauseCommand = vscode.commands.registerCommand('flightpath.pause', () => {
        flightPathManager.pause();
    });

    // Resume execution command
    const resumeCommand = vscode.commands.registerCommand('flightpath.resume', async () => {
        await flightPathManager.resume();
    });

    // Stop execution command
    const stopCommand = vscode.commands.registerCommand('flightpath.stop', () => {
        flightPathManager.stop();
    });

    // Debug command to show current state
    const debugStateCommand = vscode.commands.registerCommand('flightpath.debugState', () => {
        const state = flightPathManager.getQueueState();
        const stateInfo = `FlightPath Debug State:
                            Status: ${state.status}
                            Current Index: ${state.currentIndex}
                            Total Prompts: ${state.prompts.length}
                            Results: ${state.results.length}`;
        
        vscode.window.showInformationMessage(stateInfo, { modal: true });
    });

    // Add all commands to subscriptions
    context.subscriptions.push(
        takeOffCommand,
        openPanelCommand,
        createPromptFileCommand,
        pauseCommand,
        resumeCommand,
        stopCommand,
        debugStateCommand
    );

    console.log('FlightPath: Commands registered successfully');
}

export function deactivate() {
    console.log('FlightPath: Extension deactivating...');
    
    if (flightPathManager) {
        flightPathManager.dispose();
    }
    
    console.log('FlightPath: Extension deactivated');
}
