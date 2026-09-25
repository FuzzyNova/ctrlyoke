### External file roots

Workspace files are always trusted. To let ctrlyoke use a directory outside
the workspace, add it to `permissions.allowedExternalFileRoots`:

```json
{
  "permissions": {
    "allowedExternalFileRoots": [
      "C:/Users/me/.codex/sessions",
      "C:/temp/repros"
    ]
  }
}
```

- **User scope:** trusted immediately, because you edited your own settings
  file.
- **Workspace scope:** treated as a request. Each machine must approve it once,
  through the prompt in VS Code or by running `ctrlyoke trust-external-roots`
  in the workspace. Add `--yes` to approve every pending root without being
  asked. ctrlyoke stores approvals on the local machine and never writes them
  into the workspace settings file.

Roots from the user and workspace files are combined. They don't replace each
other.

A single workflow can inherit, replace, or disable this set with its
[`trustedExternalRoots`](/reference/workflow-schema#workflow-file-trustedexternalroots)
field. To approve the new roots a workflow declares, use
`ctrlyoke trust-workflow-external-roots <file>`.
