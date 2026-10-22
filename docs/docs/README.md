# Introduction

## Symbiote Documentation

**Persistent AI agent runtime · v5.5.0**

[Quick Start](getting-started/quick-start.md) · [Configuration](getting-started/configuration.md) · [CLI](reference/cli.md) · [Tools](tools/built-in.md)

***

### Guides

* [Quick Start](getting-started/quick-start.md)
* [Configuration](getting-started/configuration.md)
* [Setup Flow](getting-started/wizard.md)
* [Web Control Room](channels/webchat.md)
* [Boot Sequence](core-concepts/boot-sequence.md)
* [COMB and VDB Memory](core-concepts/comb.md)
* [Memograph Integration](core-concepts/memograph.md)
* [Built-in Tools](tools/built-in.md)
* [Provider Overview](providers/overview.md)
* [Cloud Integrations](integrations/cloud-integrations.md)
* [Self-hosting n8n for Symbiote](../n8n-self-hosting.md)
* [Google Workspace](integrations/google-workspace.md)
* [Production Deployment and Installers](advanced/production.md)
* [CLI Reference](reference/cli.md)
* [Environment Variables](reference/environment.md)
* [Documentation Map](../SUMMARY.md)

### Runtime Notes

Symbiote includes an embedded workspace VDB using BM25 and sparse TF-IDF retrieval. Memograph snapshots can be imported as separate LIVE, PROJECT, and ENTERPRISE memory records; shard permissions and topology metadata are retained for context assembly. Dense embedding generation is not included by default.

Provider and channel availability depends on configuration and credentials. Tool counts vary by runtime; use the CLI `/tools` command or MCP `tools/list` for the active set.

### License

Symbiote is MIT licensed. See the repository [LICENSE](../../LICENSE/).
