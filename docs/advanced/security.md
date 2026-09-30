# Security

Symbiote implements defense-in-depth across every layer.

## Input Sanitization

All tool results are sanitized before being injected back into the LLM context. This prevents prompt injection attacks where a malicious file or web page attempts to hijack the agent:

- Tool output is scanned for injection patterns
- Suspicious content is logged and flagged
- The sanitizer strips known prompt injection templates

## Channel Policies

Access control is enforced at the router level before messages reach the agent:

- **Allowlists** restrict who can interact with the bot
- **Group policies** control behavior in shared channels
- **Owner IDs** define users with elevated access
- Messages from unknown senders are silently dropped

See [Configuration → Channel Policies](../getting-started/configuration.md#channel-policies) for setup.

## Tool Sandboxing

Each session gets its own sandboxed tool registry:

- Tools can be allowed or denied per-session
- Resource budgets prevent runaway tool usage
- File system operations are scoped to the configured workspace
- The `exec` tool inherits the daemon's OS user permissions

## Sibling Bot Protection

Messages from known sibling bots are handled separately from user messages:

- Cooldown periods prevent echo loops
- Mention-based yield prevents duplicate responses
- Bot-to-bot communication is rate-limited

## API Authentication

The HTTP API requires Bearer token authentication:

```
Authorization: Bearer <MACH6_API_KEY>
```

Requests without a valid token receive `401 Unauthorized`.

## Secrets Management

- API keys and tokens live in `.env`, never in `mach6.json`
- Config values support `${ENV_VAR}` interpolation
- `.env` should be in `.gitignore` (the example file is `.env.example`)

## Boot Validation

Symbiote validates the entire configuration at startup:

- Missing required fields are caught before the agent starts
- Invalid types produce human-readable error messages
- Unreachable providers log warnings (degraded mode, not crash)
- No silent failures — every issue is surfaced during boot

## Recommendations

1. **Run as a dedicated user** — don't run Symbiote as root
2. **Restrict workspace scope** — set `workspace` to a specific directory, not `/`
3. **Use allowlists** — `dmPolicy: "allowlist"` is the default for a reason
4. **Set resource budgets** — limit `exec` and `web_fetch` calls per day
5. **Monitor logs** — injection attempts are logged with full context
6. **Keep Node.js updated** — Symbiote pins `undici >=6.23.0` to address known CVEs
