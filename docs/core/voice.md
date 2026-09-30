# Voice Pipeline

Transparent voice support for Symbiote agents. Voice messages are auto-transcribed on input and optionally synthesized on output. The agent doesn't need to know about audio formats.

## How It Works

### Inbound (Voice → Text)

When a voice note arrives via WhatsApp or Discord:

1. The voice middleware detects the audio attachment (`voice` or `audio` type)
2. The audio file is transcribed using **faster-whisper** STT (speech-to-text)
3. The transcript is injected into the conversation as `🎤 Voice transcript: "..."`
4. The agent sees plain text — it never handles audio directly

The envelope is internally marked as a voice message so the response handler knows to consider a voice reply.

### Outbound (Text → Voice)

Voice replies are generated via the `tts` tool:

```json
{ "text": "Hello, how can I help?", "voice": "nova" }
```

The TTS system generates an OGG audio file and returns the file path. When used in response to a voice message, the audio is sent back as a voice note on the originating channel.

**Available voices:** `nova`, `alloy`, `echo`, `fable`, `onyx`, `shimmer`

## Architecture

```
Inbound:
  Voice Note → Download → faster-whisper STT → Text → Agent

Outbound:
  Agent → tts tool → Edge TTS → OGG file → Send as voice message
```

### STT (Speech-to-Text)

| Setting | Value |
|---------|-------|
| **Engine** | faster-whisper (CTranslate2-optimized Whisper) |
| **Invocation** | Python CLI (`stt.py`) called via child process |
| **Output** | JSON: `text`, `language`, `duration`, `processing_time`, `is_empty` |
| **Timeout** | 120 seconds per transcription |
| **Empty detection** | Silence or unintelligible audio returns `is_empty: true` |

### TTS (Text-to-Speech)

| Setting | Value |
|---------|-------|
| **Engine** | Microsoft Edge TTS (free, high quality) |
| **Voices** | 6 built-in: nova, alloy, echo, fable, onyx, shimmer |
| **Output** | OGG audio file |
| **Chunking** | Long texts (>250 chars) use chunked synthesis |
| **Timeout** | 120s for short texts, 300s for long texts |
| **Cleanup** | Temporary audio files deleted after sending |

## Integration Points

The voice middleware integrates at two points in the gateway pipeline:

1. **After `buildUserContent()`** — `processVoiceInbound()` transcribes and augments the user message
2. **After agent response** — `generateVoiceReply()` synthesizes audio when the original message was voice

### Sovereign Voice (Enterprise)

Enterprise deployments can use a sovereign voice pipeline (MeloTTS + OpenVoice V2) for fully offline, zero-cloud voice synthesis. This uses a custom voice profile with cloned vocal characteristics. Configuration is per-deployment.

## Configuration

Voice works out of the box when the required Python dependencies are installed:

- **STT:** `faster-whisper` in the Python environment
- **TTS:** Edge TTS (network-based, free) or MeloTTS + OpenVoice (local, sovereign)

No `mach6.json` configuration is required — the middleware auto-detects voice messages and handles them transparently.

## Example Flow

```
User sends voice note (WhatsApp):
  → "Hey, can you check if the deploy went through?"

Agent sees:
  🎤 Voice transcript: "Hey, can you check if the deploy went through?"

Agent responds with tts tool:
  → tts("The deploy completed successfully at 2:15 PM. All health checks passing.")

User receives:
  → Voice note with the response
```

---

*Added in v1.7.0*
