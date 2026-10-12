import test from 'node:test';
import assert from 'node:assert/strict';
import { combRecallTool, setCombVdbHook } from '../tools/builtin/comb.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';

test('COMB recall labels staged notes as historical and unverified', async () => {
  setCombVdbHook(
    () => true,
    () => [{
      id: 'stale-note',
      timestamp: Date.parse('2026-10-08T04:02:18Z'),
      text: 'A prior session reported that the gateway could not be restarted.',
    }],
  );

  const result = await combRecallTool.execute({});
  assert.match(result as string, /Historical Notes/);
  assert.match(result as string, /not live system state/);
  assert.match(result as string, /may be stale, incomplete, or from another session/);
  assert.match(result as string, /\[2026-10-08/);
});

test('system prompt requires live verification of operational claims from memory', () => {
  const prompt = buildSystemPrompt({
    workspace: process.cwd(),
    tools: ['read', 'exec'],
    workspaceFiles: [],
  });

  assert.match(prompt, /historical evidence, not live machine state/i);
  assert.match(prompt, /do not invent an inspection result/i);
});
