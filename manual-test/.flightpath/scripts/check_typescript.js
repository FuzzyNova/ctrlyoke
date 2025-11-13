#!/usr/bin/env node
/**
 * End condition script that checks if response contains TypeScript code.
 * Returns 'true' if TypeScript syntax is detected, 'false' otherwise.
 */

let response = '';

process.stdin.on('data', (chunk) => {
  response += chunk.toString();
});

process.stdin.on('end', () => {
  // Check for TypeScript patterns
  const hasTypeScript = /\b(interface|type|const|let|function)\b/.test(response);
  console.log(hasTypeScript ? 'true' : 'false');
});
