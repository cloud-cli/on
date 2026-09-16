import { describe, expect, it } from 'vitest';
import { buildAiHelpMessages, createAiRequest } from './ai-help.js';

describe('AI help requests', () => {
  it('builds the model request with workflow and failed-step history', () => {
    const messages = buildAiHelpMessages(
      'name: Build\nsteps: []',
      [
        { id: 'one', name: 'One', status: 'success', durationMs: 1, outputs: {}, logContent: '' },
        { id: 'two', name: 'Two', status: 'failed', durationMs: 1, outputs: {}, logContent: '' },
      ],
      { one: 'ok', two: 'failed' },
      'two',
      (value) => value,
    );
    const request = createAiRequest('llama3.2', messages);

    expect(request.model).toBe('llama3.2');
    expect(request.messages).toHaveLength(4);
    expect(request.messages[2].content).toContain('STEP one');
    expect(request.messages[2].content).toContain('STEP two');
    expect(request.messages[2].content).not.toContain('STEP three');
  });
});
