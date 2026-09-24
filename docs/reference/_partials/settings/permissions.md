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
  through the dashboard or with `ctrlyoke trust-external-roots <file>`.
  ctrlyoke stores approvals on the local machine and never writes them into
  the workspace settings file.

A single workflow can inherit, replace, or disable this set with its
[`trustedExternalRoots`](/reference/workflow-schema#workflow-file-trustedexternalroots)
field.
