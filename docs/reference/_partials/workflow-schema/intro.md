A workflow file is YAML, JSON, or a `.prompt.md` file. It is checked against
`schemas/workflow-schema.json`. A multi-step workflow looks like this:

```yaml
harness: claude-cli
model: sonnet
steps:
  - name: Review
    prompt: Review @src/ for error-handling gaps.
  - type: script
    script: npm test
finalStep:
  prompt: Summarize what changed.
```

A file with a single step can drop `steps` and put the prompt step or script
step fields at the root.

### How values are inherited

Most fields are [execution properties](#execution-properties). You can set
them in three places. When a field appears in more than one place, the most
specific one wins:

1. A step's own value.
2. The workflow root.
3. The matching [`defaults.*` setting](/reference/settings#defaults).

On most fields, `null` means "turn off what would be inherited". Omitting a
field means "inherit it". Where `null` is allowed, the field's accepted forms
say what it does.
