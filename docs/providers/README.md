# Provider Abstraction

This directory documents the normalized provider layer used by the runtime.

- `overview.md` — the provider contract, message model, and adapter policy
- `provider_abstraction.h` — the C header for the internal provider interface

Use this abstraction when adding new backends so the engine stays provider-agnostic.
