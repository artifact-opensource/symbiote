#!/usr/bin/env python3
"""
GLADIUS → Ollama-compatible API server
Serves Phoenix Ultimate checkpoint as an OpenAI-compatible chat endpoint.
This lets Plug (and eventually Mach6) talk to GLADIUS natively.

Endpoint: POST /v1/chat/completions (OpenAI-compatible)
Also:     POST /api/generate (Ollama-compatible)
Also:     GET  /v1/models (model listing)
"""

import sys, os, json, time, argparse, torch
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

# Add GLADIUS to path
GLADIUS_V2 = os.path.join(os.path.dirname(__file__), '..', '..', 'gladius_v2', 'src')
sys.path.insert(0, GLADIUS_V2)

from kernel.kernel import GladiusKernel
from kernel.config import KernelConfig

# Global state
kernel: Optional[GladiusKernel] = None
tokenizer = None
MODEL_NAME = "gladius-phoenix-ultimate"


def load_model(checkpoint_path: str):
    """Load GLADIUS from checkpoint."""
    global kernel, tokenizer
    
    print(f"[gladius-serve] Loading checkpoint: {checkpoint_path}")
    data = torch.load(checkpoint_path, weights_only=False, map_location='cpu')
    
    config = data['config']
    kernel = GladiusKernel(config)
    kernel.load_state_dict(data['model_state_dict'])
    kernel.eval()
    
    # Load tokenizer (BPE 16K)
    from tokenizers import Tokenizer
    tokenizer_path = os.path.join(os.path.dirname(checkpoint_path), '..', 'runs', 'bpe_tokenizer_16k.json')
    if not os.path.exists(tokenizer_path):
        # Try alternate locations
        for p in [
            os.path.join(GLADIUS_V2, '..', 'runs', 'bpe_tokenizer_16k.json'),
            os.path.join(GLADIUS_V2, 'tests', 'bpe_tokenizer_16k.json'),
        ]:
            if os.path.exists(p):
                tokenizer_path = p
                break
    
    tokenizer = Tokenizer.from_file(tokenizer_path)
    
    total_params = sum(p.numel() for p in kernel.parameters())
    print(f"[gladius-serve] Model loaded: {total_params:,} params")
    print(f"[gladius-serve] Config: {config.hidden_dim}d, {config.num_layers}L, {config.num_heads}H")
    print(f"[gladius-serve] Tokenizer: {tokenizer.get_vocab_size()} tokens")
    return kernel


def generate(prompt: str, max_tokens: int = 200, temperature: float = 0.8, 
             top_k: int = 50, repetition_penalty: float = 1.2) -> str:
    """Generate text from prompt."""
    global kernel, tokenizer
    
    encoded = tokenizer.encode(prompt)
    tokens = torch.tensor(encoded.ids, dtype=torch.long)
    
    kernel.eval()
    generated = []
    
    with torch.no_grad():
        for _ in range(max_tokens):
            inp = tokens.unsqueeze(0)
            if inp.shape[1] > 256:
                inp = inp[:, -256:]
            
            result = kernel(inp, timestamp=time.time())
            logits = result['logits'][0, -1, :]
            
            # Repetition penalty
            if generated and repetition_penalty != 1.0:
                for prev_token in set(generated[-50:]):
                    logits[prev_token] /= repetition_penalty
            
            # Temperature
            if temperature > 0:
                logits = logits / temperature
                # Top-k
                if top_k > 0:
                    topk_vals, topk_idx = torch.topk(logits, min(top_k, logits.size(-1)))
                    logits = torch.full_like(logits, float('-inf'))
                    logits.scatter_(0, topk_idx, topk_vals)
                probs = torch.softmax(logits, dim=-1)
                next_token = torch.multinomial(probs, 1).item()
            else:
                next_token = logits.argmax().item()
            
            generated.append(next_token)
            tokens = torch.cat([tokens, torch.tensor([next_token])])
            
            # Stop on EOS or newline spam
            decoded_so_far = tokenizer.decode(generated)
            if '\n\n\n' in decoded_so_far:
                break
    
    return tokenizer.decode(generated)


class GladiusHandler(BaseHTTPRequestHandler):
    """OpenAI-compatible API handler."""
    
    def log_message(self, format, *args):
        print(f"[gladius-serve] {args[0]}")
    
    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)
    
    def do_GET(self):
        if self.path == '/v1/models' or self.path == '/api/tags':
            self._send_json({
                "models": [{"id": MODEL_NAME, "object": "model", "owned_by": "artifact-virtual"}],
                "object": "list"
            })
        elif self.path == '/health':
            self._send_json({"status": "ok", "model": MODEL_NAME})
        else:
            self._send_json({"error": "not found"}, 404)
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length)) if content_length else {}
        
        if self.path == '/v1/chat/completions':
            self._handle_chat(body)
        elif self.path == '/api/generate':
            self._handle_ollama(body)
        else:
            self._send_json({"error": "not found"}, 404)
    
    def _handle_chat(self, body):
        """OpenAI-compatible chat completions."""
        messages = body.get('messages', [])
        prompt = "\n".join(f"{m['role']}: {m['content']}" for m in messages)
        prompt += "\nassistant:"
        
        max_tokens = body.get('max_tokens', 200)
        temperature = body.get('temperature', 0.8)
        
        t0 = time.time()
        text = generate(prompt, max_tokens=max_tokens, temperature=temperature)
        elapsed = time.time() - t0
        
        self._send_json({
            "id": f"gladius-{int(time.time())}",
            "object": "chat.completion",
            "model": MODEL_NAME,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": len(tokenizer.encode(prompt).ids),
                "completion_tokens": len(tokenizer.encode(text).ids),
                "total_tokens": 0
            },
            "_gladius": {"elapsed_s": round(elapsed, 3)}
        })
    
    def _handle_ollama(self, body):
        """Ollama-compatible generate."""
        prompt = body.get('prompt', '')
        max_tokens = body.get('num_predict', 200)
        temperature = body.get('temperature', 0.8)
        
        text = generate(prompt, max_tokens=max_tokens, temperature=temperature)
        
        self._send_json({
            "model": MODEL_NAME,
            "response": text,
            "done": True
        })


def main():
    parser = argparse.ArgumentParser(description='GLADIUS inference server')
    parser.add_argument('checkpoint', help='Path to .pt checkpoint')
    parser.add_argument('--port', type=int, default=8741, help='Port (default: 8741)')
    parser.add_argument('--host', default='127.0.0.1', help='Host (default: localhost)')
    args = parser.parse_args()
    
    load_model(args.checkpoint)
    
    server = HTTPServer((args.host, args.port), GladiusHandler)
    print(f"[gladius-serve] Listening on {args.host}:{args.port}")
    print(f"[gladius-serve] OpenAI endpoint: http://{args.host}:{args.port}/v1/chat/completions")
    print(f"[gladius-serve] Ollama endpoint: http://{args.host}:{args.port}/api/generate")
    print(f"[gladius-serve] Health check:    http://{args.host}:{args.port}/health")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[gladius-serve] Shutting down")
        server.shutdown()


if __name__ == '__main__':
    main()
