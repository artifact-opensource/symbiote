// Symbiote — Builtin tool: text-to-speech
// Uses edge-tts (free, Microsoft) as primary, no API key needed.
// Free, no API key needed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../types.js';

const TTS_OUTPUT_DIR = path.join(os.tmpdir(), 'symbiote-tts');

// Edge-TTS voice mapping (natural-sounding voices)
const EDGE_VOICES: Record<string, string> = {
  nova: 'en-US-JennyNeural',        // warm, friendly female
  alloy: 'en-US-AriaNeural',        // clear female
  echo: 'en-US-GuyNeural',          // male
  fable: 'en-GB-SoniaNeural',       // British female
  onyx: 'en-US-ChristopherNeural',  // deep male
  shimmer: 'en-US-MichelleNeural',  // bright female
};

function getWorkspace(): string {
  return process.env.MACH6_WORKSPACE ?? process.cwd();
}

async function edgeTTS(text: string, voice: string, speed: number, filepath: string): Promise<boolean> {
  const edgeVoice = EDGE_VOICES[voice] ?? EDGE_VOICES.nova;
  // Speed: edge-tts uses percentage like "+20%" or "-10%"
  const speedPct = speed === 1.0 ? '+0%' : `${speed > 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
  const ws = getWorkspace();

  try {
    const cmd = `source ${ws}/.hektor-env/bin/activate && edge-tts --voice "${edgeVoice}" --rate="${speedPct}" --text "${text.replace(/"/g, '\\"').replace(/\n/g, ' ')}" --write-media "${filepath}"`;
    execSync(cmd, { encoding: 'utf-8', timeout: 60_000, shell: '/bin/bash', stdio: 'pipe' });
    return fs.existsSync(filepath) && fs.statSync(filepath).size > 0;
  } catch {
    return false;
  }
}

export const ttsTool: ToolDefinition = {
  name: 'tts',
  description: 'Convert text to speech. Returns the path to the generated audio file. Uses Microsoft Edge TTS (free, high quality).',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to convert to speech' },
      voice: { type: 'string', description: 'Voice to use (nova, alloy, echo, fable, onyx, shimmer). Default: nova', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
      speed: { type: 'number', description: 'Speed multiplier (0.25 to 4.0). Default: 1.0' },
    },
    required: ['text'],
  },
  async execute(input) {
    const text = input.text as string;
    const voice = (input.voice as string) ?? 'nova';
    const speed = (input.speed as number) ?? 1.0;

    fs.mkdirSync(TTS_OUTPUT_DIR, { recursive: true });
    const filename = `tts-${Date.now()}.mp3`;
    const filepath = path.join(TTS_OUTPUT_DIR, filename);

    // Try edge-tts first (free)
    const ok = await edgeTTS(text, voice, speed, filepath);
    if (ok) {
      // Also generate OGG opus (required for WhatsApp voice notes)
      const oggPath = filepath.replace('.mp3', '.ogg');
      try {
        execSync(`ffmpeg -y -i "${filepath}" -codec:a libopus -b:a 64k "${oggPath}"`, { stdio: 'pipe', timeout: 30_000 });
      } catch { /* mp3 still works for non-WhatsApp */ }

      const size = fs.statSync(filepath).size;
      const oggExists = fs.existsSync(oggPath);
      return JSON.stringify({
        path: filepath,
        oggPath: oggExists ? oggPath : undefined,
        size,
        voice,
        engine: 'edge-tts',
        note: 'Use oggPath for WhatsApp voice notes (mp3 wont play inline)',
      });
    }

    return 'Error: TTS generation failed. edge-tts may not be installed.';
  },
};
