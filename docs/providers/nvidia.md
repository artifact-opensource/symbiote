# NVIDIA Provider

NVIDIA NIM (NVIDIA Inference Microservices) provides access to NVIDIA-hosted open models via API.

## Configuration

```json
{
  "provider": "nvidia",
  "nvidia": {
    "apiKey": "${NVIDIA_API_KEY}",
    "model": "nvidia/llama-3.1-nemotron-70b-instruct"
  }
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `NVIDIA_API_KEY` | Yes | API key from build.nvidia.com |

## Supported Models

- `nvidia/llama-3.1-nemotron-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b`
- `meta/llama-3.1-405b-instruct`

## Notes

- NVIDIA NIM endpoints are optimized for inference speed on NVIDIA hardware.
- Free tier available with rate limits.
