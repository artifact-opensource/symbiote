// Symbiote — Builtin tool: STT (Speech-to-Text)

import fs from 'node:fs';
import type { ToolDefinition } from '../types.js';
import { resolveLocalPath } from '../../runtime/platform.js';
import { transcribeAudio } from '../../voice/voice-middleware.js';

export const sttTool: ToolDefinition = {
  name: 'stt',
  description: 'Transcribe a local audio file using the configured faster-whisper voice runtime.',
  parameters: {
    type: 'object',
    properties: {
      audio_path: { type: 'string', description: 'Path to the local audio file to transcribe' },
    },
    required: ['audio_path'],
  },
  idempotency: {
    class: 'external',
    externalSystem: 'voice_runtime',
    irreversibleReason: 'Speech transcription calls an external voice processing runtime that may produce different results on different runs.',
    idempotencyKey: (input) => `stt:${String(input.audio_path ?? '')}`,
  },
  async execute(input) {
    const audioPath = typeof input.audio_path === 'string' ? input.audio_path.trim() : '';
    if (!audioPath) return 'Error: audio_path must be a non-empty file path.';

    const resolvedPath = resolveLocalPath(audioPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolvedPath);
    } catch {
      return `Error: Audio file not found: ${resolvedPath}`;
    }
    if (!stat.isFile()) return `Error: Audio path is not a file: ${resolvedPath}`;

    const result = await transcribeAudio(resolvedPath);
    if (result.error) return `Error: Speech transcription failed: ${result.error}`;
    return JSON.stringify(result);
  },
};