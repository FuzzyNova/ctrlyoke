# Changelog

All notable changes to FlightPath will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING:** Replaced contenteditable prompt editor with CodeMirror 6
  - Improved stability and reliability (eliminates cursor jumping and blank line collapse bugs)
  - Native Typo.js spell checking via CodeMirror linter API
  - Better autocomplete experience with extensible completion system
  - Clickable #file: links with Ctrl+Click navigation
  - Full VS Code theme integration
  - Modern text editor features: undo/redo, search, multiple selections
  - Reduced codebase complexity (843 lines of DOM manipulation replaced with 420 lines of CodeMirror configuration)

### Removed

- Old contenteditable-based prompt editor (`prompt-editor.js`)
- Custom spell-check menu implementation (replaced with CodeMirror linter quick fixes)

Initial development - see git history for detailed changes.

### Planned for v0.1.0

- CLI Mode with model selection and agent support
- Chat Mode with Language Model Tool API
- Dynamic Queue System for autonomous workflow extension
- WebView Dashboard with live output streaming
- End Conditions with script-based validation
- Multi-format support (.prompt.json, .flightpath.json, .prompt.md)
