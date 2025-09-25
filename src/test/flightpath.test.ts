import * as assert from 'assert';
import * as vscode from 'vscode';
import { PromptFileParser } from '../flightpath/PromptFileParser';
import { PromptQueue } from '../flightpath/PromptQueue';
import { ValidationUtils } from '../utils/ValidationUtils';

suite('FlightPath Core Tests', () => {

    test('PromptFileParser should be instantiable', () => {
        const parser = new PromptFileParser();
        assert.ok(parser);
    });

    test('PromptQueue should be instantiable', () => {
        const queue = new PromptQueue();
        assert.ok(queue);
    });

    test('PromptQueue should start with idle state', () => {
        const queue = new PromptQueue();
        const state = queue.getState();
        assert.strictEqual(state.status, 'idle');
        assert.strictEqual(state.currentIndex, 0);
        assert.strictEqual(state.prompts.length, 0);
        assert.strictEqual(state.results.length, 0);
    });

    test('ValidationUtils should validate prompt items correctly', () => {
        const validPrompt = {
            prompt: 'Test prompt',
            endCondition: {
                script: 'test.py',
                returns: 'true'
            }
        };

        const result = ValidationUtils.validatePromptItem(validPrompt);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.errors.length, 0);
    });

    test('ValidationUtils should catch invalid prompt items', () => {
        const invalidPrompt = {
            // Missing required 'prompt' field
            endCondition: {
                script: 'test.py',
                returns: 'true'
            }
        };

        const result = ValidationUtils.validatePromptItem(invalidPrompt);
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors.length > 0);
    });

    test('ValidationUtils should validate script paths', () => {
        const validPath = 'test.py';
        const result = ValidationUtils.validateScriptPath(validPath);
        assert.strictEqual(result.valid, true);

        const invalidPath = '../../../dangerous.sh';
        const invalidResult = ValidationUtils.validateScriptPath(invalidPath);
        assert.strictEqual(invalidResult.valid, false);
    });

    test('PromptQueue should load prompts correctly', () => {
        const queue = new PromptQueue();
        const prompts = [
            { prompt: 'First prompt' },
            { prompt: 'Second prompt' }
        ];

        queue.loadPrompts(prompts);
        const state = queue.getState();
        
        assert.strictEqual(state.prompts.length, 2);
        assert.strictEqual(state.results.length, 2);
        assert.strictEqual(state.status, 'idle');
    });

    test('PromptQueue should track progress correctly', () => {
        const queue = new PromptQueue();
        const prompts = [
            { prompt: 'First prompt' },
            { prompt: 'Second prompt' },
            { prompt: 'Third prompt' }
        ];

        queue.loadPrompts(prompts);
        const progress = queue.getProgress();
        
        assert.strictEqual(progress.total, 3);
        assert.strictEqual(progress.current, 0);
        assert.strictEqual(progress.percentage, 0);
    });
});