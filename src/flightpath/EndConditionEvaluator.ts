import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { EndCondition } from '../types/FlightPathTypes';

export interface EvaluationResult {
    success: boolean;
    result: string;
    error?: string;
    timeout?: boolean;
    duration: number;
}

export class EndConditionEvaluator {
    private runningProcesses: Set<ChildProcess> = new Set();
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Evaluate an end condition
     */
    async evaluateCondition(condition: EndCondition, workingDirectory?: string): Promise<EvaluationResult> {
        const startTime = Date.now();
        
        try {
            console.log(`FlightPath: Evaluating end condition script: ${condition.script}`);
            
            // Resolve script path
            const scriptPath = await this.resolveScriptPath(condition.script, workingDirectory);
            if (!scriptPath) {
                return {
                    success: false,
                    result: '',
                    error: `Script not found: ${condition.script}`,
                    duration: Date.now() - startTime
                };
            }
            
            // Determine script type and command
            const command = this.getScriptCommand(scriptPath);
            if (!command) {
                return {
                    success: false,
                    result: '',
                    error: `Unsupported script type: ${path.extname(scriptPath)}`,
                    duration: Date.now() - startTime
                };
            }
            
            // Execute script with timeout
            const timeout = condition.timeout || 30000; // 30 seconds default
            const result = await this.executeScript(command.executable, command.args, workingDirectory, timeout);
            
            // Check if result matches expected value
            const success = this.checkResult(result.result, condition.returns);
            
            return {
                success: success && result.success,
                result: result.result,
                error: result.error,
                timeout: result.timeout,
                duration: Date.now() - startTime
            };
            
        } catch (error) {
            return {
                success: false,
                result: '',
                error: error instanceof Error ? error.message : String(error),
                duration: Date.now() - startTime
            };
        }
    }

    /**
     * Resolve script path relative to workspace or absolute
     */
    private async resolveScriptPath(scriptPath: string, workingDirectory?: string): Promise<string | null> {
        // Try absolute path first
        if (path.isAbsolute(scriptPath)) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(scriptPath));
                return scriptPath;
            } catch {
                return null;
            }
        }
        
        // Try relative to working directory
        if (workingDirectory) {
            const fullPath = path.resolve(workingDirectory, scriptPath);
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
                return fullPath;
            } catch {
                // Continue to workspace resolution
            }
        }
        
        // Try relative to workspace root
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const workspacePath = path.resolve(workspaceFolder.uri.fsPath, scriptPath);
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(workspacePath));
                return workspacePath;
            } catch {
                // Continue to .flightpath directory
            }
            
            // Try in .flightpath directory
            const flightpathDir = vscode.workspace.getConfiguration('flightpath').get<string>('promptsDirectory', '.flightpath');
            const flightpathPath = path.resolve(workspaceFolder.uri.fsPath, flightpathDir, scriptPath);
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(flightpathPath));
                return flightpathPath;
            } catch {
                // Script not found
            }
        }
        
        return null;
    }

    /**
     * Get command and arguments for script execution
     */
    private getScriptCommand(scriptPath: string): { executable: string; args: string[] } | null {
        const ext = path.extname(scriptPath).toLowerCase();
        
        switch (ext) {
            case '.py':
                return { executable: 'python', args: [scriptPath] };
            case '.js':
                return { executable: 'node', args: [scriptPath] };
            case '.ts':
                // Try to use ts-node if available, otherwise compile first
                return { executable: 'npx', args: ['ts-node', scriptPath] };
            case '.sh':
                return process.platform === 'win32' 
                    ? { executable: 'bash', args: [scriptPath] }
                    : { executable: 'sh', args: [scriptPath] };
            case '.bat':
            case '.cmd':
                return process.platform === 'win32'
                    ? { executable: 'cmd', args: ['/c', scriptPath] }
                    : null;
            case '.ps1':
                return process.platform === 'win32'
                    ? { executable: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] }
                    : null;
            default:
                // Try to execute directly (for executable files)
                return { executable: scriptPath, args: [] };
        }
    }

    /**
     * Execute script with timeout
     */
    private async executeScript(
        executable: string, 
        args: string[], 
        workingDirectory?: string, 
        timeout: number = 30000
    ): Promise<{ success: boolean; result: string; error?: string; timeout?: boolean }> {
        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let isResolved = false;
            
            const child = spawn(executable, args, {
                cwd: workingDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            this.runningProcesses.add(child);
            
            // Set up timeout
            const timeoutHandle = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    child.kill('SIGKILL');
                    this.runningProcesses.delete(child);
                    resolve({
                        success: false,
                        result: stdout,
                        error: 'Script execution timed out',
                        timeout: true
                    });
                }
            }, timeout);
            
            // Collect output
            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            
            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });
            
            // Handle completion
            child.on('close', (code) => {
                clearTimeout(timeoutHandle);
                this.runningProcesses.delete(child);
                
                if (!isResolved) {
                    isResolved = true;
                    resolve({
                        success: code === 0,
                        result: stdout.trim(),
                        error: stderr.trim() || undefined
                    });
                }
            });
            
            // Handle errors
            child.on('error', (error) => {
                clearTimeout(timeoutHandle);
                this.runningProcesses.delete(child);
                
                if (!isResolved) {
                    isResolved = true;
                    resolve({
                        success: false,
                        result: '',
                        error: `Failed to execute script: ${error.message}`
                    });
                }
            });
        });
    }

    /**
     * Check if script result matches expected value
     */
    private checkResult(actualResult: string, expectedResult: string): boolean {
        const actual = actualResult.trim().toLowerCase();
        const expected = expectedResult.trim().toLowerCase();
        
        // Exact match
        if (actual === expected) {
            return true;
        }
        
        // Boolean interpretation
        if (expected === 'true') {
            return actual === 'true' || actual === '1' || actual === 'yes' || actual === 'pass' || actual === 'passed';
        }
        
        if (expected === 'false') {
            return actual === 'false' || actual === '0' || actual === 'no' || actual === 'fail' || actual === 'failed';
        }
        
        // Numeric comparison
        const actualNum = parseFloat(actual);
        const expectedNum = parseFloat(expected);
        if (!isNaN(actualNum) && !isNaN(expectedNum)) {
            return actualNum >= expectedNum; // For coverage percentages, etc.
        }
        
        // String contains (for complex outputs)
        return actual.includes(expected);
    }

    /**
     * Create a sample end condition script
     */
    async createSampleScript(scriptType: 'python' | 'javascript' | 'shell', workingDirectory?: string): Promise<string | null> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder && !workingDirectory) {
            return null;
        }
        
        const baseDir = workingDirectory || workspaceFolder!.uri.fsPath;
        const flightpathDir = path.join(baseDir, '.flightpath');
        
        // Ensure .flightpath directory exists
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(flightpathDir));
        } catch {
            // Directory might already exist
        }
        
        let fileName: string;
        let content: string;
        
        switch (scriptType) {
            case 'python':
                fileName = 'check_condition.py';
                content = `#!/usr/bin/env python3
"""
FlightPath End Condition Script Example
This script checks if tests pass or some condition is met
"""
import sys
import subprocess
import os

def main():
    try:
        # Example: Run tests and check if they pass
        # result = subprocess.run(['npm', 'test'], capture_output=True, text=True)
        # if result.returncode == 0:
        #     print("true")
        #     return 0
        # else:
        #     print("false")
        #     return 1
        
        # For demo purposes, always return true
        print("true")
        return 0
        
    except Exception as e:
        print(f"Error: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
`;
                break;
                
            case 'javascript':
                fileName = 'check_condition.js';
                content = `#!/usr/bin/env node
/**
 * FlightPath End Condition Script Example
 * This script checks if tests pass or some condition is met
 */
const { spawn } = require('child_process');
const fs = require('fs');

async function main() {
    try {
        // Example: Check if a file exists
        // if (fs.existsSync('some-generated-file.txt')) {
        //     console.log('true');
        //     process.exit(0);
        // }
        
        // Example: Run tests
        // const testResult = await runCommand('npm', ['test']);
        // console.log(testResult.success ? 'true' : 'false');
        // process.exit(testResult.success ? 0 : 1);
        
        // For demo purposes, always return true
        console.log('true');
        process.exit(0);
        
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

function runCommand(command, args) {
    return new Promise((resolve) => {
        const child = spawn(command, args);
        child.on('close', (code) => {
            resolve({ success: code === 0 });
        });
    });
}

main();
`;
                break;
                
            case 'shell':
                fileName = process.platform === 'win32' ? 'check_condition.bat' : 'check_condition.sh';
                content = process.platform === 'win32' ? 
`@echo off
REM FlightPath End Condition Script Example
REM This script checks if tests pass or some condition is met

REM Example: Check if file exists
REM if exist "some-file.txt" (
REM     echo true
REM     exit 0
REM ) else (
REM     echo false
REM     exit 1
REM )

REM For demo purposes, always return true
echo true
exit 0
` : 
`#!/bin/bash
# FlightPath End Condition Script Example
# This script checks if tests pass or some condition is met

# Example: Check if file exists
# if [ -f "some-file.txt" ]; then
#     echo "true"
#     exit 0
# else
#     echo "false"
#     exit 1
# fi

# Example: Run tests
# if npm test; then
#     echo "true"
#     exit 0
# else
#     echo "false"
#     exit 1
# fi

# For demo purposes, always return true
echo "true"
exit 0
`;
                break;
        }
        
        const scriptPath = path.join(flightpathDir, fileName);
        
        try {
            await vscode.workspace.fs.writeFile(
                vscode.Uri.file(scriptPath), 
                Buffer.from(content, 'utf8')
            );
            
            // Make script executable on Unix systems
            if (process.platform !== 'win32' && scriptType === 'shell') {
                try {
                    const { spawn } = require('child_process');
                    spawn('chmod', ['+x', scriptPath]);
                } catch {
                    // Ignore chmod errors
                }
            }
            
            console.log(`FlightPath: Created sample script: ${scriptPath}`);
            return scriptPath;
        } catch (error) {
            console.error('FlightPath: Failed to create sample script:', error);
            return null;
        }
    }

    /**
     * Validate script before execution
     */
    async validateScript(scriptPath: string): Promise<{ valid: boolean; error?: string }> {
        try {
            const stats = await vscode.workspace.fs.stat(vscode.Uri.file(scriptPath));
            
            if (stats.type !== vscode.FileType.File) {
                return { valid: false, error: 'Path is not a file' };
            }
            
            const command = this.getScriptCommand(scriptPath);
            if (!command) {
                return { valid: false, error: 'Unsupported script type' };
            }
            
            return { valid: true };
        } catch (error) {
            return { 
                valid: false, 
                error: error instanceof Error ? error.message : 'File not found' 
            };
        }
    }

    /**
     * Kill all running processes
     */
    killAllProcesses(): void {
        for (const process of this.runningProcesses) {
            try {
                process.kill('SIGKILL');
            } catch {
                // Ignore errors when killing processes
            }
        }
        this.runningProcesses.clear();
        console.log('FlightPath: Killed all running end condition processes');
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        this.killAllProcesses();
        console.log('FlightPath: EndConditionEvaluator disposed');
    }
}