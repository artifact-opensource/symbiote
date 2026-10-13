import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../types.js';
import { expandHome } from '../../runtime/platform.js';
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
  async execute(input) {
    const audioPath = typeof input.audio_path === 'string' ? input.audio_path.trim() : '';
    if (!audioPath) return 'Error: audio_path must be a non-empty file path.';

    const resolvedPath = path.resolve(expandHome(audioPath));
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
