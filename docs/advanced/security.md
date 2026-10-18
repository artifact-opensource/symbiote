# Security and trust

Symbiote's tool sandbox classifies each agent session as `admin`, `standard`, or `restricted`. It wraps tool execution; it does not run the gateway or tools in an OS-level container. In particular, `exec` inherits the operating-system permissions of the Node.js process.

## Sandbox configuration

The default configuration disables tier restrictions for trusted internal sessions while retaining owner verification and restricted access for external non-owners:

```jsonc
{
  "ownerIds": ["your-platform-user-id"],
  "sandbox": {
    "enabled": false,
    "ownerAccess": true,
    "internalTier": "standard",
    "nonOwnerTier": "restricted"
  }
}
```

- Verified owners are `admin` when `ownerAccess` is enabled. Other channel users receive `nonOwnerTier`.
- With `enabled: true`, internal sessions use `internalTier`; sub-agents inherit the parent's tier. An admin parent can confer admin access to its own sub-agents when `ownerAccess` is enabled.
- With `enabled: false`, internal sessions are `admin` when `ownerAccess` is enabled; external non-owners remain at `nonOwnerTier`. Treat internal admin access as full host access for agent tool calls, not as a harmless convenience setting.
- `standard` and `restricted` are policy tiers, not OS accounts or containers. The exact tool restrictions are enforced in the sandbox rules.

The Control Room's local operator is trusted only when the gateway verifies a same-origin loopback request. LAN access requires the web access token; a request body cannot grant itself trusted-admin status. The Electron app connects to the local Control Room and does not bypass its access checks.

## Channel access

Discord and WhatsApp policies determine who can contact the bot and where it responds. Owner IDs are distinct from channel allowlists: an allowlisted sender is not necessarily an owner. Configure channel policies and owner IDs in [Configuration](../getting-started/configuration.md).

## HTTP access

The API on `apiPort` (default `3006`) requires a bearer token configured through `SYMBIOTE_API_KEY`; `/api/v1/health` is public. The Control Room on `webPort` (default `3009`) is a separate service: loopback use does not require a token, while remote/LAN control requires a web access token. Do not expose either service to an untrusted network.

## Input and secrets

Tool outputs are sanitized before they are appended to agent context, but sanitization is defense in depth—not a guarantee that untrusted content is safe to follow. Treat web pages, files, and user-provided instructions as untrusted data.

Keep provider and channel credentials in `.env` or a secret manager, not in source control. Configuration values support `${ENV_VAR}` interpolation. Protect the Control Room access token and API key as credentials.

## Operational recommendations

1. Run Symbiote under a dedicated OS account with only the host permissions it needs.
2. Restrict the configured workspace and tool permissions; do not assume the sandbox is an OS filesystem boundary.
3. Keep owner IDs and channel allowlists explicit, and prefer `nonOwnerTier: "restricted"` for shared or remote access.
4. Leave the sandbox enabled unless every reachable user and agent is intended to have admin-tier tool access.
5. Review automation prompts and scheduled jobs before enabling them; they can take actions allowed by their session tier and tools.
6. Keep credentials private, monitor logs, and keep Node.js and dependencies current.
