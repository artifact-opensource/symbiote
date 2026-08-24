/**
 * Symbiote Voice Middleware
 * 
 * Intercepts voice/PTT messages in the gateway pipeline:
 * - Inbound: auto-transcribes voice notes → injects text for the agent
 * - Outbound: generates voice reply when the original message was voice
 * 
 * Integration points in daemon.ts:
 * 1. After buildUserContent() → call transcribeVoicePayload() 
 * 2. After finalResult.text → call generateVoiceReply()
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BusEnvelope } from '../channels/types.js';

const execAsync = promisify(exec);

// Python environments
const HEKTOR_PYTHON = '/home/adam/workspace/.hektor-env/bin/python3';
const VOICE_PYTHON = '/home/adam/workspace/.ava-voice/venv/bin/python3';
const VOICE_DIR = '/home/adam/workspace/voice';
const SPEAK_SCRIPT = '/home/adam/workspace/.ava-voice/speak.py';

// ─── Inbound: Voice → Text ─────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
  processingTime: number;
  isEmpty: boolean;
}

/**
 * Check if an envelope contains a voice/PTT message with a downloaded file.
 */
export function isVoiceMessage(envelope: BusEnvelope): boolean {
  const media = envelope.payload.media;
  if (!media?.length) return false;
  return media.some(m => 
    (m.type === 'voice' || m.type === 'audio') && m.path && fs.existsSync(m.path)
  );
}

/**
 * Transcribe a voice message and return the transcript.
 * Uses faster-whisper via the stt.py CLI.
 */
export async function transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
  try {
    const { stdout } = await execAsync(
      `${HEKTOR_PYTHON} ${VOICE_DIR}/stt.py "${audioPath}"`,
      { timeout: 120_000 }
    );
    const result = JSON.parse(stdout.trim());
    return {
      text: result.text ?? '',
      language: result.language ?? 'en',
      duration: result.duration ?? 0,
      processingTime: result.processing_time ?? 0,
      isEmpty: result.is_empty ?? true,
    };
  } catch (err) {
    console.error('[voice-middleware] Transcription failed:', err);
    return {
      text: '',
      language: 'en',
      duration: 0,
      processingTime: 0,
      isEmpty: true,
    };
  }
}

/**
 * Process a voice envelope: transcribe and augment the user content.
 * Returns the transcript text to prepend/replace in buildUserContent.
 * 
 * Call this in runAgentTurn() after buildUserContent():
 * 
 *   const userContent = this.buildUserContent(envelope);
 *   const voiceResult = await processVoiceInbound(envelope);
 *   const finalContent = voiceResult 
 *     ? `${userContent}\n\n🎤 Voice transcript: "${voiceResult.text}"`
 *     : userContent;
 */
export async function processVoiceInbound(envelope: BusEnvelope): Promise<TranscriptionResult | null> {
  if (!isVoiceMessage(envelope)) return null;

  const voiceMedia = envelope.payload.media!.find(m => 
    (m.type === 'voice' || m.type === 'audio') && m.path
  );
  if (!voiceMedia?.path) return null;

  console.log(`[voice-middleware] Transcribing: ${voiceMedia.path}`);
  const result = await transcribeAudio(voiceMedia.path);
  
  if (result.isEmpty) {
    console.log(`[voice-middleware] Empty/silence detected (${result.duration}s)`);
    return result;
  }

  console.log(`[voice-middleware] Transcript (${result.duration}s → ${result.processingTime}s): "${result.text.slice(0, 100)}..."`);
  
  // Mark the envelope so the response handler knows to reply with voice
  (envelope as any)._isVoice = true;
  (envelope as any)._voiceTranscript = result;

  return result;
}

// ─── Outbound: Text → Voice ────────────────────────────────────────────

/**
 * Generate a voice reply OGG file from text.
 * Uses MeloTTS + OpenVoice (AVA's sovereign voice).
 * 
 * Returns the path to the generated OGG file, or null on failure.
 */
export async function generateVoiceReply(text: string): Promise<string | null> {
  if (!text || text.length === 0) return null;

  const outputPath = `/tmp/ava-voice-reply-${Date.now()}.ogg`;
  
  // For long texts, use the chunked TTS
  const useChunked = text.length > 250;
  
  try {
    if (useChunked) {
      const { stdout } = await execAsync(
        `${HEKTOR_PYTHON} ${VOICE_DIR}/tts.py "${text.replace(/"/g, '\\"')}" --output "${outputPath}"`,
        { timeout: 300_000 } // 5 min for long texts
      );
    } else {
      await execAsync(
        `${VOICE_PYTHON} ${SPEAK_SCRIPT} "${text.replace(/"/g, '\\"')}" --output "${outputPath}"`,
        { timeout: 120_000 }
      );
    }

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
      console.log(`[voice-middleware] Voice reply generated: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
      return outputPath;
    }
    return null;
  } catch (err) {
    console.error('[voice-middleware] TTS failed:', err);
    return null;
  }
}

/**
 * Clean up temporary voice files after sending.
 */
export function cleanupVoiceFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch { /* ignore */ }
}
