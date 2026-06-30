# ctrlyoke Manual Testing Examples

This directory contains sample code files that can be referenced in ctrlyoke prompts for testing file attachment features.

## Files

### `example.ts`

TypeScript file demonstrating:

- Interfaces
- Classes with private properties
- Map data structure
- Generic types
- Array methods

**Test scenarios:**

- Reference entire file: `@sample-code/example.ts`
- Reference specific method: `#file:sample-code/example.ts:23-26` (getUser method)
- Reference interface: `#file:sample-code/example.ts:6-11` (User interface)

### `example.py`

Python file demonstrating:

- Dataclasses
- Type hints
- List comprehensions
- Dictionary operations
- Optional types

**Test scenarios:**

- Reference entire file: `@sample-code/example.py`
- Reference class: `#file:sample-code/example.py:8-20` (Product dataclass)
- Reference method: `#file:sample-code/example.py:43-45` (total_inventory_value)

## Usage in Prompts

### Simple file reference

```json
{
  "prompt": "Explain what @sample-code/example.ts does"
}
```

### Specific line range

```json
{
  "prompt": "Improve this code: #file:sample-code/example.ts:23-26"
}
```

### Multiple files

```json
{
  "prompt": "Compare these implementations: @sample-code/example.ts and @sample-code/example.py"
}
```
