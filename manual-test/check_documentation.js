#!/usr/bin/env node

/**
 * Simple test script for FlightPath end condition retry testing
 * 
 * This script checks if a file contains JSDoc documentation.
 * It demonstrates the retry mechanism by:
 * - Exiting with code 0 (success) even on validation failure
 * - Outputting clear messages for retry prompts
 */

const fs = require('fs');
const path = require('path');

// Check if add.js exists in the current directory
const filePath = path.join(process.cwd(), 'add.js');

if (!fs.existsSync(filePath)) {
    console.log('incomplete');
    console.log('File add.js not found. Please create it first.');
    process.exit(0); // Exit cleanly for retry
}

const content = fs.readFileSync(filePath, 'utf8');

// Check for JSDoc comments
const hasJSDoc = content.includes('/**') && content.includes('*/');
const hasParams = content.includes('@param');
const hasReturns = content.includes('@returns') || content.includes('@return');

if (hasJSDoc && hasParams && hasReturns) {
    console.log('complete');
    process.exit(0);
} else {
    console.log('incomplete');
    
    const missing = [];
    if (!hasJSDoc) missing.push('JSDoc comment block (/** ... */)');
    if (!hasParams) missing.push('@param tags');
    if (!hasReturns) missing.push('@returns tag');
    
    console.log(`Missing documentation elements: ${missing.join(', ')}`);
    process.exit(0); // Exit cleanly for retry mechanism
}
