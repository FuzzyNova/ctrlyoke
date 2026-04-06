# MCP Deduplication Testing Guide

Tests the MCP server's deduplication validation logic.

## Test Cases

### 1. Duplicate Content in Single Append (No IDs)

**Input:**

```json
{
  "steps": [
    { "prompt": "Review the code" },
    { "prompt": "Review the code" } // DUPLICATE
  ],
  "position": "next"
}
```

**Expected Result:**

```json
{
  "success": true,
  "promptsAdded": 1,
  "promptsRejected": 1,
  "rejectionDetails": [
    {
      "prompt": "Review the code",
      "reason": "Duplicate content in append batch"
    }
  ]
}
```

### 2. Duplicate Explicit IDs in Single Append

**Input:**

```json
{
  "steps": [
    { "id": "review", "prompt": "Check the implementation" },
    { "id": "review", "prompt": "Different content" } // DUPLICATE ID
  ],
  "position": "next"
}
```

**Expected Result:**

```json
{
  "promptsRejected": 1,
  "rejectionDetails": [
    {
      "id": "review",
      "reason": "Duplicate ID in append batch: review"
    }
  ]
}
```

### 3. Already Completed Prompts

**Setup:** Queue has completed prompt with hash "abc123..."

**Input:**

```json
{
  "steps": [{ "prompt": "Exact same completed prompt" }],
  "position": "next"
}
```

**Expected Result:**

```json
{
  "promptsRejected": 1,
  "rejectionDetails": [
    {
      "reason": "Prompt already completed"
    }
  ]
}
```

### 4. Duplicate ID in Existing Queue

**Setup:** Queue contains `{ "id": "analyze", "prompt": "..." }`

**Input:**

```json
{
  "steps": [{ "id": "analyze", "prompt": "Different analysis" }],
  "position": "next"
}
```

**Expected Result:**

```json
{
  "promptsRejected": 1,
  "rejectionDetails": [
    {
      "id": "analyze",
      "reason": "Duplicate ID: analyze"
    }
  ]
}
```

### 5. Legitimate Duplicate Content with Different IDs

**Input:**

```json
{
  "steps": [
    { "id": "review-1", "prompt": "Review the code" },
    { "id": "review-2", "prompt": "Review the code" } // SAME CONTENT, DIFFERENT ID
  ],
  "position": "next"
}
```

**Expected Result:**

```json
{
  "success": true,
  "promptsAdded": 2,
  "promptsRejected": 0
}
```

**Note:** Both prompts accepted because they have different explicit IDs.

### 6. Mixed Valid and Invalid

**Input:**

```json
{
  "steps": [
    { "id": "valid-1", "prompt": "First valid prompt" },
    { "prompt": "Duplicate content" },
    { "prompt": "Duplicate content" }, // REJECTED
    { "id": "valid-2", "prompt": "Second valid prompt" }
  ],
  "position": "end"
}
```

**Expected Result:**

```json
{
  "success": true,
  "promptsAdded": 3,
  "promptsRejected": 1,
  "rejectionDetails": [
    {
      "prompt": "Duplicate content",
      "reason": "Duplicate content in append batch"
    }
  ]
}
```

## Implementation Details

### Shared Logic

The MCP server imports `hashPromptContent` and `isPromptCompleted` from `PromptIdentity.ts`, ensuring:

1. **Same hash algorithm** - SHA-256 with whitespace normalization
2. **Same explicit ID detection** - `id !== hash` check
3. **Same deduplication rules**:
   - Explicit IDs: Only exact ID+hash match is considered duplicate
   - No ID: Hash match is considered duplicate
   - Auto-assigned IDs: Treated as "no explicit ID"

### Validation Flow

```
validatePrompts(newPrompts, existingQueue, completedIds)
  │
  ├─► Build tracking sets from existing queue
  │   ├─ seenExplicitIds (IDs where id !== hash)
  │   └─ seenHashes (hashes for prompts without explicit ID)
  │
  └─► For each new prompt:
      ├─ Check 1: isPromptCompleted() → reject if true
      ├─ Check 2: Duplicate explicit ID in queue → reject
      ├─ Check 3: Duplicate hash (if no explicit ID) → reject
      └─ Check 4: Duplicate in append batch → reject
```

### Error Response

If ALL prompts rejected:

```json
{
  "error": "All 3 prompts rejected. Reasons: \"Review...\": Duplicate content; \"Analyze...\": Duplicate ID: analyze; ..."
}
```

If SOME prompts accepted:

```json
{
  "success": true,
  "promptsAdded": 2,
  "promptsRejected": 1,
  "rejectionDetails": [...]
}
```

## Testing with CLI

Use the MCP Inspector or CLI tools to test these scenarios:

```bash
# Test duplicate content
echo '{"steps":[{"prompt":"Test"},{"prompt":"Test"}],"position":"next"}' | \
  node out/mcp-server.js

# Check logs
tail -f .flightpath/logs/mcp-server-*.log
```
