<div align="center">

# Symbiote Documentation

**Persistent AI agent runtime · v5.6.2**

[Quick Start](getting-started/quick-start.md) · [Configuration](getting-started/configuration.md) · [CLI](reference/cli.md) · [Tools](tools/built-in.md)

</div>

---

## Guides

- [Quick Start](getting-started/quick-start.md)
- [Configuration](getting-started/configuration.md)
- [Setup Flow](getting-started/wizard.md)
- [Web Control Room](channels/webchat.md)
- [Boot Sequence](core/boot-sequence.md)
- [COMB and VDB Memory](core/comb.md)
- [Memograph Integration](core/memograph.md)
- [Built-in Tools](tools/built-in.md)
- [Provider Overview](providers/overview.md)
- [Cloud Integrations](cloud-integrations.md)
- [Self-hosting n8n for Symbiote](n8n-self-hosting.md)
- [Google Workspace](google-workspace.md)
- [Production Deployment and Installers](advanced/production.md)
- [CLI Reference](reference/cli.md)
- [Environment Variables](reference/environment.md)
- [Documentation Map](SUMMARY.md)

## Runtime Notes

Symbiote separates warm continuity from explicit cold-memory promotion. Session turns, truncation absorption, identity files, skills, and recent daily notes are searchable in the workspace VDB; identity/skill catalogs are synchronized so edits and removals do not accumulate as stale copies. `memory_offload` writes a deliberate distilled note to `.symbiote/memory.jsonl`, a Memograph-compatible LIVE graph snapshot, and the VDB. Ops Memory separately retains bounded, expiring metadata about completed tool outcomes without command arguments or result bodies.

VDB retrieval uses BM25 and sparse TF-IDF; it is not a dense neural embedding backend. Memograph snapshots can be imported as separate LIVE, PROJECT, and ENTERPRISE records, with shard permissions and topology retained for context assembly. See [COMB and VDB Memory](core/comb.md) and [Memograph Integration](core/memograph.md) for the actual data flow and its limits.

Provider and channel availability depends on configuration and credentials. Tool counts vary by runtime; use the CLI `/tools` command or MCP `tools/list` for the active set.

## License

Symbiote is MIT licensed. See the repository [LICENSE](../LICENSE).
