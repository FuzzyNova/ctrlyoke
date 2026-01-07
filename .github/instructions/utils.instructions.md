---
applyTo: "src/utils/**"
---

<purpose>
Shared file system, logging, and validation utilities.
</purpose>

<fileSystemUtils>
**Responsibilities:**
- Safe file operations with error handling
- Directory creation with recursion
- File watching with chokidar
- Pattern-based file discovery

**Key patterns:**

- All methods return safe values (null/false on error, never throw)
- Directory creation is recursive (like `mkdir -p`)
- File watching uses chokidar (not VS Code's API) for reliability
- Event-driven architecture with `onDidChangeFile` event emitter

**File watching:**

- Maintains map of watchers (multiple directories)
- Each watcher fires `onFileChanged` event with file path
- Used for monitoring `.flightpath/` directory
- Cleanup required: Call `stopWatching()` or dispose on deactivation

**Why chokidar vs. VS Code FileSystemWatcher:**

- More reliable change detection
- Better handling of rapid file changes
- Cross-platform consistency
- Configurable debouncing and throttling
  </fileSystemUtils>

<log>
**Responsibilities:**
- Centralized logging with log levels
- Output channel integration
- Timestamped log entries
- Stack trace capture for errors

**Log levels:**

- DEBUG (0): Verbose diagnostic information
- INFO (1): General informational messages
- WARN (2): Warning messages for potential issues
- ERROR (3): Error messages with stack traces

**Usage pattern:**

```typescript
Log.initialize(context, LogLevel.INFO);
Log.info("Operation started");
Log.error("Operation failed", error);
```

**Output routing:**

- Always logs to console (development)
- Optionally logs to Output channel (if initialized)
- Log level filters messages (only >= configured level shown)

**Why separate from Console.log:**

- Structured format with timestamps
- Log level filtering
- Single output channel (avoids clutter)
- Stack trace capture for errors
  </log>

<validationUtils>
**Responsibilities:**
- Runtime validation using AJV
- Type-safe validation with TypeScript generics
- Error message formatting
- Schema compilation and caching

**Key patterns:**

- Schemas defined inline as JSONSchemaType<T> (type safety)
- Validators compiled once and cached (performance)
- Error messages include instance path (shows where validation failed)
- Separate validators for single items vs. arrays

**Validation flow:**

1. Compile schema to validator function (once, cached)
2. Call validator with data
3. Check validator.errors for detailed error info
4. Format errors to human-readable messages

**Why separate from PromptFileParser:**

- ValidationUtils: General-purpose validation (reusable)
- PromptFileParser: Specific to prompt file schema
- Enables validation of other data structures (settings, API responses)

**Type safety:**

```typescript
const validator = ajv.compile<PromptItem>(promptItemSchema);
// TypeScript ensures schema matches PromptItem structure
```

</validationUtils>

<otherUtilities>
**Additional utility classes** (see source files for details):
- **CliProcessManager**: CLI process spawning, terminal management, cancellation
- **ContextExpander**: Context variable expansion for prompt processing
- **TempFileManager**: Temporary file creation and cleanup
- **TuiStreamProcessor**: TUI output parsing and chrome filtering
- **ConfigurationUtils**: VS Code settings access with type safety
- **FileReferenceParser**: Parse #file: and @file syntax
- **AttachmentBuilders**: Build Copilot XML attachment format
- **BuildConfig**: Build-time constants (IS_DEV_MODE, BUILD_DATE)
- **ModelConstants/ModelRegistry**: Model definitions and runtime discovery
</otherUtilities>

<sharedPatterns>
**Error handling:**
- Never throw exceptions from utility functions
- Return safe fallback values (null, false, empty array)
- Log errors to console and output channel
- Caller checks return value and handles errors gracefully

**Disposal:**

- Utils that create resources (watchers, event emitters) provide cleanup methods
- Register disposables in context.subscriptions
- Clean shutdown prevents resource leaks
  </sharedPatterns>

<relatedFiles>
- `../flightpath/PromptFileParser.ts` - Uses similar validation patterns
- `../flightpath/EndConditionEvaluator.ts` - Uses file system utilities
- `../extension.ts` - Initializes Log with context
- `PromptIdentity.ts` - Hash-based prompt identity tracking for queue deduplication
- `docs/QUEUE_APPEND_FEATURE.md` - Working file system documentation
</relatedFiles>

<promptIdentity>
**Responsibilities:**
- Hash-based prompt identity tracking
- Deduplication of prompts in queue
- Completion tracking across queue extensions

**Key functions:**

- `hashPromptContent(prompt: string)` - SHA-256 hash of normalized prompt text (16 chars)
- `isPromptCompleted(prompt: PromptItem, completedIds: Set<string>)` - Check if prompt already executed
- `shouldInjectExtensionInstructions(prompt: PromptItem, ...)` - Determines if Dynamic Queue instructions needed

**Hash normalization:**

- Trims whitespace
- Converts to lowercase
- Ensures consistent hashing across edits

**Identity strategy:**

- Explicit ID (optional): User or AI provides `id` field
- Content hash (automatic): Fallback when no explicit ID
- Prevents duplicate execution when MCP or user appends same prompt

**Usage:**

```typescript
const hash = hashPromptContent(prompt.prompt);
if (completedIds.has(hash)) {
  // Skip - already executed
}
```

**See also:**

- `docs/QUEUE_APPEND_FEATURE.md` - Deduplication architecture
  </promptIdentity>
