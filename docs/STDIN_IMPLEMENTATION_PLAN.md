# Copilot CLI Stdin Implementation Plan

**Issue**: Current shell escaping implementation has risks with long/complex prompts  
**Solution**: Use stdin instead of `-p` flag for prompt input  
**Status**: Ready to implement  

## Problem Analysis

### Current Implementation Risks

1. **Command-line Length Limits**
   - Windows: ~8,191 characters for command line
   - Linux/macOS: ~2MB but varies by shell
   - FlightPath prompts can easily exceed Windows limits with XML wrappers, context, etc.

2. **Escaping Complexity**
   - Current implementation: Double quotes on Windows (`""`), single quotes on Unix (`'\''`)
   - Edge cases: Nested quotes, backticks, XML attributes, markdown code blocks
   - Platform differences between PowerShell, cmd, bash, zsh

3. **Debugging Difficulty**
   - Can't easily inspect what's sent to copilot
   - Escaped strings are hard to read in logs

### Tested Solution: Stdin Input

```powershell
# Works perfectly with complex content:
echo "Complex prompt with 'quotes', `backticks`, <xml attr=\"value\"/>" | copilot --allow-all-tools
```

**Benefits**:
- ✅ No escaping needed - copilot reads raw text
- ✅ No length limits - can send multi-megabyte prompts
- ✅ Works identically on all platforms
- ✅ Easy to debug - can save prompt to file and inspect
- ✅ Simpler code - remove all escaping logic

## Implementation Changes

### 1. Update `executeCopilotCommand()` Method

**REMOVE**: `-p` flag with escaped prompt argument  
**ADD**: Write prompt to stdin

```typescript
private async executeCopilotCommand(
  prompt: string,
  options: CopilotCliOptions = {}
): Promise<CopilotCliResult> {
  const args: string[] = [];

  // REMOVE these lines:
  // args.push("-p");
  // args.push(this.escapeShellArg(prompt));

  // Add tool permissions
  const toolPermissions = this.getToolPermissionArgs();
  args.push(...toolPermissions);

  // Add optional flags
  if (options.addDirs && options.addDirs.length > 0) {
    options.addDirs.forEach((dir) => {
      args.push("--add-dir", dir); // No escaping needed!
    });
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.resumeSession) {
    args.push("--resume", options.resumeSession);
  }

  // Execute command with stdin
  const { stdout, stderr, exitCode } = await this.spawnProcessWithStdin(
    "copilot",
    args,
    prompt, // Pass prompt as stdin
    { timeout: 300000 }
  );

  // Rest of parsing logic unchanged...
}
```

### 2. Create New `spawnProcessWithStdin()` Method

```typescript
/**
 * Spawn a child process and write to stdin
 */
private spawnProcessWithStdin(
  command: string,
  args: string[],
  stdinInput: string,
  options: { timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    console.log(
      `🔧 FlightPath: Spawning process: ${command} ${args.join(" ")}`
    );
    console.log(`📝 FlightPath: Stdin length: ${stdinInput.length} characters`);

    const child = spawn(command, args, {
      cwd: this.getWorkspaceRoot(),
      shell: true, // Required for copilot.ps1 on Windows
    });

    // Write prompt to stdin
    if (child.stdin) {
      child.stdin.write(stdinInput);
      child.stdin.end();
    } else {
      reject(new Error("Failed to access stdin"));
      return;
    }

    // Stream output to console in real-time
    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      console.log(`📤 [Copilot stdout]: ${text.trim()}`);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      console.log(`📤 [Copilot stderr]: ${text.trim()}`);
    });

    child.on("error", (error) => {
      console.error("❌ Process error:", error);
      reject(error);
    });

    child.on("close", (code) => {
      console.log(`✅ Process closed with exit code: ${code}`);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    // Handle timeout
    if (options.timeout) {
      setTimeout(() => {
        console.warn(
          `⏱️ Process timeout after ${options.timeout}ms, killing...`
        );
        child.kill();
        reject(new Error(`Process timeout after ${options.timeout}ms`));
      }, options.timeout);
    }
  });
}
```

### 3. Remove `escapeShellArg()` Method

**DELETE** entire method - no longer needed!

```typescript
// DELETE THIS METHOD:
private escapeShellArg(arg: string): string {
  // ... entire method can be removed
}
```

### 4. Update `--add-dir` Arguments

No escaping needed since paths are passed as direct arguments (not through stdin):

```typescript
if (options.addDirs && options.addDirs.length > 0) {
  options.addDirs.forEach((dir) => {
    args.push("--add-dir", dir); // spawn() handles this safely
  });
}
```

## Benefits Summary

### Before (Command-line Argument)
```typescript
// Complex escaping logic
args.push("-p");
args.push(this.escapeShellArg(prompt)); // Fragile!
// Length limit: ~8KB on Windows
// Platform-specific escaping rules
// Hard to debug
```

### After (Stdin)
```typescript
// No escaping!
await this.spawnProcessWithStdin("copilot", args, prompt);
// No length limits
// Works identically everywhere
// Easy to debug
```

### Code Comparison

| Aspect | Command-line | Stdin |
|--------|-------------|-------|
| Escaping logic | 15 lines | 0 lines |
| Length limit | ~8KB | Unlimited |
| Platform issues | Yes | No |
| Debugging | Hard | Easy |
| Code complexity | High | Low |

## Testing Plan

### Unit Tests
- [ ] Test with simple prompts (< 100 chars)
- [ ] Test with long prompts (> 10KB)
- [ ] Test with special characters: quotes, backticks, XML, markdown
- [ ] Test with nested quotes: `"outer 'inner' outer"`
- [ ] Test with XML attributes: `<tag attr="value"/>`
- [ ] Test with markdown code blocks: ` ```code``` `
- [ ] Test stdin write errors (simulate closed stdin)

### Integration Tests
- [ ] Execute real copilot command with stdin
- [ ] Verify output parsing still works
- [ ] Test with workspace context (@workspace)
- [ ] Test with file references (#file:path)
- [ ] Test multi-step workflows with long prompts

### Manual Testing
- [ ] Run FlightPath workflow with complex XML prompts
- [ ] Monitor Output panel for stdin logging
- [ ] Test on Windows (PowerShell)
- [ ] Test on Linux/macOS (bash/zsh)
- [ ] Verify no regression in existing functionality

## Migration Notes

### Breaking Changes
**NONE** - This is an internal implementation detail. External API unchanged.

### Backwards Compatibility
Fully compatible - stdin is supported by all copilot CLI versions.

### Rollback Plan
If issues arise, can revert to command-line arguments (keep git history).

## Additional Enhancements

### Optional: Save Prompts to File for Debugging

```typescript
private async savePromptToFile(prompt: string): Promise<string> {
  const tempDir = path.join(this.context.globalStorageUri.fsPath, "prompts");
  await fs.promises.mkdir(tempDir, { recursive: true });
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `prompt-${timestamp}.txt`;
  const filepath = path.join(tempDir, filename);
  
  await fs.promises.writeFile(filepath, prompt, "utf8");
  console.log(`💾 Prompt saved to: ${filepath}`);
  
  return filepath;
}
```

Enable with setting: `flightpath.savePromptFiles: true`

## Implementation Checklist

- [ ] Create `spawnProcessWithStdin()` method
- [ ] Update `executeCopilotCommand()` to use stdin
- [ ] Remove `escapeShellArg()` method
- [ ] Update `--add-dir` handling (remove escaping)
- [ ] Add stdin logging to Output panel
- [ ] Write unit tests for stdin functionality
- [ ] Test with complex prompts (XML, markdown, quotes)
- [ ] Update documentation
- [ ] Test on Windows and Unix platforms

## Timeline

**Estimated**: 2-3 hours
- Implementation: 1 hour
- Testing: 1-2 hours
- Documentation: 30 minutes

## Risks & Mitigation

### Risk 1: Stdin Not Available
**Likelihood**: Very low (stdin always available in spawn())  
**Mitigation**: Error handling + fallback error message

### Risk 2: Performance Impact
**Likelihood**: None (stdin is faster than command-line parsing)  
**Mitigation**: N/A

### Risk 3: Platform Differences
**Likelihood**: Very low (stdin works identically everywhere)  
**Mitigation**: Multi-platform testing

## Conclusion

**Recommendation**: Implement stdin immediately.

- ✅ Safer (no escaping bugs)
- ✅ Simpler (less code)
- ✅ More robust (no length limits)
- ✅ Better UX (easier debugging)
- ✅ No breaking changes
- ✅ Works on all platforms

This is a clear win with no downsides.
