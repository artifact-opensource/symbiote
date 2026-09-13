# Ollama Provider

Run models locally — fully offline, no API keys, no cloud dependency. Uses Ollama's OpenAI-compatible API endpoint.

> **Local fallback.** Your hardware, your models, zero data leaves your machine.

## Setup

1. Install Ollama from [ollama.ai](https://ollama.ai)
2. Pull a model:

```bash
ollama pull qwen3:4b
```

3. Make sure Ollama is running:

```bash
ollama serve
```

4. Configure in `mach6.json`:

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "qwen3:4b",
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434"
    }
  }
}
```

No `.env` key needed — Ollama doesn't require authentication.

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `baseUrl` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `apiKey` | `ollama` | Placeholder (Ollama ignores auth, but the OpenAI adapter expects a value) |

## Supported Models

Any model you've pulled with `ollama pull`. Common choices:

| Model | Config Value | Size | Notes |
|-------|-------------|------|-------|
| Qwen 3 4B | `qwen3:4b` | ~2.5 GB | Fast, good tool use |
| Llama 3.2 3B | `llama3.2:3b` | ~2 GB | Compact, Meta's latest |
| Llama 3.1 8B | `llama3.1:8b` | ~4.7 GB | Balanced quality/speed |
| DeepSeek R1 8B | `deepseek-r1:8b` | ~4.7 GB | Strong reasoning |
| Mistral 7B | `mistral:7b` | ~4.1 GB | Solid general-purpose |

List installed models:

```bash
ollama list
```

## Performance

Speed depends entirely on your hardware:

- **CPU-only:** Slower but functional (expect 5-20 tok/sec depending on model size and CPU)
- **GPU (NVIDIA/AMD/Apple Silicon):** Ollama auto-detects and uses available GPU acceleration
- **RAM:** Models load into memory — make sure you have enough (model size × ~1.2)

## Example

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "llama3.1:8b",
  "providers": {
    "ollama": {}
  }
}
```

Switch mid-session:

```
/provider ollama
/model qwen3:4b
```

## Troubleshooting

**"Connection refused" on startup:**
Ollama server isn't running. Start it with `ollama serve` or check if it's already running on a different port.

**Model not found:**
You need to pull the model first: `ollama pull <model-name>`.

**Slow inference:**
Try a smaller model (3B-4B). Larger models need more RAM and benefit significantly from GPU acceleration.
