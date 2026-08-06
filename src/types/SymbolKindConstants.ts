/**
 * Maps persisted vscode.SymbolKind names to the codicons used by reference
 * chips. Keep the complete vocabulary here so producers and renderers share
 * one contract without importing extension code into the webview.
 */
export const SYMBOL_KIND_ICONS: Record<string, string> = {
  file: "symbol-file",
  module: "symbol-module",
  namespace: "symbol-module",
  package: "symbol-module",
  class: "symbol-class",
  method: "symbol-method",
  property: "symbol-property",
  field: "symbol-field",
  constructor: "symbol-constructor",
  enum: "symbol-enum",
  interface: "symbol-interface",
  function: "symbol-function",
  variable: "symbol-variable",
  constant: "symbol-constant",
  string: "symbol-value",
  number: "symbol-value",
  boolean: "symbol-value",
  array: "symbol-value",
  object: "symbol-value",
  key: "symbol-property",
  null: "symbol-value",
  "enum-member": "symbol-enum-member",
  struct: "symbol-struct",
  event: "symbol-event",
  operator: "symbol-operator",
  "type-parameter": "symbol-type-parameter",
};
