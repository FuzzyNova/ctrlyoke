import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as chokidar from 'chokidar';

export class FileSystemUtils {
    private watchers: Map<string, chokidar.FSWatcher> = new Map();
    private onFileChanged: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    
    // Public event for file changes
    public readonly onDidChangeFile: vscode.Event<string> = this.onFileChanged.event;

    /**
     * Ensure directory exists, create if needed
     */
    async ensureDirectory(dirPath: string): Promise<void> {
        try {
            await fs.access(dirPath);
        } catch {
            await fs.mkdir(dirPath, { recursive: true });
            console.log(`FlightPath: Created directory ${dirPath}`);
        }
    }

    /**
     * Read file safely with error handling
     */
    async readFile(filePath: string): Promise<string | null> {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            return content;
        } catch (error) {
            console.error(`FlightPath: Failed to read file ${filePath}:`, error);
            return null;
        }
    }

    /**
     * Write file safely with directory creation
     */
    async writeFile(filePath: string, content: string): Promise<boolean> {
        try {
            const dir = path.dirname(filePath);
            await this.ensureDirectory(dir);
            await fs.writeFile(filePath, content, 'utf8');
            console.log(`FlightPath: Wrote file ${filePath}`);
            return true;
        } catch (error) {
            console.error(`FlightPath: Failed to write file ${filePath}:`, error);
            return false;
        }
    }

    /**
     * Check if file exists
     */
    async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Find files matching pattern recursively
     */
    async findFiles(rootDir: string, pattern: RegExp, maxDepth: number = 10): Promise<string[]> {
        const files: string[] = [];
        
        try {
            await this.findFilesRecursive(rootDir, pattern, files, 0, maxDepth);
        } catch (error) {
            console.error(`FlightPath: Error finding files in ${rootDir}:`, error);
        }
        
        return files;
    }

    /**
     * Recursive file finder helper
     */
    private async findFilesRecursive(
        dir: string, 
        pattern: RegExp, 
        files: string[], 
        currentDepth: number, 
        maxDepth: number
    ): Promise<void> {
        if (currentDepth >= maxDepth) {
            return;
        }
        
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    // Skip common directories that should be ignored
                    if (!this.shouldIgnoreDirectory(entry.name)) {
                        await this.findFilesRecursive(fullPath, pattern, files, currentDepth + 1, maxDepth);
                    }
                } else if (entry.isFile() && pattern.test(entry.name)) {
                    files.push(fullPath);
                }
            }
        } catch (error) {
            // Directory might not be accessible, skip silently
        }
    }

    /**
     * Check if directory should be ignored
     */
    private shouldIgnoreDirectory(dirName: string): boolean {
        const ignoredDirs = [
            'node_modules',
            '.git',
            '.vscode-test',
            'out',
            'dist',
            'build',
            '.nyc_output',
            'coverage'
        ];
        return ignoredDirs.includes(dirName) || dirName.startsWith('.');
    }

    /**
     * Watch directory for changes
     */
    watchDirectory(dirPath: string, options: {
        pattern?: string;
        ignoreInitial?: boolean;
        recursive?: boolean;
    } = {}): string {
        const watchId = `${dirPath}-${Date.now()}`;
        
        try {
            const watchPattern = options.pattern ? path.join(dirPath, options.pattern) : dirPath;
            
            const watcher = chokidar.watch(watchPattern, {
                ignored: /(^|[\/\\])\../, // ignore dotfiles
                persistent: true,
                ignoreInitial: options.ignoreInitial !== false,
                depth: options.recursive !== false ? undefined : 0
            });
            
            watcher
                .on('add', (filePath) => {
                    console.log(`FlightPath: File added: ${filePath}`);
                    this.onFileChanged.fire(filePath);
                })
                .on('change', (filePath) => {
                    console.log(`FlightPath: File changed: ${filePath}`);
                    this.onFileChanged.fire(filePath);
                })
                .on('unlink', (filePath) => {
                    console.log(`FlightPath: File removed: ${filePath}`);
                    this.onFileChanged.fire(filePath);
                })
                .on('error', (error) => {
                    console.error(`FlightPath: Watcher error for ${dirPath}:`, error);
                });
            
            this.watchers.set(watchId, watcher);
            console.log(`FlightPath: Started watching ${dirPath} with ID ${watchId}`);
            
        } catch (error) {
            console.error(`FlightPath: Failed to start watching ${dirPath}:`, error);
        }
        
        return watchId;
    }

    /**
     * Stop watching directory
     */
    stopWatching(watchId: string): void {
        const watcher = this.watchers.get(watchId);
        if (watcher) {
            watcher.close();
            this.watchers.delete(watchId);
            console.log(`FlightPath: Stopped watching ${watchId}`);
        }
    }

    /**
     * Stop all watchers
     */
    stopAllWatchers(): void {
        for (const [watchId, watcher] of this.watchers) {
            watcher.close();
            console.log(`FlightPath: Stopped watching ${watchId}`);
        }
        this.watchers.clear();
    }

    /**
     * Get file statistics
     */
    async getFileStats(filePath: string): Promise<{
        size: number;
        modified: Date;
        created: Date;
        isFile: boolean;
        isDirectory: boolean;
    } | null> {
        try {
            const stats = await fs.stat(filePath);
            return {
                size: stats.size,
                modified: stats.mtime,
                created: stats.birthtime,
                isFile: stats.isFile(),
                isDirectory: stats.isDirectory()
            };
        } catch (error) {
            console.error(`FlightPath: Failed to get stats for ${filePath}:`, error);
            return null;
        }
    }

    /**
     * Create backup of file
     */
    async createBackup(filePath: string, backupSuffix: string = '.backup'): Promise<string | null> {
        try {
            const backupPath = `${filePath}${backupSuffix}`;
            const content = await fs.readFile(filePath);
            await fs.writeFile(backupPath, content);
            
            console.log(`FlightPath: Created backup ${backupPath}`);
            return backupPath;
        } catch (error) {
            console.error(`FlightPath: Failed to create backup of ${filePath}:`, error);
            return null;
        }
    }

    /**
     * Get workspace-relative path
     */
    getWorkspaceRelativePath(filePath: string): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }
        
        try {
            return path.relative(workspaceFolder.uri.fsPath, filePath);
        } catch {
            return null;
        }
    }

    /**
     * Resolve path relative to workspace
     */
    resolveWorkspacePath(relativePath: string): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }
        
        return path.resolve(workspaceFolder.uri.fsPath, relativePath);
    }

    /**
     * Get directory contents with metadata
     */
    async getDirectoryContents(dirPath: string): Promise<{
        files: Array<{
            name: string;
            path: string;
            isDirectory: boolean;
            size?: number;
            modified?: Date;
        }>;
        error?: string;
    }> {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            const files: Array<{
                name: string;
                path: string;
                isDirectory: boolean;
                size?: number;
                modified?: Date;
            }> = [];
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                const item = {
                    name: entry.name,
                    path: fullPath,
                    isDirectory: entry.isDirectory()
                };
                
                if (!entry.isDirectory()) {
                    try {
                        const stats = await fs.stat(fullPath);
                        Object.assign(item, {
                            size: stats.size,
                            modified: stats.mtime
                        });
                    } catch {
                        // Ignore stat errors for individual files
                    }
                }
                
                files.push(item);
            }
            
            return { files };
        } catch (error) {
            return {
                files: [],
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Dispose of all resources
     */
    dispose(): void {
        this.stopAllWatchers();
        this.onFileChanged.dispose();
        console.log('FlightPath: FileSystemUtils disposed');
    }
}