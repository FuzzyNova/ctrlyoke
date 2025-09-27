import * as vscode from 'vscode';
import { FlightPathManager } from './flightpath/FlightPathManager';

let flightPathManager: FlightPathManager;

/**
 * Test Copilot Chat automation feasibility
 */
async function testCopilotAutomation(): Promise<boolean> {
    const testMessage = "Hello Copilot! This is an automated test message from FlightPath. Please respond with 'Test received' if you can see this.";
    
    try {
        console.log('🚀 FlightPath: Starting Copilot automation test...');
        
        // Show initial message
        await vscode.window.showInformationMessage(
            'FlightPath Test: Starting automation test. Watch the Copilot Chat panel!'
        );
        
        // Step 1: Focus Copilot Chat
        console.log('📋 Step 1: Focusing Copilot Chat panel...');
        await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for focus
        
        // Step 2: Clear any existing text
        console.log('🧹 Step 2: Clearing existing input...');
        await vscode.commands.executeCommand('editor.action.selectAll');
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Step 3: Type the test message
        console.log('⌨️ Step 3: Typing test message...');
        await vscode.commands.executeCommand('type', { text: testMessage });
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Step 4: Submit the message
        console.log('📤 Step 4: Submitting message...');
        await vscode.commands.executeCommand('workbench.action.chat.submit');
        
        // Success!
        console.log('✅ FlightPath: Automation test completed successfully!');
        
        const response = await vscode.window.showInformationMessage(
            '🎉 FlightPath: Automation test completed! Check Copilot Chat for the test message. Did it work?',
            'Yes, it worked!',
            'No, it failed',
            'Run again'
        );
        
        if (response === 'Run again') {
            // Re-run the test
            return await testCopilotAutomation();
        } else if (response === 'Yes, it worked!') {
            vscode.window.showInformationMessage(
                '🎉 Excellent! FlightPath Copilot automation is feasible. The full implementation can proceed.'
            );
            return true;
        } else {
            vscode.window.showWarningMessage(
                '⚠️ Test may have failed. Check VS Code logs and ensure Copilot Chat is available.'
            );
            return false;
        }
        
    } catch (error) {
        console.error('❌ FlightPath: Automation test failed:', error);
        
        await vscode.window.showErrorMessage(
            `FlightPath Test Failed: ${error}. This may indicate automation won't work in this VS Code version.`,
            'View Error Details'
        ).then(selection => {
            if (selection === 'View Error Details') {
                console.error('Full error details:', error);
            }
        });
        
        return false;
    }
}

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

    // Test Copilot Automation command - feasibility test
    const testCopilotCommand = vscode.commands.registerCommand('flightpath.test.copilotAutomation', async () => {
        await testCopilotAutomation();
    });

    // Add all commands to subscriptions
    context.subscriptions.push(
        takeOffCommand,
        openPanelCommand,
        createPromptFileCommand,
        pauseCommand,
        resumeCommand,
        stopCommand,
        debugStateCommand,
        testCopilotCommand
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
