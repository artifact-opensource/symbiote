import test from 'node:test';
import assert from 'node:assert/strict';
import { sttTool } from '../tools/builtin/stt.js';

test('STT tool rejects an empty audio path', async () => {
  assert.match(await sttTool.execute({ audio_path: '  ' }), /audio_path must be a non-empty file path/);
});

test('STT tool reports a missing audio file', async () => {
  const result = await sttTool.execute({ audio_path: 'missing-audio-file-for-stt-test.wav' });
  assert.match(result, /Audio file not found/);
});
