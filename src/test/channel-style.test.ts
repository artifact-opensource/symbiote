import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from '../agent/system-prompt.js';

test('system prompt enforces CLI and Discord response styles', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'symbiote-channel-style-'));
  try {
    const discordPrompt = buildSystemPrompt({ workspace, tools: [], channel: 'discord', chatType: 'group' });
    assert.match(discordPrompt, /plain text for Discord/i);
    assert.match(discordPrompt, /Do not use Markdown syntax/i);
    assert.match(discordPrompt, /message limit/i);

    const cliPrompt = buildSystemPrompt({ workspace, tools: [], channel: 'cli', chatType: 'direct' });
    assert.match(cliPrompt, /Format for a terminal/i);
    assert.match(cliPrompt, /terminal control sequences/i);
    assert.doesNotMatch(cliPrompt, /Do not use Markdown syntax/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});