---
applyTo: "src/templates/**"
---

<purpose>
Validation script templates copied to `out/templates/` during build.
</purpose>

<contract>
- Output expected value to stdout (`"true"`, `"false"`, etc.)
- Exit code 0 = success, non-zero = error
- Supported: `.py`, `.js`, `.sh`, `.bat`
</contract>

<build>
- Source: `src/templates/`
- Bundled: `out/templates/` (esbuild copies, never edit)
- Access via `context.extensionPath`
</build>

<guidelines>
- Include shebang for Unix scripts
- No network access or file modifications
- Use subprocess for commands (not `eval`)
- Default to returning `"true"`
</guidelines>
